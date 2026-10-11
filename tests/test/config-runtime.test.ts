/**
 * SPEC §1/§7: "Each isotope × shape applies exactly its config row (budget, cadence,
 * threshold, decay); C-13's extra neutron affects only the chosen agent."
 * Checked at RUNTIME (budgets.spend against the Postgres ledger, Sentinel's report,
 * the worker supervisor's schedule, @carbon/solana's decay), not just in the table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  BudgetExceededError,
  ISOTOPES,
  ISOTOPE_IDS,
  SHAPES,
  SHAPE_IDS,
  launchConfig,
  type AgentId,
  type CarbonEvent,
  type ChainClient,
  type IsotopeId,
  type LaunchConfig,
  type LlmProvider,
  type ShapeId,
  type XClient,
} from '@carbon/core';
import { Herald, Sentinel, postRate, type AgentContext } from '@carbon/agents';
import { C11_HALF_LIFE_SEC, collapseAtMs, decayReadout } from '@carbon/solana';
import { Supervisor } from '../../apps/worker/src/supervisor.js';
import { createLaunch, makeEnv, wallet, type Env } from './support/env.js';

const LAMPORTS = 1_000_000_000;

interface Row {
  isotope: IsotopeId;
  shape: ShapeId;
  heavy: AgentId | null;
}
const ROWS: Row[] = ISOTOPE_IDS.flatMap((isotope) =>
  SHAPE_IDS.flatMap((shape): Row[] => (ISOTOPES[isotope].heavyAgent ? AGENT_IDS.map((heavy) => ({ isotope, shape, heavy })) : [{ isotope, shape, heavy: null }])),
);

/** Test doubles for the ports Sentinel needs (test-only). */
const cleanLlm: LlmProvider = {
  id: 'test-double',
  model: 'none',
  async generate() {
    return { text: '{"violations":[],"reasoning":"clean"}', json: { violations: [], reasoning: 'clean' }, provider: 'test-double', model: 'none', sources: [] };
  },
};
const quietChain = {
  network: 'devnet',
  async searchCoins() {
    return [];
  },
  async walletHistory() {
    return { txCount: 500, firstSeen: Date.UTC(2025, 0, 1), launches: 0 };
  },
} as unknown as ChainClient;

function ctxFor(env: Env, launchId: string, config: LaunchConfig): AgentContext {
  const { bus, handoffs, approvals, budgets } = env.core;
  return {
    bus,
    handoffs,
    approvals,
    budgets,
    llm: cleanLlm,
    x: {} as XClient,
    chain: quietChain,
    config,
    launchId,
    now: env.clock.now,
    assets: { put: async () => ({ uri: 'unused' }) },
    fetchBytes: async () => {
      throw new Error('no network in tests');
    },
  };
}

