/**
 * Agent G, second pass: new adversarial cases against the fixes for AG-001..AG-026, written
 * without trusting the flipped tests. Open defects are `it.fails` with their id.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  BOND_WINDOW_MS,
  PgApprovals,
  VALENCE,
  bondTotals,
  computeBonds,
  type AgentId,
  type CarbonEvent,
  type EventBus,
} from '@carbon/core';
import { CarbonChainClient, ChainUnavailableError, GENESIS_HASH, NetworkGuardError, loadSolanaConfig } from '@carbon/solana';
import { createLaunch, makeEnv, wallet, type Env } from './support/env.js';

// ───────────────────────── AG-012: valence under arbitrary logs ─────────────────────────

/** Deterministic PRNG (tests must be reproducible). */
function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
const hex64 = (r: () => number) => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');

function randomLog(r: () => number, n: number): CarbonEvent[] {
  const launchId = 'prop';
  const t0 = 1_900_000_000_000;
  const evs: CarbonEvent[] = [];
  const shapes = ['chain', 'ring', 'diamond'] as const;
  const base = { launchId, signer: 'x', sig: 'x' };
  if (r() < 0.8) evs.push({ ...base, id: hex64(r), seq: 1, ts: t0, kind: 'launch.created', actor: 'user', payload: { line: 'p', isotope: 'C-12', shape: shapes[Math.floor(r() * 3)]!, heavyAgent: null, launcherWallet: 'w', xConnected: false } } as CarbonEvent);
  let ts = t0;
  for (let i = 0; i < n; i++) {
    // mostly forward in time, sometimes far backwards or far forwards (raw SQL writers)
    const jump = r();
    ts = jump < 0.08 ? ts - Math.floor(r() * 120_000) : jump < 0.1 ? ts + Math.floor(r() * 200_000) : ts + Math.floor(r() * 4_000);
    const a = AGENT_IDS[Math.floor(r() * 6)]!;
    let b = AGENT_IDS[Math.floor(r() * 6)]!;
    if (r() < 0.95) while (b === a) b = AGENT_IDS[Math.floor(r() * 6)]!;
    const k = r();
    const actor = (r() < 0.9 ? a : AGENT_IDS[Math.floor(r() * 6)]!) as AgentId;
    const ev =
      k < 0.8
        ? { kind: 'handoff', actor, payload: { from: a, to: b, topic: 't', summary: 's' } }
        : k < 0.92
          ? { kind: 'agent.blocked', actor: a, payload: { agent: a, on: b, reason: 'r' } }
          : { kind: 'agent.unblocked', actor: a, payload: { agent: a, on: b } };
    evs.push({ ...base, id: hex64(r), seq: evs.length + 1, ts, ...ev } as CarbonEvent);
  }
  return evs;
}

describe('[AG-012] valence holds for ANY log, including raw rows that break ts order', () => {
  it('400 random logs (forged actors, backdated and future-dated rows, mutual blocks): no agent ever exceeds 4, at any time', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = prng(seed * 7919);
      const log = randomLog(r, 20 + Math.floor(r() * 80));
      const times = new Set<number>();
      for (const e of log) for (const d of [-1, 0, 1, 30_000, BOND_WINDOW_MS - 1, BOND_WINDOW_MS + 1]) times.add(e.ts + d);
      for (const t of times) {
        const tot = bondTotals(log, t);
        for (const a of AGENT_IDS) expect(tot[a], `seed ${seed} at ${t}: ${a}`).toBeLessThanOrEqual(VALENCE);
      }
      // the input order does not matter (the replay sorts by seq): a shuffled copy gives the same bonds
      const shuffled = [...log].sort(() => r() - 0.5);
      const at = log[log.length - 1]!.ts + 1;
      expect(computeBonds(shuffled, at), `seed ${seed}`).toEqual(computeBonds(log, at));
    }
  });
});

// ───────────────────────── AG-011: the cluster is decided by genesis hash ─────────────────────────

