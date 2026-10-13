/**
 * SPEC §7: "Try to give an agent a 5th bond: must fail."
 * Through Handoffs, by appending raw hand-off events straight to the bus,
 * and with concurrent senders in separate processes (separate pools/Redis).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  BOND_WINDOW_MS,
  EventBusHandoffs,
  HandoffTimeoutError,
  VALENCE,
  analyzeBonds,
  bondTotals,
  computeBonds,
  type AgentId,
  type ArgonEvent,
  type Core,
} from '@argon/core';
import { createLaunch, makeEnv, type Env } from './support/env.js';

const others = (a: AgentId) => AGENT_IDS.filter((x) => x !== a);

function maxTotalsOverTime(events: ArgonEvent[], stepMs = 250): { max: number; at: number; agent: string } {
  let best = { max: 0, at: 0, agent: '' };
  if (!events.length) return best;
  const t0 = events[0]!.ts;
  const t1 = events[events.length - 1]!.ts + BOND_WINDOW_MS + 1000;
  for (let t = t0; t <= t1; t += stepMs) {
    const tot = bondTotals(events, t);
    for (const a of AGENT_IDS) if (tot[a] > best.max) best = { max: tot[a], at: t, agent: a };
  }
  // also exactly at every event ts
  for (const e of events) {
    const tot = bondTotals(events, e.ts);
    for (const a of AGENT_IDS) if (tot[a] > best.max) best = { max: tot[a], at: e.ts, agent: a };
  }
  return best;
}

describe('valence 4: a fifth bond order must fail', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  const fastHandoffs = (core: Core) => new EventBusHandoffs({ bus: core.bus, pool: core.bus.pool, now: env.clock.now, pollMs: 20, maxWaitMs: 400 });

  it('via Handoffs: a 5th single bond queues visibly and never forms', async () => {
    const launchId = await createLaunch(env.core, 'diamond');
    const h = fastHandoffs(env.core);
    for (const to of ['forge', 'herald', 'keeper', 'treasurer'] as const) await h.send(launchId, 'scout', to, 'probe', 'probe');
    await expect(h.send(launchId, 'scout', 'sentinel', 'probe', 'fifth')).rejects.toBeInstanceOf(HandoffTimeoutError);
    const events = await env.core.bus.list(launchId);
    expect(events.filter((e) => e.kind === 'handoff.queued')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'handoff')).toHaveLength(4);
    expect(bondTotals(events, env.clock.now()).scout).toBe(4);
    expect(maxTotalsOverTime(events).max).toBeLessThanOrEqual(VALENCE);
  });

  it('via Handoffs: upgrading an existing bond past 4 (single → double) is refused too', async () => {
    const launchId = await createLaunch(env.core, 'diamond');
    const h = fastHandoffs(env.core);
    for (const to of ['forge', 'herald', 'keeper', 'treasurer'] as const) await h.send(launchId, 'scout', to, 'probe', 'probe');
    await h.send(launchId, 'forge', 'scout', 'probe', '2nd exchange'); // still single (2 < 3)
    await expect(h.send(launchId, 'scout', 'forge', 'probe', '3rd exchange makes a double')).rejects.toBeInstanceOf(HandoffTimeoutError);
    const events = await env.core.bus.list(launchId);
    expect(bondTotals(events, env.clock.now()).scout).toBe(4);
  });

  it('via Handoffs: the queued hand-off goes through once the window frees a bond', async () => {
    const launchId = await createLaunch(env.core, 'diamond');
    const h = new EventBusHandoffs({ bus: env.core.bus, pool: env.core.bus.pool, now: env.clock.now, pollMs: 20, maxWaitMs: 5000 });
    for (const to of ['forge', 'herald', 'keeper', 'treasurer'] as const) await h.send(launchId, 'scout', to, 'probe', 'probe');
    const p = h.send(launchId, 'scout', 'sentinel', 'probe', 'waits');
    await new Promise((r) => setTimeout(r, 150));
    env.clock.advance(BOND_WINDOW_MS + 1);
    const e = await p;
    const events = await env.core.bus.list(launchId);
    expect(analyzeBonds(events, e.ts).acceptedHandoffIds).toContain(e.id);
    expect(maxTotalsOverTime(events).max).toBeLessThanOrEqual(VALENCE);
  });

  it('raw hand-off events appended straight to the bus (bypassing Handoffs) never show a 5th bond', async () => {
    const launchId = await createLaunch(env.core, 'diamond');
    const appended: ArgonEvent[] = [];
    for (let round = 0; round < 4; round++) {
      for (const to of others('scout')) {
        appended.push(await env.core.bus.append({ launchId, kind: 'handoff', actor: 'scout', payload: { from: 'scout', to, topic: 'raw', summary: 'bypass' } }));
      }
      env.clock.advance(1000);
    }
    // Forged sender: actor ≠ payload.from must not count either.
    await env.core.bus.append({ launchId, kind: 'handoff', actor: 'forge', payload: { from: 'scout', to: 'keeper', topic: 'forged', summary: 'forged sender' } });
    const events = await env.core.bus.list(launchId);
    const worst = maxTotalsOverTime(events);
    expect(worst.max, `agent ${worst.agent} at ${worst.at}`).toBeLessThanOrEqual(VALENCE);
    const a = analyzeBonds(events, env.clock.now());
    expect(a.ignoredHandoffs.length).toBeGreaterThan(0);
    expect(a.ignoredHandoffs.some((i) => /actor is not the sender/.test(i.reason))).toBe(true);
    // what Handoffs reports equals the pure recomputation
    expect(await env.core.handoffs.bonds(launchId, env.clock.now())).toEqual(computeBonds(events, env.clock.now()));
  });

  it('hand-offs off the shape topology never form a bond (CHAIN has no scout–herald bond)', async () => {
    const launchId = await createLaunch(env.core, 'chain');
    await expect(env.core.handoffs.send(launchId, 'scout', 'herald', 'x', 'off-topology')).rejects.toThrow(/not a bond/);
    await env.core.bus.append({ launchId, kind: 'handoff', actor: 'scout', payload: { from: 'scout', to: 'herald', topic: 'raw', summary: 'off-topology' } });
    expect(computeBonds(await env.core.bus.list(launchId), env.clock.now())).toEqual([]);
  });

  it('concurrent senders in three processes, mixed with raw appends: never above 4, and no send reports a hand-off the display ignores', async () => {
    const launchId = await createLaunch(env.core, 'diamond');
    const cores = [env.core, await env.another(), await env.another()];
    const senders = cores.map(fastHandoffs);
    const results: { ok: ArgonEvent<'handoff'>[]; failed: number } = { ok: [], failed: 0 };
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      const from = AGENT_IDS[i % 6]!;
      const to = others(from)[(i * 7) % 5]!;
      const s = senders[i % senders.length]!;
      jobs.push(
        s.send(launchId, from, to, 'race', `race ${i}`).then(
          (e) => results.ok.push(e),
          () => (results.failed += 1),
        ),
      );
      if (i % 5 === 0) {
        jobs.push(cores[(i + 1) % cores.length]!.bus.append({ launchId, kind: 'handoff', actor: from, payload: { from, to, topic: 'raw', summary: `raw ${i}` } }));
      }
    }
    await Promise.all(jobs);
    const events = await env.core.bus.list(launchId);
    const worst = maxTotalsOverTime(events);
    expect(worst.max, `agent ${worst.agent} at ${worst.at}`).toBeLessThanOrEqual(VALENCE);
    const accepted = new Set(analyzeBonds(events, env.clock.now()).acceptedHandoffIds);
    for (const e of results.ok) expect(accepted.has(e.id), `send() returned ${e.id.slice(0, 8)} but the bond calculator ignores it`).toBe(true);
    expect(results.failed).toBeGreaterThan(0); // 30 hand-offs among 6 agents in one window cannot all fit
  });

  // Guard probe on the pure calculator. bonds.ts promises "computeBonds never reports > 4
  // for any agent even for a log written by something that bypassed Handoffs". The bus
  // enforces non-decreasing ts, but the events table has no such constraint, so a row
  // inserted with SQL (or a future second writer) can carry an earlier ts than its seq
  // predecessor. analyzeBonds then accepts it in isolation and the sum exceeds 4.
  it('[AG-012] computeBonds stays ≤ 4 even when ts goes backwards in seq order (raw SQL insert)', () => {
    const L = 'probe-backwards';
    let seq = 0;
    const mk = (ts: number, kind: ArgonEvent['kind'], actor: ArgonEvent['actor'], payload: unknown): ArgonEvent =>
      ({ id: (++seq).toString(16).padStart(64, '0'), seq, launchId: L, ts, kind, actor, payload, signer: '', sig: '' }) as ArgonEvent;
    const log = [
      mk(0, 'launch.created', 'user', { line: 'x', isotope: 'Ar-36', shape: 'diamond', heavyAgent: null, launcherWallet: 'w', xConnected: false }),
      ...(['forge', 'herald', 'keeper', 'treasurer'] as const).map((to) => mk(100_000, 'handoff', 'scout', { from: 'scout', to, topic: 't', summary: 's' })),
      mk(50_000, 'handoff', 'scout', { from: 'scout', to: 'sentinel', topic: 't', summary: 'backdated' }),
    ];
    expect(bondTotals(log, 100_000).scout).toBeLessThanOrEqual(VALENCE);
  });
});
