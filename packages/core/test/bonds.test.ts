import { describe, expect, it } from 'vitest';
import { AGENT_IDS, BOND_WINDOW_MS, VALENCE } from '../src/contracts.js';
import { analyzeBonds, bondTotals, computeBonds, handoffFits, orderFromExchanges } from '../src/bonds.js';
import { LogBuilder } from './helpers.js';

describe('computeBonds (pure)', () => {
  it('order thresholds: 1 / ≥3 / ≥8', () => {
    expect([0, 1, 2, 3, 7, 8, 20].map(orderFromExchanges)).toEqual([0, 1, 1, 2, 2, 3, 3]);
    const log = new LogBuilder();
    log.created('chain');
    for (let i = 0; i < 3; i++) log.handoff(1000 + i, 'scout', 'forge');
    expect(computeBonds(log.events)).toMatchObject([{ pair: 'scout|forge', order: 2, exchanges: 3 }]);
  });

  it('rolling 60s window: hand-offs expire', () => {
    const log = new LogBuilder();
    log.created('chain');
    const h = log.handoff(1000, 'scout', 'forge');
    expect(computeBonds(log.events, 1000 + BOND_WINDOW_MS - 1)).toEqual([
      { pair: 'scout|forge', order: 1, exchanges: 1, lastHash: h.id },
    ]);
    expect(computeBonds(log.events, 1000 + BOND_WINDOW_MS)).toEqual([]);
  });

  it('lastHash is the most recent hand-off on the pair', () => {
    const log = new LogBuilder();
    log.created('chain');
    log.handoff(1000, 'scout', 'forge');
    const last = log.handoff(1001, 'forge', 'scout');
    expect(computeBonds(log.events)[0]!.lastHash).toBe(last.id);
  });

  it('triple via mutual block (needs a hand-off in the window)', () => {
    const log = new LogBuilder();
    log.created('chain');
    log.handoff(1000, 'forge', 'sentinel');
    log.add(1001, 'agent.blocked', 'forge', { agent: 'forge', on: 'sentinel', reason: 'waiting for score' });
    expect(computeBonds(log.events)[0]!.order).toBe(1); // one direction only
    log.add(1002, 'agent.blocked', 'sentinel', { agent: 'sentinel', on: 'forge', reason: 'waiting for draft' });
    expect(computeBonds(log.events)[0]!.order).toBe(3);
    log.add(1003, 'agent.unblocked', 'forge', { agent: 'forge', on: 'sentinel' });
    expect(computeBonds(log.events)[0]!.order).toBe(1);
  });

  it('ignores hand-offs outside the shape topology', () => {
    const log = new LogBuilder();
    log.created('chain');
    const bad = log.handoff(1000, 'scout', 'treasurer');
    const a = analyzeBonds(log.events);
    expect(a.bonds).toEqual([]);
    expect(a.ignoredHandoffs).toEqual([{ id: bad.id, reason: expect.stringContaining('not in shape topology') }]);
  });

  it('ignores hand-offs whose actor is not the sender', () => {
    const log = new LogBuilder();
    log.created('chain');
    log.add(1000, 'handoff', 'forge', { from: 'scout', to: 'forge', topic: 't', summary: 's' });
    expect(computeBonds(log.events)).toEqual([]);
  });

  it('a 5th bond order is impossible even in a log that bypassed Handoffs', () => {
    const log = new LogBuilder();
    log.created('diamond');
    log.handoff(1000, 'scout', 'forge');
    log.handoff(1001, 'scout', 'herald');
    log.handoff(1002, 'scout', 'keeper');
    log.handoff(1003, 'scout', 'treasurer');
    const fifth = log.handoff(1004, 'scout', 'sentinel');
    const a = analyzeBonds(log.events);
    expect(a.totals.scout).toBe(4);
    expect(a.bonds.map((b) => b.pair)).not.toContain('scout|sentinel');
    expect(a.ignoredHandoffs.map((i) => i.id)).toEqual([fifth.id]);
    expect(handoffFits(log.events, 'scout', 'sentinel', 1005)).toMatchObject({ fits: false });
    // Raising an existing bond's order also counts against valence: scout|forge 1→2 needs 3 exchanges.
    log.handoff(1005, 'scout', 'forge');
    log.handoff(1006, 'scout', 'forge');
    expect(analyzeBonds(log.events).totals.scout).toBe(4);
    expect(computeBonds(log.events).find((b) => b.pair === 'scout|forge')!.order).toBe(1);
    // After the window, there is room again.
    expect(handoffFits(log.events, 'scout', 'sentinel', 1003 + BOND_WINDOW_MS + 1)).toEqual({ fits: true });
  });

  it('mutual-block upgrade never pushes an agent past valence', () => {
    const log = new LogBuilder();
    log.created('diamond');
    log.handoff(1000, 'forge', 'sentinel');
    log.handoff(1001, 'forge', 'scout');
    log.handoff(1002, 'forge', 'herald');
    log.handoff(1003, 'forge', 'keeper'); // forge total 4
    log.add(1004, 'agent.blocked', 'forge', { agent: 'forge', on: 'sentinel', reason: 'r' });
    log.add(1005, 'agent.blocked', 'sentinel', { agent: 'sentinel', on: 'forge', reason: 'r' });
    const a = analyzeBonds(log.events);
    expect(a.mutualBlocks).toEqual(['forge|sentinel']);
    expect(a.bonds.find((b) => b.pair === 'forge|sentinel')!.order).toBe(1);
    expect(a.totals.forge).toBe(4);
  });

  it('no agent ever exceeds valence across a random log', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const log = new LogBuilder();
    log.created('diamond');
    let t = 0;
    for (let i = 0; i < 600; i++) {
      t += Math.floor(rnd() * 400);
      const a = AGENT_IDS[Math.floor(rnd() * 6)]!;
      let b = AGENT_IDS[Math.floor(rnd() * 6)]!;
      if (a === b) b = AGENT_IDS[(AGENT_IDS.indexOf(a) + 1) % 6]!;
      if (rnd() < 0.05) log.add(t, 'agent.blocked', a, { agent: a, on: b, reason: 'r' });
      else if (rnd() < 0.05) log.add(t, 'agent.unblocked', a, { agent: a, on: b });
      else log.handoff(t, a, b);
      if (i % 25 === 0) {
        const totals = bondTotals(log.events, t);
        for (const id of AGENT_IDS) expect(totals[id]).toBeLessThanOrEqual(VALENCE);
        // totals equal the sum of displayed orders
        const sum = Object.fromEntries(AGENT_IDS.map((x) => [x, 0])) as Record<string, number>;
        for (const bnd of computeBonds(log.events, t)) {
          const [x, y] = bnd.pair.split('|') as [string, string];
          sum[x]! += bnd.order;
          sum[y]! += bnd.order;
        }
        expect(sum).toEqual(totals);
      }
    }
  });

  it('is deterministic and independent of input order', () => {
    const log = new LogBuilder();
    log.created('ring');
    for (let i = 0; i < 10; i++) log.handoff(1000 + i * 10, i % 2 ? 'scout' : 'forge', i % 2 ? 'forge' : 'scout');
    const shuffled = [...log.events].reverse();
    expect(computeBonds(shuffled, 2000)).toEqual(computeBonds(log.events, 2000));
  });

  it('refuses a mixed-launch log', () => {
    const a = new LogBuilder('a');
    const b = new LogBuilder('b');
    a.created('chain');
    b.created('chain');
    expect(() => computeBonds([...a.events, ...b.events])).toThrow(/exactly one launch/);
  });
});