function solEnv(extra: Record<string, string> = {}): Record<string, string> {
  const buyback = Keypair.generate();
  return {
    CARBON_VAULT_KEY: randomBytes(32).toString('hex'),
    CARBON_BUYBACK_WALLET: buyback.publicKey.toBase58(),
    CARBON_TREASURY_WALLET: Keypair.generate().publicKey.toBase58(),
    CARBON_CRANK_KEY: bs58.encode(Keypair.generate().secretKey),
    CARBON_BUYBACK_KEY: bs58.encode(buyback.secretKey),
    CARBON_MINT: Keypair.generate().publicKey.toBase58(),
    ...extra,
  };
}

/** An RPC that reports `genesis` and records every other call; a DB that records every query. */
function stubs(genesis: () => Promise<string>) {
  const rpcCalls: string[] = [];
  const dbCalls: string[] = [];
  const rpc = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (k === 'getGenesisHash' ? genesis : k === 'then' ? undefined : (..._a: unknown[]) => (rpcCalls.push(String(k)), Promise.reject(new Error(`rpc.${String(k)} reached`)))),
  });
  const db = {
    query: async (sql: string) => (dbCalls.push(sql), Promise.reject(new Error('db reached'))),
    connect: async () => (dbCalls.push('connect'), Promise.reject(new Error('db reached'))),
  };
  return { rpc, db, rpcCalls, dbCalls };
}

function moneyCalls(c: CarbonChainClient): [string, () => Promise<unknown>][] {
  return [
    ['claimCreatorFees', () => c.claimCreatorFees(randomUUID())],
    ['runSplit', () => c.runSplit(randomUUID(), randomUUID())],
    ['buyCarbon', () => c.buyCarbon(1000n, 'split_x')],
    ['submitLaunchTx', () => c.submitLaunchTx(randomUUID(), 'AAAA')],
    ['airdropUnits', () => c.airdropUnits(randomUUID(), Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), 5n)],
    ['confirmedClaims', () => c.confirmedClaims(randomUUID())],
    ['scanForeignDistributions', () => c.scanForeignDistributions(randomUUID())],
  ];
}

describe('[AG-011] a devnet-labelled client never moves value on a cluster whose genesis is not devnet', () => {
  for (const [label, hash] of [
    ['mainnet-beta', GENESIS_HASH['mainnet-beta']],
    ['testnet', GENESIS_HASH.testnet],
    ['an unknown cluster', '11111111111111111111111111111111'],
  ] as const) {
    it(`URL says devnet, genesis is ${label}: every money path refuses before touching the DB or sending`, async () => {
      const e = solEnv({ CARBON_RPC_URL: 'https://my-devnet-node.example.org' });
      const s = stubs(async () => hash);
      const c = new CarbonChainClient({ config: loadSolanaConfig(e), rpc: s.rpc as never, db: s.db as never, env: e, launchConfig: async () => ({}) as never, assertLaunchAllowed: async () => undefined });
      for (const [name, call] of moneyCalls(c)) await expect(call(), name).rejects.toBeInstanceOf(NetworkGuardError);
      expect(s.rpcCalls).toEqual([]);
      expect(s.dbCalls).toEqual([]);
    });
  }

  it('mainnet config (both flags) on an RPC whose genesis is devnet is refused too', async () => {
    const e = solEnv({ CARBON_NETWORK: 'mainnet-beta', CARBON_MAINNET_ENABLED: 'true', CARBON_RPC_URL: 'https://rpc.example.org' });
    const s = stubs(async () => GENESIS_HASH.devnet);
    const c = new CarbonChainClient({ config: loadSolanaConfig(e), rpc: s.rpc as never, db: s.db as never, env: e });
    await expect(c.claimCreatorFees(randomUUID())).rejects.toBeInstanceOf(NetworkGuardError);
    expect(s.dbCalls).toEqual([]);
  });

  it('an RPC that cannot answer getGenesisHash blocks every money path (fail closed) and is retried, not cached as "ok"', async () => {
    const e = solEnv({ CARBON_RPC_URL: 'https://api.devnet.solana.com' });
    let up = false;
    const s = stubs(async () => {
      if (!up) throw new Error('fetch failed');
      return GENESIS_HASH.devnet;
    });
    const c = new CarbonChainClient({ config: loadSolanaConfig(e), rpc: s.rpc as never, db: s.db as never, env: e });
    await expect(c.claimCreatorFees(randomUUID())).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(s.dbCalls).toEqual([]);
    up = true;
    // once the RPC answers with the devnet genesis, the call proceeds to the ledger (our stub DB refuses there)
    await expect(c.claimCreatorFees(randomUUID())).rejects.toThrow(/db reached/);
    expect(s.dbCalls.length).toBeGreaterThan(0);
  });
});