describe('every config row is what budgets.spend enforces at runtime', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  async function atLimit(launchId: string, agent: AgentId, kind: Parameters<Env['core']['budgets']['spend']>[2], limit: number) {
    const b = env.core.budgets;
    if (limit > 0) await b.spend(launchId, agent, kind, limit);
    await expect(b.spend(launchId, agent, kind, 1)).rejects.toBeInstanceOf(BudgetExceededError);
  }

  it(`${ROWS.length} rows (12 isotope × shape, C-13 with each heavy agent): llm per agent, posts, replies, dev buy, buyback per tick`, async () => {
    for (const r of ROWS) {
      const cfg = launchConfig(r.isotope, r.shape, r.heavy);
      const launchId = await createLaunch(env.core, r.shape, r.isotope, r.heavy);
      for (const a of AGENT_IDS) await atLimit(launchId, a, 'llm', cfg.capacity[a].llmCallsPerHour);
      await atLimit(launchId, 'herald', 'post', cfg.postsPerHour);
      await atLimit(launchId, 'keeper', 'reply', cfg.repliesPerHour);
      await atLimit(launchId, 'treasurer', 'devbuy-lamports', Math.round(cfg.devBuySol * LAMPORTS));
      await atLimit(launchId, 'treasurer', 'buyback-lamports', Math.round(cfg.buybackSolPerTick * LAMPORTS));
    }
  });

  it('windows: llm/posts/replies roll over after 1 h; buyback after the shape’s loop period (10 min default); dev buy never', async () => {
    for (const shape of SHAPE_IDS) {
      const cfg = launchConfig('C-12', shape);
      const launchId = await createLaunch(env.core, shape);
      const b = env.core.budgets;
      await b.spend(launchId, 'scout', 'llm', cfg.capacity.scout.llmCallsPerHour);
      await b.spend(launchId, 'treasurer', 'devbuy-lamports', Math.round(cfg.devBuySol * LAMPORTS));
      const tickMs = (cfg.loopMinutes ?? 10) * 60_000;
      if (cfg.buybackSolPerTick > 0) {
        await b.spend(launchId, 'treasurer', 'buyback-lamports', Math.round(cfg.buybackSolPerTick * LAMPORTS));
        env.clock.advance(tickMs - 1000);
        await expect(b.spend(launchId, 'treasurer', 'buyback-lamports', 1)).rejects.toBeInstanceOf(BudgetExceededError);
        env.clock.advance(2000);
        await b.spend(launchId, 'treasurer', 'buyback-lamports', 1);
      }
      env.clock.advance(60 * 60_000);
      await b.spend(launchId, 'scout', 'llm', 1);
      await expect(b.spend(launchId, 'treasurer', 'devbuy-lamports', 1)).rejects.toBeInstanceOf(BudgetExceededError);
    }
  });

  it('C-13: the extra neutron doubles only the chosen agent; every other number equals C-12 on the same shape', () => {
    for (const shape of SHAPE_IDS) {
      const base = launchConfig('C-12', shape);
      for (const heavy of AGENT_IDS) {
        const c = launchConfig('C-13', shape, heavy);
        for (const a of AGENT_IDS) {
          const k = a === heavy ? 2 : 1;
          expect(c.capacity[a]).toEqual({ llmCallsPerHour: base.capacity[a].llmCallsPerHour * k, concurrency: base.capacity[a].concurrency * k });
        }
        expect(c.postsPerHour).toBe(base.postsPerHour * (heavy === 'herald' ? 2 : 1));
        expect(c.repliesPerHour).toBe(base.repliesPerHour * (heavy === 'keeper' ? 2 : 1));
        const strip = (x: LaunchConfig) => ({ ...x, isotope: null, heavyAgent: null, capacity: null, postsPerHour: null, repliesPerHour: null });
        expect(strip(c)).toEqual(strip(base));
      }
    }
    expect(() => launchConfig('C-13', 'ring', null)).toThrow();
    expect(() => launchConfig('C-12', 'ring', 'herald')).toThrow();
  });

  it('C-13 heavy Herald: Herald’s posting rate check uses the doubled number at runtime; heavy Scout leaves Herald unchanged', async () => {
    for (const heavy of ['herald', 'scout'] as const) {
      const cfg = launchConfig('C-13', 'ring', heavy);
      const launchId = await createLaunch(env.core, 'ring', 'C-13', heavy);
      const ctx = ctxFor(env, launchId, cfg);
      for (let i = 0; i < cfg.postsPerHour; i++) {
        expect((await postRate(ctx)).ok).toBe(true);
        await env.core.bus.append({ launchId, kind: 'post.published', actor: 'herald', payload: { postId: String(i), url: `https://x.com/i/status/${i}`, text: `p${i}`, approvalId: `a${i}`, kind: 'post' } });
      }
      expect((await postRate(ctx)).ok).toBe(false);
      expect(cfg.postsPerHour).toBe(heavy === 'herald' ? 12 : 6);
    }
    expect(Herald).toBeTypeOf('function');
  });
});

describe('Sentinel scores against the launch’s own threshold', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  it('for every shape (and the C-11 small budget), report.threshold is the config row’s and passed = score ≥ threshold && !hardFail', async () => {
    for (const shape of SHAPE_IDS) {
      for (const isotope of ['C-11', 'C-12'] as const) {
        const w = wallet();
        const launchId = await createLaunch(env.core, shape, isotope, null, w.address);
        const cfg = launchConfig(isotope, shape);
        // DIAMOND gates every action: approve Sentinel's gate card as the launcher.
        const unsub = env.core.bus.subscribe(launchId, (e) => {
          if (e.kind === 'approval.requested') void env.core.approvals.decide((e as CarbonEvent<'approval.requested'>).payload.approvalId, true, w.address);
        });
        const draft = await env.core.bus.append({
          launchId,
          kind: 'forge.draft',
          actor: 'forge',
          payload: { name: 'Frostbyte Lattice', ticker: 'FRSTL', lore: 'A cold crystal.', logoUri: 'https://example.invalid/l.png', logoHash: '0'.repeat(16), bannerUri: 'https://example.invalid/b.png', siteUri: 'https://example.invalid/s' },
        });
        const s = await new Sentinel(ctxFor(env, launchId, cfg)).score({ draft, narrative: { title: 't', names: [{ name: 'Frostbyte Lattice', ticker: 'FRSTL' }], why: 'w', sources: [] }, launcherWallet: w.address });
        unsub();
        expect(s.payload.threshold).toBe(SHAPES[shape].sentinelThreshold);
        expect(s.payload.threshold).toBe(cfg.sentinelThreshold);
        expect(s.payload.passed).toBe(s.payload.score >= cfg.sentinelThreshold && !s.payload.hardFail);
        const sniper = s.payload.inputs.find((i) => i.key === 'sniper')!;
        expect(sniper.reason).toContain(`Dev buy ${cfg.devBuySol} SOL`); // the row's dev buy, not a constant
      }
    }
  });
});

