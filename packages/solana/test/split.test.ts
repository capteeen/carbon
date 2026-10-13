import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ArgonChainClient } from '../src/client.js';
import type { Db } from '../src/db.js';
import { FakeChain } from './helpers/fakeChain.js';
import { makeClient, testDb, testEnv, testKeys, type TestKeys } from './helpers/env.js';

const TOTAL = 1_234_567_891n; // odd on purpose: floors + remainder

describe('wallet-mode split ledger (real Postgres)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let keys: TestKeys;
  let env: Record<string, string | undefined>;
  let chain: FakeChain;
  let launcher: PublicKey;
  let n = 0;

  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  beforeEach(() => {
    keys = testKeys();
    env = testEnv(keys, { ARGON_FEE_MODE: 'wallet' });
    chain = new FakeChain();
    launcher = Keypair.generate().publicKey;
  });

  async function seed(client: ArgonChainClient): Promise<{ launchId: string; claimId: string; creator: PublicKey }> {
    const launchId = `L-split-${++n}`;
    const { address } = await client.createLaunchWallet(launchId);
    const creator = new PublicKey(address);
    chain.fund(creator, TOTAL + 5_000_000n); // claimed fees + rent the wallet keeps
    chain.fund(keys.crank.publicKey, 1_000_000_000n);
    await db.query(`UPDATE sol_launches SET state='confirmed', launcher_wallet=$2 WHERE launch_id=$1`, [launchId, launcher.toBase58()]);
    const claimId = `claim-${n}`;
    // Fixture: a confirmed claim of TOTAL lamports (the claim path itself is covered elsewhere).
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, lamports) VALUES ($1,$2,'wallet','confirmed','fixture',$3)`, [claimId, launchId, TOTAL.toString()]);
    return { launchId, claimId, creator };
  }

  function expectPaidExactlyOnce(): void {
    const expected = ArgonChainClient.splitAmounts(TOTAL);
    const byTo = (addr: PublicKey) => chain.transfers.filter((t) => t.to === addr.toBase58());
    for (const [addr, amount] of [
      [launcher, expected.launcher],
      [keys.buyback.publicKey, expected['argon-buyback']],
      [keys.treasury.publicKey, expected.treasury],
    ] as const) {
      const paid = byTo(addr);
      expect(paid.length).toBe(1);
      expect(paid[0]!.lamports).toBe(amount);
    }
    expect(chain.transfers.length).toBe(3);
    expect(expected.launcher + expected['argon-buyback'] + expected.treasury).toBe(TOTAL);
  }

  it('splits 50/30/20 with floors, remainder to treasury, and returns a receipt matching the chain', async () => {
    const client = makeClient({ env, rpc: chain.rpc(), db });
    const { launchId, claimId } = await seed(client);
    const r = await client.runSplit(launchId, claimId);
    expectPaidExactlyOnce();
    expect(r.totalLamports).toBe(TOTAL.toString());
    expect(r.legs.map((l) => l.to)).toEqual(['launcher', 'argon-buyback', 'treasury']);
    expect(r.legs.map((l) => l.lamports)).toEqual(['617283945', '370370367', '246913579']);
    for (const l of r.legs) {
      expect(l.status).toBe('confirmed');
      expect(chain.landed.has(l.txSig!)).toBe(true);
    }
    // idempotent re-run: no new transfer, same receipt
    const again = await client.runSplit(launchId, claimId);
    expect(again.legs).toEqual(r.legs);
    expect(chain.transfers.length).toBe(3);
  });

  it('kill before broadcast (signature recorded, never sent) then resume: each leg paid exactly once', async () => {
    const c1 = makeClient({ env, rpc: chain.rpc(), db });
    const { launchId, claimId } = await seed(c1);
    chain.faults.throwBeforeSend = 1;
    await c1.runSplit(launchId, claimId).catch(() => undefined);
    // also kill the second leg on the next attempt
    const c2 = makeClient({ env, rpc: chain.rpc(), db });
    const r = await c2.runSplit(launchId, claimId);
    expectPaidExactlyOnce();
    expect(r.legs.every((l) => l.status === 'confirmed')).toBe(true);
  });

  it('kill after broadcast (landed, not recorded as confirmed) then resume: no second payment', async () => {
    const c1 = makeClient({ env, rpc: chain.rpc(), db });
    const { launchId, claimId } = await seed(c1);
    // first leg lands, process dies; then die again while confirming the second leg
    chain.faults.throwAfterSend = 1;
    await expect(c1.runSplit(launchId, claimId)).rejects.toThrow(/killed after send/);
    const mid = await db.query(`SELECT leg, state FROM split_ledger WHERE claim_id=$1 ORDER BY leg`, [claimId]);
    expect(mid.rows.find((r) => r.leg === 'launcher')!.state).toBe('sent');
    chain.faults.statusThrows = 1;
    const c2 = makeClient({ env, rpc: chain.rpc(), db });
    await expect(c2.runSplit(launchId, claimId)).rejects.toThrow();
    const c3 = makeClient({ env, rpc: chain.rpc(), db });
    await c3.runSplit(launchId, claimId);
    expectPaidExactlyOnce();
  });

  it('dropped transaction whose blockhash expires is rebuilt and paid once', async () => {
    const c1 = makeClient({ env, rpc: chain.rpc(), db });
    const { launchId, claimId } = await seed(c1);
    chain.faults.dropSends = 100; // nothing lands, rebroadcasts dropped too
    await expect(c1.runSplit(launchId, claimId)).rejects.toThrow(/not final yet/);
    expect(chain.transfers.length).toBe(0);
    chain.faults.dropSends = 0;
    chain.expireAll();
    const r = await makeClient({ env, rpc: chain.rpc(), db }).runSplit(launchId, claimId);
    expectPaidExactlyOnce();
    const attempts = await db.query(`SELECT attempts FROM split_ledger WHERE claim_id=$1 AND leg='launcher'`, [claimId]);
    expect(attempts.rows[0]!.attempts).toBe(2);
    expect(r.legs[0]!.status).toBe('confirmed');
  });

  it('two workers running the same split concurrently still pay each leg once', async () => {
    const a = makeClient({ env, rpc: chain.rpc(), db });
    const b = makeClient({ env, rpc: chain.rpc(), db });
    const { launchId, claimId } = await seed(a);
    const [ra, rb] = await Promise.all([a.runSplit(launchId, claimId), b.runSplit(launchId, claimId)]);
    expectPaidExactlyOnce();
    expect(ra.legs).toEqual(rb.legs);
  });

  it('refuses to split an unconfirmed claim or another launch’s claim', async () => {
    const client = makeClient({ env, rpc: chain.rpc(), db });
    const { launchId, claimId } = await seed(client);
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state) VALUES ('open-claim',$1,'wallet','pending')`, [launchId]);
    await expect(client.runSplit(launchId, 'open-claim')).rejects.toThrow(/not confirmed/);
    const other = await seed(client);
    await expect(client.runSplit(other.launchId, claimId)).rejects.toThrow(/not found for launch/);
    expect(chain.transfers.length).toBe(0);
  });
});
