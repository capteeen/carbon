import { describe, expect, it } from 'vitest';
import { BOND_WINDOW_MS, pairKey, type Bond, type CarbonEvent } from '@carbon/core/contracts';
import {
  buildReplay,
  deriveLive,
  flashesFromEvents,
  isValidReplay,
  launchSummaryFromEvents,
  realEvents,
  validBonds,
  validFlashes,
  validLaunches,
} from '../src/data/derive.js';
import { gaugeSegments, sentinelPhase } from '../src/data/sentinel.js';
import { degree, hexSpiral, moleculeLayout } from '../src/three/layouts.js';
import { NUC_CENTER_Y, NUC_SCALE, chamberTargets } from '../src/three/Chamber.js';
import { crystalSize, placeCrystals } from '../src/three/Graphene.js';
import { ev, fakeId, fixtureLaunch, fixtureLaunches } from './fixtures/events.js';

describe('honesty filters', () => {
  it('empty or missing inputs derive nothing', () => {
    expect(realEvents(null)).toEqual([]);
    expect(deriveLive([], [])).toBeNull();
    expect(deriveLive(undefined, undefined)).toBeNull();
    expect(buildReplay([])).toBeNull();
    expect(launchSummaryFromEvents(null)).toBeNull();
    expect(validLaunches(undefined)).toEqual([]);
    expect(validFlashes(null)).toEqual([]);
  });

  it('drops events, flashes, bonds and launches without real event ids', () => {
    const { events } = fixtureLaunch();
    const forged = { ...events[1]!, id: 'not-a-hash' } as CarbonEvent;
    expect(realEvents([forged]).length).toBe(0);
    expect(validFlashes([{ pairKey: pairKey('scout', 'forge'), hash: 'deadbeef', at: 1 }])).toEqual([]);
    expect(validFlashes([{ pairKey: 'scout|nobody' as never, hash: fakeId('x'), at: 1 }])).toEqual([]);
    const bad: Bond = { pair: pairKey('scout', 'forge'), order: 2, exchanges: 3, lastHash: 'nope' };
    expect(validBonds([bad])).toEqual([]);
    expect(validBonds([{ ...bad, lastHash: fakeId('b'), order: 0 }])).toEqual([]);
    const l = fixtureLaunches(2);
    expect(validLaunches([{ ...l[0]!, deployEventId: 'x' }, l[1]!]).map((x) => x.launchId)).toEqual(['fixture-1']);
  });

  it('flashes carry the hand-off event id as the hash', () => {
    const { events } = fixtureLaunch({ handoffs: 3 });
    const f = flashesFromEvents(events);
    expect(f.length).toBe(3);
    const hand = events.filter((e) => e.kind === 'handoff');
    expect(f.map((x) => x.hash)).toEqual(hand.map((h) => h.id));
  });

  it('a launch that never deployed has no replay or crystal', () => {
    const { events } = fixtureLaunch();
    const undeployed = events.filter((e) => e.kind !== 'launch.deployed');
    expect(buildReplay(undeployed)).toBeNull();
    expect(launchSummaryFromEvents(undeployed)).toBeNull();
  });

  it('replay is built from the real log and validates', () => {
    const { events, bonds } = fixtureLaunch({ ticker: 'FIXT', handoffs: 5 });
    const r = buildReplay(events, bonds)!;
    expect(r.ticker).toBe('FIXT');
    expect(r.handoffs.length).toBe(5);
    expect(r.deployEventId).toBe(events.find((e) => e.kind === 'launch.deployed')!.id);
    expect(isValidReplay(r)).toBe(true);
    expect(isValidReplay({ ...r, deployEventId: 'x' })).toBe(false);
    expect(isValidReplay(null)).toBe(false);
  });
});