// ───────────────────────── AG-005 / AG-017: once-only facts under concurrency ─────────────────────────

describe('[AG-005][AG-017] once-only receipts hold across processes appending at the same moment', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  it('two worker processes racing to receipt the same buy / claim / snapshot publish exactly one event each', async () => {
    const launchId = await createLaunch(env.core, 'ring');
    const other = await env.another();
    const txSig = bs58.encode(randomBytes(64));
    const claimId = randomUUID();
    const buy = { lamportsIn: '9925000', carbonOut: '123', txSig, funding: 'fee-split' as const, splitId: `split_${claimId}` };
    await Promise.all(
      [env.core, other, env.core, other].flatMap((c) => [
        c.bus.append({ launchId, kind: 'buyback.executed', actor: 'treasurer', payload: buy }),
        c.bus.append({ launchId, kind: 'fee.claimed', actor: 'treasurer', payload: { claimId, lamports: '1000', txSig: 'claim-sig' } }),
        c.bus.append({ launchId, kind: 'holders.snapshot', actor: 'treasurer', payload: { slot: 7, holderCount: 3, merkleRoot: 'ab' } }),
      ]),
    );
    const evs = await env.core.bus.list(launchId);
    expect(evs.filter((e) => e.kind === 'buyback.executed')).toHaveLength(1);
    expect(evs.filter((e) => e.kind === 'fee.claimed')).toHaveLength(1);
    expect(evs.filter((e) => e.kind === 'holders.snapshot')).toHaveLength(1);
    // a DIFFERENT buy (new txSig) and a different snapshot are still recorded
    await env.core.bus.append({ launchId, kind: 'buyback.executed', actor: 'treasurer', payload: { ...buy, txSig: bs58.encode(randomBytes(64)) } });
    await env.core.bus.append({ launchId, kind: 'holders.snapshot', actor: 'treasurer', payload: { slot: 8, holderCount: 3, merkleRoot: 'ab' } });
    const after = await env.core.bus.list(launchId);
    expect(after.filter((e) => e.kind === 'buyback.executed')).toHaveLength(2);
    expect(after.filter((e) => e.kind === 'holders.snapshot')).toHaveLength(2);
  });
});

// ───────────────────────── AG-023 follow-up: consumption and its public event are not atomic ─────────────────────────

describe('[AG-027] approval consumption is public even when the event append fails', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  // PgApprovals.consume() commits the UPDATE (status → consumed) and only then appends
  // approval.consumed, outside that transaction. If the append fails (Postgres/Redis hiccup,
  // process killed between the two), the approval is spent but the public log never says so,
  // and the caller sees an error for an approval it can no longer use ("already used").
  it.fails('[AG-027] if approval.consumed cannot be appended, the approval is not consumed either (or the event is guaranteed)', async () => {
    const w = wallet();
    const launchId = await createLaunch(env.core, 'ring', 'C-12', null, w.address);
    const { approvalId } = await env.core.approvals.open(launchId, 'post', { text: 'gm' }, 'herald');
    await env.core.approvals.decide(approvalId, true, w.address);
    const failing: EventBus = new Proxy(env.core.bus, {
      get: (t, k) => (k === 'append' ? () => Promise.reject(new Error('append failed')) : Reflect.get(t, k, t)),
    });
    const flaky = new PgApprovals({ bus: failing, pool: env.core.bus.pool, now: env.clock.now });
    await expect(flaky.consume(launchId, approvalId, 'post')).rejects.toThrow(/append failed/);
    const { rows } = await env.core.bus.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [approvalId]);
    const events = await env.core.bus.list(launchId, { kinds: ['approval.consumed'] });
    // the invariant: consumed in the table  <=>  approval.consumed in the public log
    expect(rows[0]!.status === 'consumed').toBe(events.length === 1);
  });
});
