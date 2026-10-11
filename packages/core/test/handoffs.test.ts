import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOND_WINDOW_MS, VALENCE, AGENT_IDS } from '../src/contracts.js';
import { analyzeBonds, computeBonds } from '../src/bonds.js';
import { EventBusHandoffs, HandoffTimeoutError, TopologyError } from '../src/handoffs.js';
import { createLaunch, testEnv, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
let handoffs: EventBusHandoffs;
beforeEach(async () => {
  env = await testEnv();
  handoffs = new EventBusHandoffs({ bus: env.bus, pool: env.bus.pool, now: env.clock.now, pollMs: 20, maxWaitMs: 60 * 60_000 });
});
afterEach(async () => {
  await env.cleanup();
});

/** Fill scout's valence with four single bonds (diamond allows every pair). */
async function fillScout(l: string) {
  for (const to of ['forge', 'herald', 'keeper', 'treasurer'] as const) {
    await handoffs.send(l, 'scout', to, 'work', `scout→${to}`);
    env.clock.advance(10);
  }
}

describe('Handoffs', () => {
  it('topology refusal: chain has no scout↔treasurer bond', async () => {
    const l = await createLaunch(env.bus, 'chain');
    await expect(handoffs.send(l, 'scout', 'treasurer', 'x', 'y')).rejects.toThrow(TopologyError);
    await expect(handoffs.send(l, 'scout', 'scout', 'x', 'y')).rejects.toThrow(TopologyError);
    expect((await env.bus.list(l, { kinds: ['handoff', 'handoff.queued'] })).length).toBe(0);
    // ring: scout↔keeper exists, scout↔sentinel does not
    const r = await createLaunch(env.bus, 'ring');
    await expect(handoffs.send(r, 'keeper', 'scout', 'x', 'y')).resolves.toMatchObject({ kind: 'handoff' });
    await expect(handoffs.send(r, 'scout', 'sentinel', 'x', 'y')).rejects.toThrow(/not a bond in the ring shape/);
  });

  it('a 5th bond fails: the hand-off queues and never forms', async () => {
    const l = await createLaunch(env.bus, 'diamond');
    await fillScout(l);
    const strict = new EventBusHandoffs({ bus: env.bus, pool: env.bus.pool, now: env.clock.now, pollMs: 20, maxWaitMs: 0 });
    await expect(strict.send(l, 'scout', 'sentinel', 'more', 'fifth')).rejects.toThrow(HandoffTimeoutError);
    const log = await env.bus.list(l);
    expect(log.filter((e) => e.kind === 'handoff.queued')).toHaveLength(1);
    expect(log.filter((e) => e.kind === 'handoff')).toHaveLength(4);
    const a = analyzeBonds(log, env.clock.t);
    expect(a.totals.scout).toBe(VALENCE);
    expect(a.bonds.some((b) => b.pair === 'scout|sentinel')).toBe(false);

    // Bypassing Handoffs and appending straight to the bus still cannot create a 5th bond.
    await env.bus.append({ launchId: l, kind: 'handoff', actor: 'scout', payload: { from: 'scout', to: 'sentinel', topic: 'x', summary: 'bypass' } });
    const after = analyzeBonds(await env.bus.list(l), env.clock.t);
    expect(after.totals.scout).toBe(VALENCE);
    expect(after.ignoredHandoffs).toHaveLength(1);
  });

  it('a queued hand-off proceeds once the window decays', async () => {
    const l = await createLaunch(env.bus, 'diamond');
    await fillScout(l);
    const pending = handoffs.send(l, 'scout', 'sentinel', 'score', 'needs a check');
    await waitFor(async () => (await env.bus.list(l, { kinds: ['handoff.queued'] })).length === 1);
    // Still queued while the four bonds are in the window.
    await new Promise((r) => setTimeout(r, 100));
    expect((await env.bus.list(l, { kinds: ['handoff'] })).length).toBe(4);
    // Hand-offs sit at t0, t0+10, t0+20, t0+30 and the clock is at t0+40.
    // Move to t0+60005: only the first (scout→forge) has left the 60 s window.
    env.clock.advance(BOND_WINDOW_MS - 40 + 5);
    const e = await pending;
    expect(e.payload).toMatchObject({ from: 'scout', to: 'sentinel' });
    const bonds = computeBonds(await env.bus.list(l), env.clock.t);
    expect(bonds.map((b) => b.pair).sort()).toEqual(['scout|herald', 'scout|keeper', 'scout|sentinel', 'scout|treasurer']);
    expect(bonds.find((b) => b.pair === 'scout|sentinel')!.lastHash).toBe(e.id);
  });

  it('triple via mutual block, through the bus', async () => {
    const l = await createLaunch(env.bus, 'chain');
    await handoffs.send(l, 'forge', 'sentinel', 'coin-draft', 'draft v1');
    await env.bus.append({ launchId: l, kind: 'agent.blocked', actor: 'forge', payload: { agent: 'forge', on: 'sentinel', reason: 'needs score' } });
    await env.bus.append({ launchId: l, kind: 'agent.blocked', actor: 'sentinel', payload: { agent: 'sentinel', on: 'forge', reason: 'needs revised logo' } });
    const bonds = await handoffs.bonds(l);
    expect(bonds).toEqual([expect.objectContaining({ pair: 'forge|sentinel', order: 3, exchanges: 1 })]);
  });

  it('bond orders from computeBonds on the recorded log equal what Handoffs reports, at every step', async () => {
    const l = await createLaunch(env.bus, 'ring');
    const ring = [
      ['scout', 'forge'],
      ['forge', 'sentinel'],
      ['sentinel', 'treasurer'],
      ['treasurer', 'herald'],
      ['herald', 'keeper'],
      ['keeper', 'scout'],
    ] as const;
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const strict = new EventBusHandoffs({ bus: env.bus, pool: env.bus.pool, now: env.clock.now, pollMs: 5, maxWaitMs: 0 });
    for (let i = 0; i < 60; i++) {
      const [a, b] = ring[Math.floor(rnd() * ring.length)]!;
      const [from, to] = rnd() < 0.5 ? [a, b] : [b, a];
      await strict.send(l, from, to, 'step', `${i}`).catch((err) => {
        if (!(err instanceof HandoffTimeoutError)) throw err;
      });
      env.clock.advance(Math.floor(rnd() * 3000));
      const reported = await handoffs.bonds(l, env.clock.t);
      const recorded = await env.bus.list(l);
      expect(computeBonds(recorded, env.clock.t)).toEqual(reported);
      // Every hand-off Handoffs appended is counted by the calculator.
      const a2 = analyzeBonds(recorded, env.clock.t);
      expect(a2.ignoredHandoffs).toEqual([]);
      for (const id of AGENT_IDS) expect(a2.totals[id]).toBeLessThanOrEqual(VALENCE);
    }
    // And replaying the recorded log (fresh copy, as the UI would) gives identical bonds.
    const replay = JSON.parse(JSON.stringify(await env.bus.list(l)));
    expect(computeBonds(replay, env.clock.t)).toEqual(await handoffs.bonds(l, env.clock.t));
  });

  it('concurrent senders cannot jointly exceed valence', async () => {
    const l = await createLaunch(env.bus, 'diamond');
    const other = await env.open();
    const h2 = new EventBusHandoffs({ bus: other, pool: other.pool, now: env.clock.now, pollMs: 5, maxWaitMs: 0 });
    const h1 = new EventBusHandoffs({ bus: env.bus, pool: env.bus.pool, now: env.clock.now, pollMs: 5, maxWaitMs: 0 });
    const targets = ['forge', 'herald', 'keeper', 'treasurer', 'sentinel'] as const;
    const results = await Promise.allSettled(targets.map((to, i) => (i % 2 ? h1 : h2).send(l, 'scout', to, 't', 's')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    const a = analyzeBonds(await env.bus.list(l), env.clock.t);
    expect(a.totals.scout).toBe(4);
    expect(a.ignoredHandoffs).toEqual([]);
  });
});