describe('deriveLive', () => {
  it('LOAD is hand-offs per minute in the bond window; BONDS sums core bond orders', () => {
    const t0 = 1_000_000;
    const h = (i: number, ts: number) => ev('L', 'handoff', 'scout', { from: 'scout', to: 'forge', topic: 't', summary: String(i) }, ts);
    const events = [h(1, t0 - BOND_WINDOW_MS - 10), h(2, t0 - 1000), h(3, t0 - 500)];
    const bonds: Bond[] = [
      { pair: pairKey('scout', 'forge'), order: 2, exchanges: 3, lastHash: events[2]!.id },
      { pair: pairKey('scout', 'herald'), order: 1, exchanges: 1, lastHash: fakeId('z') },
    ];
    const live = deriveLive(events, bonds, t0)!;
    const perMin = 60_000 / BOND_WINDOW_MS;
    expect(live.agents.scout!.load).toBe(2 * perMin);
    expect(live.agents.scout!.loadDelta).toBe(1 * perMin);
    expect(live.agents.scout!.bondOrders).toBe(3);
    expect(live.agents.forge!.bondOrders).toBe(2);
    expect(live.agents.keeper!.bondOrders).toBe(0);
    expect(live.recentHandoffs.map((f) => f.hash)).toEqual(events.map((e) => e.id));
  });
});

describe('sentinel choreography', () => {
  const report = fixtureLaunch().events.find((e) => e.kind === 'sentinel.score')!.payload as never;
  it('gauge arcs are proportional to max points and tile the ring', () => {
    const g = gaugeSegments(report);
    expect(g.length).toBe(6);
    expect(g[0]!.start).toBe(0);
    expect(g[g.length - 1]!.end).toBeCloseTo(1);
    expect(gaugeSegments(null)).toEqual([]);
  });
  it('phases: seams, then input by input; lock only on pass, broken only on block', () => {
    const p0 = sentinelPhase(report, 0);
    expect(p0.seams).toBe(0);
    expect(p0.done).toBe(false);
    const fin = sentinelPhase(report, Infinity);
    expect(fin.done).toBe(true);
    expect(fin.lock).toBe(0);
    expect(fin.broken).toBe(false);
    const blocked = sentinelPhase({ ...(report as object), passed: false } as never, Infinity);
    expect(blocked.broken).toBe(true);
    expect(sentinelPhase(report, 10).lock).toBeGreaterThan(0);
  });
});

describe('layouts', () => {
  it('molecule shapes respect valence (no agent above 4 bonds)', () => {
    for (const s of ['chain', 'ring', 'diamond'] as const) {
      const L = moleculeLayout(s);
      for (const d of Object.values(degree(L))) expect(d).toBeLessThanOrEqual(4);
    }
  });
  it('hex spiral places cells uniquely', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(hexSpiral(i).join(','));
    expect(seen.size).toBe(200);
    expect(hexSpiral(0)).toEqual([0, 0]);
  });
  it('the nucleus rests above the pedestal; departed neutrons sink into it', () => {
    expect(NUC_CENTER_Y - 0.86 * NUC_SCALE).toBeGreaterThan(-0.5); // nucleus bottom above the pedestal top
    const c12 = chamberTargets('C-12', null);
    const out = c12.filter((t) => t.alpha === 0);
    expect(out.length).toBe(2);
    for (const t of out) expect(t.center[1]).toBeLessThan(0.55 - 0.5); // below the nucleus, toward the pedestal
  });
  it('graphene crystals: one per launch, size grows with the isotope neutron count', () => {
    expect(crystalSize('C-11')).toBeLessThan(crystalSize('C-12'));
    expect(crystalSize('C-12')).toBeLessThan(crystalSize('C-13'));
    expect(crystalSize('C-13')).toBeLessThan(crystalSize('C-14'));
    const l = fixtureLaunches(7);
    const placed = placeCrystals(l);
    expect(placed.length).toBe(7);
    expect(new Set(placed.map((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`)).size).toBe(7); // one cell each
  });
  it('chamber targets are pure and isotope-dependent', () => {
    expect(chamberTargets('C-12', null)).toEqual(chamberTargets('C-12', null));
    expect(chamberTargets('C-14', null)).not.toEqual(chamberTargets('C-12', null));
  });
});
