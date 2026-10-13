import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type TransactionInstruction, type VersionedTransactionResponse } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { launchConfig } from '@argon/core';
import { pumpSdk } from '../src/sdk.js';
import { decodePumpIx, PUMP_PROGRAM_ID } from '../src/programs.js';
import { decodeTxEvents } from '../src/events.js';
import type { Db } from '../src/db.js';
import { LedgerError, TradeNotAllowedError } from '../src/errors.js';
import { FakeChain, type Effect } from './helpers/fakeChain.js';
import { encodeAccount, eventCpiData, eventLogs } from './helpers/events.js';
import { makeClient, testDb, testEnv, testKeys, type TestKeys } from './helpers/env.js';
import { fixtureGlobal } from './fixtures/pump.js';

const { GLOBAL_PDA, bondingCurvePda, feeSharingConfigPda } = pumpSdk;

describe('native split receipt from the on-chain DistributeCreatorFeesEvent', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  async function seed(keys: TestKeys, chain: FakeChain, legs: [PublicKey, number, bigint][], launcher: PublicKey, launchId: string) {
    const client = makeClient({ env: testEnv(keys), rpc: chain.rpc(), db });
    await client.createLaunchWallet(launchId);
    const mint = new PublicKey((await db.query(`SELECT mint FROM sol_launches WHERE launch_id=$1`, [launchId])).rows[0]!.mint);
    await db.query(`UPDATE sol_launches SET state='confirmed', launcher_wallet=$2 WHERE launch_id=$1`, [launchId, launcher.toBase58()]);
    const vault = Keypair.generate().publicKey;
    const total = legs.reduce((s, l) => s + l[2], 0n);
    const keysList = [keys.crank.publicKey, ...legs.map((l) => l[0]), vault];
    const pre = [1_000_000_000n, ...legs.map(() => 10n), total + 890_880n];
    const post = [999_995_000n, ...legs.map((l) => 10n + l[2]), 890_880n];
    const sig = chain.synthetic(
      keysList,
      {
        logs: eventLogs(PUMP_PROGRAM_ID, 'pump', 'distributeCreatorFeesEvent', {
          mint,
          sharingConfig: feeSharingConfigPda(mint),
          admin: launcher,
          shareholders: legs.map(([address, shareBps]) => ({ address, shareBps })),
          distributed: new BN(total.toString()),
          quoteMint: PublicKey.default,
        }),
      },
      { pre, post },
    );
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, lamports) VALUES ($1,$2,'native','confirmed',$3,$4)`, [`c-${launchId}`, launchId, sig, total.toString()]);
    return { client, sig, claimId: `c-${launchId}` };
  }

  it('records the real per-leg lamports and the distribution signature for every leg', async () => {
    const keys = testKeys();
    const chain = new FakeChain();
    const launcher = Keypair.generate().publicKey;
    // uneven on purpose: the receipt reports what the chain moved, not 50/30/20 of the total
    const legs: [PublicKey, number, bigint][] = [
      [launcher, 5000, 500_001n],
      [keys.buyback.publicKey, 3000, 300_000n],
      [keys.treasury.publicKey, 2000, 199_999n],
    ];
    const { client, sig, claimId } = await seed(keys, chain, legs, launcher, 'N1');
    const r = await client.runSplit('N1', claimId);
    expect(r.totalLamports).toBe('1000000');
    expect(r.legs).toEqual([
      { to: 'launcher', address: launcher.toBase58(), lamports: '500001', txSig: sig, status: 'confirmed' },
      { to: 'argon-buyback', address: keys.buyback.publicKey.toBase58(), lamports: '300000', txSig: sig, status: 'confirmed' },
      { to: 'treasury', address: keys.treasury.publicKey.toBase58(), lamports: '199999', txSig: sig, status: 'confirmed' },
    ]);
    expect(chain.sends).toBe(0); // native: Argon moved nothing itself
    expect(await client.runSplit('N1', claimId)).toEqual(r);
  });

  it('refuses a distribution that pays a wallet outside the Argon legs (e.g. after an admin CTO)', async () => {
    const keys = testKeys();
    const chain = new FakeChain();
    const launcher = Keypair.generate().publicKey;
    const { client, claimId } = await seed(keys, chain, [[Keypair.generate().publicKey, 10000, 1000n]], launcher, 'N2');
    await expect(client.runSplit('N2', claimId)).rejects.toThrow(/not an Argon split leg/);
  });

  it('decodes emit_cpi events from inner instructions too', () => {
    const chain = new FakeChain();
    const mint = Keypair.generate().publicKey;
    const sig = chain.synthetic([Keypair.generate().publicKey, PUMP_PROGRAM_ID], {});
    const landed = chain.landed.get(sig)!;
    const programIdIndex = landed.keys.findIndex((k) => k.equals(PUMP_PROGRAM_ID));
    landed.effect.innerInstructions = [{ index: 0, instructions: [{ programIdIndex, accounts: [], data: eventCpiData('pump', 'distributeCreatorFeesEvent', { mint, distributed: new BN(42) }) }] }];
    const tx = { transaction: { message: landed.tx.message }, meta: { innerInstructions: landed.effect.innerInstructions, logMessages: [], loadedAddresses: { writable: [], readonly: [] } } } as unknown as VersionedTransactionResponse;
    const evs = decodeTxEvents(tx);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.name).toBe('distributeCreatorFeesEvent');
    expect((evs[0]!.data['distributed'] as BN).toNumber()).toBe(42);
  });
});

describe('$ARGON buyback', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  const LEG = 50_000_000n; // 0.05 SOL buyback leg
  let n = 0;

  async function setup(shape: 'ring' | 'chain', legState = 'confirmed') {
    const keys = testKeys();
    const chain = new FakeChain();
    const curveCreator = Keypair.generate().publicKey;
    chain.accounts.set(GLOBAL_PDA.toBase58(), { data: await encodeAccount('pump', 'global', fixtureGlobal() as never), owner: PUMP_PROGRAM_ID, lamports: 1, executable: false });
    const g = fixtureGlobal();
    chain.accounts.set(bondingCurvePda(keys.argonMint.publicKey).toBase58(), {
      data: await encodeAccount('pump', 'bondingCurve', {
        virtualTokenReserves: g.initialVirtualTokenReserves,
        virtualSolReserves: g.initialVirtualSolReserves,
        realTokenReserves: g.initialRealTokenReserves,
        realSolReserves: new BN(0),
        tokenTotalSupply: g.tokenTotalSupply,
        complete: false,
        creator: curveCreator,
      }),
      owner: PUMP_PROGRAM_ID,
      lamports: 1,
      executable: false,
    });
    chain.accounts.set(keys.argonMint.publicKey.toBase58(), { data: Buffer.alloc(82), owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false });
    const buys: TransactionInstruction[] = [];
    chain.onTx = (_tx, ixs): Effect | void => {
      const buy = ixs.find((ix) => decodePumpIx(ix)?.name === 'buy');
      if (!buy) return;
      buys.push(buy);
      const max = BigInt(String(decodePumpIx(buy)!.data['maxSolCost']));
      return {
        logs: eventLogs(PUMP_PROGRAM_ID, 'pump', 'tradeEvent', {
          mint: keys.argonMint.publicKey,
          isBuy: true,
          user: keys.buyback.publicKey,
          solAmount: new BN((max - 200_000n).toString()),
          fee: new BN(95_000),
          creatorFee: new BN(30_000),
        }),
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: keys.argonMint.publicKey.toBase58(), owner: keys.buyback.publicKey.toBase58(), amount: 351_234_567n }],
      };
    };
    const config = launchConfig('Ar-36', shape);
    const client = makeClient({ env: testEnv(keys), rpc: chain.rpc(), db, config });
    const launchId = `B${++n}`;
    await client.createLaunchWallet(launchId);
    await db.query(`UPDATE sol_launches SET state='confirmed', launcher_wallet=$2 WHERE launch_id=$1`, [launchId, Keypair.generate().publicKey.toBase58()]);
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, lamports) VALUES ($1,$2,'native','confirmed','fixture',$3)`, [`c${n}`, launchId, (LEG * 10n / 3n).toString()]);
    await db.query(`INSERT INTO sol_splits (split_id, claim_id, launch_id, mode, total) VALUES ($1,$2,$3,'native',$4)`, [`s${n}`, `c${n}`, launchId, '0']);
    await db.query(`INSERT INTO split_ledger (claim_id, leg, launch_id, address, lamports, state, tx_sig) VALUES ($1,'argon-buyback',$2,$3,$4,$5,'fixture')`, [`c${n}`, launchId, keys.buyback.publicKey.toBase58(), LEG.toString(), legState]);
    return { keys, chain, client, splitId: `s${n}`, buys, config };
  }

  it('buys $ARGON on the curve, capped by buybackSolPerTick, with amounts read from the chain', async () => {
    const { client, splitId, buys, keys, config } = await setup('ring');
    const r = await client.buyArgon(LEG, splitId); // asks for the whole leg
    const cap = BigInt(Math.round(config.buybackSolPerTick * 1e9)); // ring Ar-36: 0.01 SOL
    expect(buys).toHaveLength(1);
    const d = decodePumpIx(buys[0]!)!;
    expect(d.account('mint').equals(keys.argonMint.publicKey)).toBe(true);
    expect(d.account('user').equals(keys.buyback.publicKey)).toBe(true);
    expect(BigInt(String(d.data['maxSolCost']))).toBe(cap);
    expect(r.argonOut).toBe(351_234_567n);
    expect(r.event).toEqual({
      kind: 'buyback.executed',
      payload: { lamportsIn: (cap - 200_000n + 125_000n).toString(), argonOut: '351234567', txSig: r.txSig, funding: 'fee-split', splitId },
    });
  });

  it('is idempotent per splitId, including across a crash after broadcast', async () => {
    const { client, splitId, chain, buys } = await setup('ring');
    chain.faults.throwAfterSend = 1;
    await expect(client.buyArgon(LEG, splitId)).rejects.toThrow(/killed after send/);
    const a = await client.buyArgon(LEG, splitId);
    const b = await client.buyArgon(1n, splitId); // a different amount cannot start a second buy
    expect(b.txSig).toBe(a.txSig);
    expect(buys).toHaveLength(1);
    expect(chain.landed.size).toBe(1);
  });

  it('refuses when the shape has no buyback budget or the buyback leg is not confirmed', async () => {
    const chainShape = await setup('chain'); // buybackSolPerTick 0
    await expect(chainShape.client.buyArgon(LEG, chainShape.splitId)).rejects.toBeInstanceOf(TradeNotAllowedError);
    const pendingLeg = await setup('ring', 'pending');
    await expect(pendingLeg.client.buyArgon(LEG, pendingLeg.splitId)).rejects.toBeInstanceOf(LedgerError);
    await expect(pendingLeg.client.buyArgon(LEG, 'no-such-split')).rejects.toThrow(/not found/);
    expect(chainShape.chain.sends + pendingLeg.chain.sends).toBe(0);
  });
});
