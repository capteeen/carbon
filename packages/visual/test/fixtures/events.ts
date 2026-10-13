/**
 * TEST DOUBLES ONLY. Never imported from src/. Deterministic, clearly fake
 * event logs used by unit tests and by the perf harness (?fixture=1), which
 * shows a "TEST FIXTURE" banner whenever these are on screen.
 */
import {
  AGENT_IDS,
  SHAPES,
  pairKey,
  type AgentId,
  type Bond,
  type ArgonEvent,
  type EventKind,
  type EventPayloads,
  type IsotopeId,
  type ShapeId,
} from '@argon/core/contracts';
import type { LaunchSummary, LiveStats } from '../../src/types.js';

/** 64-hex id derived from a seed string (format-compatible with sha256 ids; NOT a real hash). */
export function fakeId(seed: string): string {
  let out = '';
  let h = 0x811c9dc5;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + round * 131;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

let seq = 0;
export function ev<K extends EventKind>(launchId: string, kind: K, actor: ArgonEvent['actor'], payload: EventPayloads[K], ts: number): ArgonEvent<K> {
  seq++;
  return { id: fakeId(`${launchId}:${seq}:${kind}`), seq, launchId, ts, kind, actor, payload, signer: 'fixture', sig: 'fixture' };
}

export interface FixtureLaunch {
  events: ArgonEvent[];
  bonds: Bond[];
}

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

export function fixtureLaunch(opts: { launchId?: string; isotope?: IsotopeId; shape?: ShapeId; heavy?: AgentId | null; ticker?: string; handoffs?: number; t0?: number } = {}): FixtureLaunch {
  const id = opts.launchId ?? 'fixture-launch-1';
  const shape = opts.shape ?? 'ring';
  const isotope = opts.isotope ?? 'Ar-40';
  const heavy = isotope === 'Ar-40' ? (opts.heavy ?? 'herald') : null;
  const t0 = opts.t0 ?? T0;
  const events: ArgonEvent[] = [];
  events.push(ev(id, 'launch.created', 'user', { line: 'fixture line', isotope, shape, heavyAgent: heavy, launcherWallet: 'FixtureWallet1111', xConnected: false }, t0));
  const topo = SHAPES[shape].topology;
  const n = opts.handoffs ?? 18;
  for (let i = 0; i < n; i++) {
    const [a, b] = topo[i % topo.length]!.split('|') as [AgentId, AgentId];
    const h = ev(id, 'handoff', a, { from: a, to: b, topic: 'fixture', summary: `fixture hand-off ${i}` }, t0 + 1000 + i * 1500);
    events.push(h);
    events.push(ev(id, 'reasoning', a, { agent: a, forEventId: h.id, text: `fixture reasoning ${i}` }, t0 + 1100 + i * 1500));
  }
  const ticker = opts.ticker ?? 'FIXT';
  events.push(ev(id, 'forge.draft', 'forge', { name: 'Fixture Coin', ticker, lore: 'fixture', logoUri: 'about:blank', logoHash: '0', bannerUri: 'about:blank', siteUri: 'about:blank' }, t0 + 40_000));
  events.push(
    ev(
      id,
      'sentinel.score',
      'sentinel',
      {
        score: 78,
        threshold: SHAPES[shape].sentinelThreshold,
        inputs: [
          { key: 'collision', points: 18, max: 20, reason: 'fixture', hardFail: false },
          { key: 'logo', points: 15, max: 20, reason: 'fixture', hardFail: false },
          { key: 'wallet', points: 10, max: 15, reason: 'fixture', hardFail: false },
          { key: 'sniper', points: 10, max: 15, reason: 'fixture', hardFail: false },
          { key: 'freshness', points: 10, max: 15, reason: 'fixture', hardFail: false },
          { key: 'content', points: 15, max: 15, reason: 'fixture', hardFail: false },
        ],
        hardFail: false,
        passed: 78 >= SHAPES[shape].sentinelThreshold,
        run: 1,
      },
      t0 + 45_000,
    ),
  );
  events.push(ev(id, 'launch.deployed', 'system', { ca: `Fixture${id.replace(/[^a-z0-9]/gi, '')}CaPump`, txSig: 'fixtureTx', creatorWallet: 'FixtureCreator', devBuySol: 0.25, network: 'devnet' }, t0 + 60_000));
  // stand-in for core's bond calculator (test double): count hand-offs per pair
  const counts = new Map<string, { n: number; last: string }>();
  for (const e of events) {
    if (e.kind !== 'handoff') continue;
    const p = e.payload as EventPayloads['handoff'];
    const k = pairKey(p.from, p.to);
    const c = counts.get(k) ?? { n: 0, last: '' };
    c.n++;
    c.last = e.id;
    counts.set(k, c);
  }
  const bonds: Bond[] = [...counts.entries()].map(([k, c]) => ({ pair: k as Bond['pair'], order: c.n >= 8 ? 3 : c.n >= 3 ? 2 : 1, exchanges: c.n, lastHash: c.last }));
  return { events, bonds };
}

export function fixtureLaunches(n: number): LaunchSummary[] {
  const isos: IsotopeId[] = ['Ar-41', 'Ar-36', 'Ar-40', 'Ar-39'];
  const shapes: ShapeId[] = ['chain', 'ring', 'diamond'];
  return Array.from({ length: n }, (_, i) => ({
    launchId: `fixture-${i}`,
    ca: `FixtureCa${String(i).padStart(4, '0')}pump`,
    ticker: `FX${i}`,
    name: `Fixture ${i}`,
    isotope: isos[i % 4]!,
    shape: shapes[i % 3]!,
    heavyAgent: i % 4 === 2 ? AGENT_IDS[i % 6]! : null,
    deployedAt: T0 + i * 3_600_000,
    network: 'devnet' as const,
    deployEventId: fakeId(`deploy-${i}`),
    collapsed: i % 9 === 4,
  }));
}

export function fixtureLive(): LiveStats {
  const now = T0 + 120_000;
  return {
    asOf: now,
    molecule: { launchId: 'fixture-launch', ticker: 'FIXT' },
    agents: Object.fromEntries(AGENT_IDS.map((a, i) => [a, { bondOrders: (i % 4) + 1, load: 10 + i * 3.25, loadDelta: i - 2.5 }])),
    recentHandoffs: [
      { pairKey: pairKey('scout', 'forge'), hash: fakeId('h1'), at: now - 3000 },
      { pairKey: pairKey('forge', 'sentinel'), hash: fakeId('h2'), at: now - 2000 },
      { pairKey: pairKey('herald', 'keeper'), hash: fakeId('h3'), at: now - 1000 },
    ],
  };
}