describe('cadence and decay come from the row in the worker and @carbon/solana', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  function supervisor() {
    return new Supervisor({
      core: env.core,
      pool: env.core.bus.pool,
      llm: cleanLlm,
      x: {} as XClient,
      chain: { kind: 'unavailable', client: {} as ChainClient, reason: 'test: no chain' },
      assets: { put: async () => ({ uri: 'unused' }) },
      workerId: 'agent-g',
      now: env.clock.now,
      log: () => undefined,
      makeRunner: () => ({ run: async () => ({ status: 'not-approved' }) as never, tick: async () => ({ claimed: false, buyback: null, posts: [], replies: [] }) }),
    });
  }

  async function deployed(isotope: IsotopeId, shape: ShapeId) {
    const launchId = await createLaunch(env.core, shape, isotope, isotope === 'C-13' ? 'herald' : null);
    const dep = await env.core.bus.append({
      launchId,
      kind: 'launch.deployed',
      actor: 'treasurer',
      payload: { ca: 'Mint1111111111111111111111111111111111111', txSig: 'sig', creatorWallet: 'Fee11111111111111111111111111111111111111', devBuySol: 0.1, network: 'devnet' },
    });
    const created = (await env.core.bus.list(launchId, { kinds: ['launch.created'] }))[0] as CarbonEvent<'launch.created'>;
    return { launchId, dep, created };
  }

  it('RING loops every loopMinutes (10) from the last loop hand-off; CHAIN/DIAMOND claim hourly', async () => {
    const sup = supervisor();
    for (const shape of SHAPE_IDS) {
      const { launchId, dep, created } = await deployed('C-12', shape);
      const cfg = launchConfig('C-12', shape);
      const period = (cfg.loopMinutes ?? 60) * 60_000;
      expect(await sup.nextTickAt(created)).toBe(dep.ts + period);
      env.clock.advance(7 * 60_000);
      const loop = await env.core.bus.append({ launchId, kind: 'handoff', actor: 'treasurer', payload: { from: 'treasurer', to: 'herald', topic: 'loop', summary: 'loop' } });
      if (shape === 'ring') expect(await sup.nextTickAt(created)).toBe(loop.ts + 10 * 60_000);
    }
    await sup.stop();
  });

  it('after deploy the supervisor publishes the row’s decay clock: C-14 collapses at deploy + 7 d, C-11 on 20 min of quiet, C-12/C-13 never', async () => {
    const launches: Record<string, Awaited<ReturnType<typeof deployed>>> = {};
    for (const iso of ISOTOPE_IDS) launches[iso] = await deployed(iso, 'chain');
    const sup = supervisor();
    await sup.start();
    await sup.stop();
    for (const iso of ISOTOPE_IDS) {
      const { launchId, dep } = launches[iso]!;
      const started = (await env.core.bus.list(launchId, { kinds: ['decay.started'] })) as CarbonEvent<'decay.started'>[];
      const rule = ISOTOPES[iso].decay;
      if (rule.kind === 'none') expect(started).toHaveLength(0);
      else {
        expect(started).toHaveLength(1);
        expect(started[0]!.payload.rule).toBe(rule.kind);
        expect(started[0]!.payload.collapseAt).toBe(rule.kind === 'clock' ? dep.ts + 7 * 24 * 3600_000 : null);
      }
    }
  });

  it('@carbon/solana collapse times follow the row exactly (trades reset C-11, never C-14)', () => {
    const born = 1_900_000_000_000;
    const c11 = ISOTOPES['C-11'].decay;
    const c14 = ISOTOPES['C-14'].decay;
    expect(collapseAtMs(c11, born, null)).toBe(born + 20 * 60_000);
    expect(collapseAtMs(c11, born, born + 5 * 60_000)).toBe(born + 25 * 60_000);
    expect(collapseAtMs(c14, born, born + 6 * 24 * 3600_000)).toBe(born + 7 * 24 * 3600_000);
    expect(collapseAtMs(ISOTOPES['C-12'].decay, born, null)).toBeNull();
    expect(collapseAtMs(ISOTOPES['C-13'].decay, born, null)).toBeNull();
    // 1 s before: not collapsed; at the instant: collapsed
    expect(decayReadout(c11, born, null, born + 20 * 60_000 - 1000).remainingMs).toBe(1000);
    expect(decayReadout(c11, born, null, born + 20 * 60_000).progress).toBe(1);
    // The 20.4-min half-life is illustration only, not the rule.
    expect(C11_HALF_LIFE_SEC).toBe(1224);
    expect(c11).toEqual({ kind: 'quiet', quietSec: 1200 });
  });
});
