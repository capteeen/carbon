/**
 * SPEC §2/§7: "Kill the fee split mid-run and resume: no double payment; receipts
 * match the chain." Same for buybacks and airdrops.
 *
 * Real @carbon/agents Treasurer + real @carbon/solana CarbonChainClient on the
 * solana package's test-double chain (FakeChain: it deserializes and applies the
 * real signed transactions), real core bus/approvals/budgets in Postgres.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import pg from 'pg';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchConfig, type CarbonEvent, type ChainClient, type Core, type LaunchConfig, type SplitReceipt } from '@carbon/core';
import { Treasurer, MoleculeRunner, type AgentContext } from '@carbon/agents';
import { CarbonChainClient, loadSolanaConfig } from '@carbon/solana';
import { Supervisor } from '../../apps/worker/src/supervisor.js';
import { FakeChain, type Effect } from '../../packages/solana/test/helpers/fakeChain.js';
import { encodeAccount, eventLogs } from '../../packages/solana/test/helpers/events.js';
import { fixtureGlobal } from '../../packages/solana/test/fixtures/pump.js';
import { PUMP_PROGRAM_ID, decodePumpIx } from '../../packages/solana/src/programs.js';
import { pumpSdk } from '../../packages/solana/src/sdk.js';
import { createLaunch, makeEnv, wallet, type Env } from './support/env.js';

const FAST = { pollMs: 0, maxPolls: 3, rebroadcastEvery: 1 };

function keys() {
  return { crank: Keypair.generate(), buyback: Keypair.generate(), treasury: Keypair.generate(), carbonMint: Keypair.generate() };
}
type Keys = ReturnType<typeof keys>;
function solEnv(k: Keys, extra: Record<string, string> = {}) {
  return {
    CARBON_VAULT_KEY: randomBytes(32).toString('hex'),
    CARBON_BUYBACK_WALLET: k.buyback.publicKey.toBase58(),
    CARBON_TREASURY_WALLET: k.treasury.publicKey.toBase58(),
    CARBON_CRANK_KEY: bs58.encode(k.crank.secretKey),
    CARBON_BUYBACK_KEY: bs58.encode(k.buyback.secretKey),
    CARBON_MINT: k.carbonMint.publicKey.toBase58(),
    PINATA_JWT: 'test-jwt-not-a-secret',
    ...extra,
  } as Record<string, string>;
}

function client(env: Env, chain: FakeChain, e: Record<string, string>, cfg: LaunchConfig = launchConfig('C-12', 'ring'), db: pg.Pool = env.core.bus.pool) {
  return new CarbonChainClient({ config: loadSolanaConfig(e), rpc: chain.rpc(), db, env: e, poll: FAST, launchConfig: async () => cfg });
}

function agentCtx(env: Env, core: Core, launchId: string, chain: ChainClient, config: LaunchConfig): AgentContext {
  return { bus: core.bus, handoffs: core.handoffs, approvals: core.approvals, budgets: core.budgets, llm: {} as never, x: {} as never, chain, config, launchId, now: env.clock.now, assets: { put: async () => ({ uri: 'u' }) } };
}

async function deployedLaunch(env: Env, shape: 'ring' | 'chain' = 'ring', isotope: 'C-12' | 'C-14' = 'C-12') {
  const w = wallet();
  const launchId = await createLaunch(env.core, shape, isotope, null, w.address);
  return { launchId, w };
}

describe('fee split: kill mid-run, resume through Treasurer (wallet mode, durable ledger)', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  const TOTAL = 987_654_321n;

  async function seed(faults: FakeChain['faults']) {
    const k = keys();
    const chain = new FakeChain();
    const e = solEnv(k, { CARBON_FEE_MODE: 'wallet' });
    const c = client(env, chain, e);
    const { launchId } = await deployedLaunch(env);
    const launcher = Keypair.generate().publicKey;
    const { address } = await c.createLaunchWallet(launchId);
    chain.fund(new PublicKey(address), TOTAL + 2_000_000n);
    chain.fund(k.crank.publicKey, 1_000_000_000n);
    await env.core.bus.pool.query(`UPDATE sol_launches SET state='confirmed', launcher_wallet=$2 WHERE launch_id=$1`, [launchId, launcher.toBase58()]);
    const claimId = randomUUID();
    // A confirmed claim (claim building itself is covered by @carbon/solana's tests), and its public event.
    await env.core.bus.pool.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, lamports) VALUES ($1,$2,'wallet','confirmed','fixture-claim',$3)`, [claimId, launchId, TOTAL.toString()]);
    await env.core.bus.append({ launchId, kind: 'launch.deployed', actor: 'treasurer', payload: { ca: Keypair.generate().publicKey.toBase58(), txSig: 's', creatorWallet: address, devBuySol: 0.25, network: 'devnet' } });
    await env.core.bus.append({ launchId, kind: 'fee.claimed', actor: 'treasurer', payload: { claimId, lamports: TOTAL.toString(), txSig: 'fixture-claim' } });
    Object.assign(chain.faults, faults);
    return { k, chain, e, launchId, launcher, claimId };
  }

  async function verify(s: Awaited<ReturnType<typeof seed>>) {
    const expected = CarbonChainClient.splitAmounts(TOTAL);
    const paid = (to: PublicKey) => s.chain.transfers.filter((t) => t.to === to.toBase58());
    for (const [to, amt] of [[s.launcher, expected.launcher], [s.k.buyback.publicKey, expected['carbon-buyback']], [s.k.treasury.publicKey, expected.treasury]] as const) {
      expect(paid(to)).toHaveLength(1);
      expect(paid(to)[0]!.lamports).toBe(amt);
    }
    expect(s.chain.transfers).toHaveLength(3);
    const receipts = (await env.core.bus.list(s.launchId, { kinds: ['split.receipt'] })) as CarbonEvent<'split.receipt'>[];
    const final = receipts[receipts.length - 1]!.payload;
    // Receipt == chain: each leg's txSig landed and moved exactly that many lamports to that address.
    for (const leg of final.legs) {
      expect(leg.status).toBe('confirmed');
      const t = s.chain.transfers.find((x) => x.sig === leg.txSig);
      expect(t, `leg ${leg.to} txSig is on chain`).toBeTruthy();
      expect(t!.to).toBe(leg.address);
      expect(t!.lamports.toString()).toBe(leg.lamports);
    }
    expect(BigInt(final.totalLamports)).toBe(TOTAL);
    // No two receipts for the same split claim to be fully confirmed with different numbers.
    const confirmed = receipts.filter((r) => r.payload.legs.every((l) => l.status === 'confirmed'));
    expect(new Set(confirmed.map((r) => JSON.stringify(r.payload.legs))).size).toBe(1);
  }

  for (const [name, faults] of [
    ['killed before broadcast', { throwBeforeSend: 1 }],
    ['killed after broadcast (landed, not recorded)', { throwAfterSend: 1 }],
    ['killed while confirming', { statusThrows: 1 }],
    ['killed after broadcast twice in a row', { throwAfterSend: 2 }],
  ] as const) {
    it(`${name}: a fresh Treasurer (new process) resumes, pays each leg once, and the receipt matches the chain`, async () => {
      const s = await seed({ ...faults });
      const t1 = new Treasurer(agentCtx(env, env.core, s.launchId, client(env, s.chain, s.e), launchConfig('C-12', 'ring')));
      await t1.resumeSplits().catch(() => undefined);
      for (let i = 0; i < 3; i++) {
        const t = new Treasurer(agentCtx(env, env.core, s.launchId, client(env, s.chain, s.e), launchConfig('C-12', 'ring')));
        const out = await t.resumeSplits().catch(() => null);
        if (out && out.length === 0) break;
      }
      await verify(s);
    });
  }

  it('two workers resuming the same split at once still pay each leg once', async () => {
    const s = await seed({});
    const core2 = await env.another();
    const a = new Treasurer(agentCtx(env, env.core, s.launchId, client(env, s.chain, s.e), launchConfig('C-12', 'ring')));
    const b = new Treasurer(agentCtx(env, core2, s.launchId, client(env, s.chain, s.e, launchConfig('C-12', 'ring'), core2.bus.pool), launchConfig('C-12', 'ring')));
    await Promise.all([a.resumeSplits(), b.resumeSplits()]);
    await verify(s);
  });
});

describe('fee claim: kill between the on-chain claim and its public event', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  /**
   * Test-double chain with the real client's claim semantics: a claim drains the pending
   * fees on chain; a later claim with nothing pending returns null; runSplit records the
   * split of a known claim. Every lamport movement is in `ledger`.
   */
  class LedgerChain {
    pending = 0n;
    ledger: { kind: string; claimId: string; lamports: bigint; sig: string }[] = [];
    readonly network = 'devnet' as const;
    async claimCreatorFees() {
      if (this.pending === 0n) return null;
      const claimId = randomUUID();
      const sig = `claim-${claimId}`;
      this.ledger.push({ kind: 'claim', claimId, lamports: this.pending, sig });
      const lamports = this.pending;
      this.pending = 0n;
      return { claimId, lamports, txSig: sig };
    }
    /** The chain's durable claim ledger (CarbonChainClient.confirmedClaims: sol_claims rows in state confirmed). */
    async confirmedClaims() {
      return this.ledger.filter((x) => x.kind === 'claim').map((x) => ({ claimId: x.claimId, lamports: x.lamports, txSig: x.sig, origin: 'carbon' as const }));
    }
    async runSplit(_l: string, claimId: string): Promise<SplitReceipt> {
      const c = this.ledger.find((x) => x.kind === 'claim' && x.claimId === claimId);
      if (!c) throw new Error('unknown claim');
      return { splitId: `split_${claimId}`, claimId, totalLamports: c.lamports.toString(), legs: [{ to: 'launcher', address: 'L', lamports: c.lamports.toString(), txSig: c.sig, status: 'confirmed' }], at: 0 };
    }
  }

  // Treasurer.claimAndSplit claims on chain, THEN appends fee.claimed. A crash in between
  // leaves a confirmed claim (money moved: in wallet mode it now sits in Carbon's per-launch
  // wallet) with no fee.claimed event; resumeSplits only walks fee.claimed events and the
  // next claim finds nothing pending, so that claim never gets a split or a public receipt.
  it('[AG-007] every on-chain claim ends up with a fee.claimed event and a split receipt after a crash and restart', async () => {
    const { launchId } = await deployedLaunch(env);
    await env.core.bus.append({ launchId, kind: 'launch.deployed', actor: 'treasurer', payload: { ca: 'Mint', txSig: 's', creatorWallet: 'Fee', devBuySol: 0.25, network: 'devnet' } });
    const chain = new LedgerChain();
    chain.pending = 123_456_789n;
    let crash = true;
    const crashingBus = new Proxy(env.core.bus, {
      get(t, k) {
        if (k === 'append')
          return async (input: { kind: string }) => {
            if (crash && input.kind === 'fee.claimed') {
              crash = false;
              throw new Error('process killed after the claim landed');
            }
            return t.append(input as never);
          };
        const v = (t as never)[k];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const ctx1 = { ...agentCtx(env, env.core, launchId, chain as unknown as ChainClient, launchConfig('C-12', 'ring')), bus: crashingBus };
    await new Treasurer(ctx1).claimAndSplit().catch(() => undefined);
    // restart: a new Treasurer, the scheduled tick's two money steps
    const t2 = new Treasurer(agentCtx(env, env.core, launchId, chain as unknown as ChainClient, launchConfig('C-12', 'ring')));
    await t2.resumeSplits();
    await t2.claimAndSplit();
    const claimed = chain.ledger.filter((x) => x.kind === 'claim');
    const events = await env.core.bus.list(launchId, { kinds: ['fee.claimed', 'split.receipt'] });
    for (const c of claimed) {
      expect(events.some((e) => e.kind === 'fee.claimed' && (e.payload as { claimId: string }).claimId === c.claimId)).toBe(true);
      expect(events.some((e) => e.kind === 'split.receipt' && (e.payload as SplitReceipt).claimId === c.claimId)).toBe(true);
    }
  });

  // MoleculeRunner.tick returns early once the kill switch is engaged, so no fee claim or
  // split ever runs again for that launch. SPEC/docs: the kill switch turns AUTOPILOT off;
  // fee claims are scheduled Treasurer work, not autopilot.
  it('[AG-008] after the kill switch, the scheduled fee claim + split still runs (only autopilot stops)', async () => {
    const w = wallet();
    const launchId = await createLaunch(env.core, 'chain', 'C-12', null, w.address);
    await env.core.bus.append({ launchId, kind: 'launch.deployed', actor: 'treasurer', payload: { ca: 'Mint', txSig: 's', creatorWallet: 'Fee', devBuySol: 0.1, network: 'devnet' } });
    await env.core.approvals.killSwitch(launchId, w.address, 'stop autopilot');
    const chain = new LedgerChain();
    chain.pending = 5_000_000n;
    const runner = new MoleculeRunner(agentCtx(env, env.core, launchId, chain as unknown as ChainClient, launchConfig('C-12', 'chain')), { chooseNarrative: async () => ({ narrative: 0, name: 0 }), signLaunchTx: async () => '' });
    const r = await runner.tick();
    expect(r.claimed).toBe(true);
  });
});

describe('$CARBON buyback: receipts match the chain, one receipt per buy', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  const LEG = 50_000_000n; // 0.05 SOL buyback leg; RING C-12 cap is 0.01 SOL per tick

  async function setup() {
    const k = keys();
    const chain = new FakeChain();
    const g = fixtureGlobal();
    chain.accounts.set(pumpSdk.GLOBAL_PDA.toBase58(), { data: await encodeAccount('pump', 'global', g as never), owner: PUMP_PROGRAM_ID, lamports: 1, executable: false });
    chain.accounts.set(pumpSdk.bondingCurvePda(k.carbonMint.publicKey).toBase58(), {
      data: await encodeAccount('pump', 'bondingCurve', {
        virtualTokenReserves: g.initialVirtualTokenReserves,
        virtualSolReserves: g.initialVirtualSolReserves,
        realTokenReserves: g.initialRealTokenReserves,
        realSolReserves: new BN(0),
        tokenTotalSupply: g.tokenTotalSupply,
        complete: false,
        creator: Keypair.generate().publicKey,
      }),
      owner: PUMP_PROGRAM_ID,
      lamports: 1,
      executable: false,
    });
    chain.accounts.set(k.carbonMint.publicKey.toBase58(), { data: Buffer.alloc(82), owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false });
    const spentOnChain: bigint[] = [];
    chain.onTx = (_tx, ixs): Effect | void => {
      const buy = ixs.find((ix) => decodePumpIx(ix)?.name === 'buy');
      if (!buy) return;
      const max = BigInt(String(decodePumpIx(buy)!.data['maxSolCost']));
      const sol = max - 200_000n;
      spentOnChain.push(sol + 95_000n + 30_000n);
      return {
        logs: eventLogs(PUMP_PROGRAM_ID, 'pump', 'tradeEvent', { mint: k.carbonMint.publicKey, isBuy: true, user: k.buyback.publicKey, solAmount: new BN(sol.toString()), fee: new BN(95_000), creatorFee: new BN(30_000) }),
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: k.carbonMint.publicKey.toBase58(), owner: k.buyback.publicKey.toBase58(), amount: 351_234_567n }],
      };
    };
    const cfg = launchConfig('C-12', 'ring');
    const e = solEnv(k);
    const c = client(env, chain, e, cfg);
    const { launchId, w } = await deployedLaunch(env);
    await c.createLaunchWallet(launchId);
    await env.core.bus.pool.query(`UPDATE sol_launches SET state='confirmed', launcher_wallet=$2 WHERE launch_id=$1`, [launchId, w.address]);
    const claimId = randomUUID();
    const splitId = `split_${claimId}`;
    await env.core.bus.pool.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, lamports) VALUES ($1,$2,'native','confirmed','fixture',$3)`, [claimId, launchId, (LEG * 10n / 3n).toString()]);
    await env.core.bus.pool.query(`INSERT INTO sol_splits (split_id, claim_id, launch_id, mode, total) VALUES ($1,$2,$3,'native',$4)`, [splitId, claimId, launchId, (LEG * 10n / 3n).toString()]);
    await env.core.bus.pool.query(`INSERT INTO split_ledger (claim_id, leg, launch_id, address, lamports, state, tx_sig) VALUES ($1,'carbon-buyback',$2,$3,$4,'confirmed','fixture')`, [claimId, launchId, k.buyback.publicKey.toBase58(), LEG.toString()]);
    await env.core.bus.append({ launchId, kind: 'launch.deployed', actor: 'treasurer', payload: { ca: 'Mint', txSig: 's', creatorWallet: 'Fee', devBuySol: 0.25, network: 'devnet' } });
    await env.core.bus.append({
      launchId,
      kind: 'split.receipt',
      actor: 'treasurer',
      payload: { splitId, claimId, totalLamports: (LEG * 10n / 3n).toString(), legs: [{ to: 'carbon-buyback', address: k.buyback.publicKey.toBase58(), lamports: LEG.toString(), txSig: 'fixture', status: 'confirmed' }], at: 0 },
    });
    await env.core.approvals.setAutopilot(launchId, 'buybacks', true, w.address);
    const treasurer = new Treasurer(agentCtx(env, env.core, launchId, c, cfg));
    return { treasurer, chain, spentOnChain, launchId };
  }

  it('one tick: exactly one buy on chain, capped at the row’s per-tick budget', async () => {
    const s = await setup();
    const b = await s.treasurer.buyback();
    expect(b).not.toBeNull();
    expect(s.spentOnChain).toHaveLength(1);
    expect(s.chain.landed.has(b!.payload.txSig)).toBe(true);
  });

  // Treasurer emits `lamportsIn: amount` (what it asked for) and ignores the chain
  // client's own event, whose lamportsIn is read from the on-chain TradeEvent.
  it('[AG-006] buyback.executed.lamportsIn equals the SOL the on-chain trade actually spent', async () => {
    const s = await setup();
    const b = await s.treasurer.buyback();
    expect(BigInt(b!.payload.lamportsIn)).toBe(s.spentOnChain[0]);
  });

  // buyCarbon is idempotent per splitId (ONE buy per split). When the 30% leg is larger than
  // the per-tick cap, Treasurer sees "remaining funds" on the next tick and calls buyCarbon
  // again for the same split; the client returns the FIRST buy's signature and Treasurer
  // publishes a second buyback.executed for a purchase that never happened.
  it('[AG-005] two ticks never publish two buyback receipts for one on-chain buy', async () => {
    const s = await setup();
    await s.treasurer.buyback();
    env.clock.advance(11 * 60_000); // next RING tick: the per-tick budget window has rolled
    await s.treasurer.buyback().catch(() => null);
    const evs = (await env.core.bus.list(s.launchId, { kinds: ['buyback.executed'] })) as CarbonEvent<'buyback.executed'>[];
    const sigs = evs.map((e) => e.payload.txSig);
    expect(new Set(sigs).size).toBe(sigs.length);
    expect(evs.length).toBe(s.spentOnChain.length);
  });
});

describe('airdrops: kill mid-send and resume', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  it('kill after broadcast, then resume twice: one token transfer per holder, same signature reported', async () => {
    const k = keys();
    const chain = new FakeChain();
    const c = client(env, chain, solEnv(k));
    const daughter = Keypair.generate().publicKey.toBase58();
    const holders = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    chain.faults.throwAfterSend = 1;
    await c.airdropUnits('L-air', daughter, holders[0]!, 1000n).catch(() => undefined);
    const a = await c.airdropUnits('L-air', daughter, holders[0]!, 1000n);
    const b = await c.airdropUnits('L-air', daughter, holders[0]!, 999_999n); // a different amount cannot start a second send
    expect(b.txSig).toBe(a.txSig);
    expect(b.event.payload.units).toBe('1000');
    await c.airdropUnits('L-air', daughter, holders[1]!, 500n);
    expect(chain.tokenTransfers).toHaveLength(2);
    expect(chain.tokenTransfers.map((t) => t.amount)).toEqual([1000n, 500n]);
  });

  // Supervisor.decayTick appends each event the watcher offers and THEN acks it in sol_decay.
  // A crash between the two re-offers the same event on the next tick, so the public log
  // gets a second holders.snapshot (and, later, duplicate airdrop.sent receipts).
  it('[AG-017] a crash between appending a decay event and acking it does not publish that event twice', async () => {
    const k = keys();
    const chain = new FakeChain();
    let failAck = true;
    const pool = env.core.bus.pool;
    const flakyPool = new Proxy(pool, {
      get(t, key) {
        if (key === 'query')
          return (sql: string, params?: unknown[]) => {
            if (failAck && typeof sql === 'string' && sql.includes("jsonb_build_object('snapshot'")) {
              failAck = false;
              return Promise.reject(new Error('process killed before ack'));
            }
            return t.query(sql, params as never);
          };
        const v = (t as never)[key];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as pg.Pool;
    const cfg = launchConfig('C-14', 'chain');
    const c = client(env, chain, solEnv(k), cfg, flakyPool);
    const { launchId } = await deployedLaunch(env, 'chain', 'C-14');
    await env.core.bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: { name: 'Mother', ticker: 'MOM', lore: 'x', logoUri: 'https://ipfs.io/ipfs/x', logoHash: '0'.repeat(16), bannerUri: 'u', siteUri: 'u' } });
    const deployed = await env.core.bus.append({ launchId, kind: 'launch.deployed', actor: 'treasurer', payload: { ca: Keypair.generate().publicKey.toBase58(), txSig: 's', creatorWallet: 'Fee', devBuySol: 0.1, network: 'devnet' } });
    const created = (await env.core.bus.list(launchId, { kinds: ['launch.created'] }))[0] as CarbonEvent<'launch.created'>;
    env.clock.advance(7 * 24 * 3600_000 + 1000); // the C-14 clock ran out
    const sup = new Supervisor({
      core: env.core,
      pool: flakyPool,
      llm: {} as never,
      x: {} as never,
      chain: { kind: 'solana', client: c },
      assets: { put: async () => ({ uri: 'u' }) },
      workerId: 'g',
      now: env.clock.now,
      log: () => undefined,
    });
    await sup.decayTick(created, deployed).catch(() => undefined);
    await sup.decayTick(created, deployed).catch(() => undefined);
    await sup.decayTick(created, deployed).catch(() => undefined);
    const snaps = await env.core.bus.list(launchId, { kinds: ['holders.snapshot'] });
    expect(snaps.length).toBe(1);
  });
});
