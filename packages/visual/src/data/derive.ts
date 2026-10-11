/**
 * Pure derivations from the real event log into view models. Nothing here
 * invents data: inputs without real event ids are dropped, and missing data
 * yields null / empty arrays so the UI renders its honest empty state.
 *
 * Bond ORDERS are never recomputed here: they come from core's Bond[]
 * (Handoffs.bonds), so the displayed order always equals core's recomputation.
 */
import {
  AGENT_IDS,
  BOND_WINDOW_MS,
  ISOTOPE_IDS,
  SHAPE_IDS,
  pairKey,
  type AgentId,
  type Bond,
  type CarbonEvent,
  type PairKey,
} from '@carbon/core/contracts';
import { isEventId } from '../hud/format.js';
import type { AgentLiveStats, BondFlash, LaunchReplay, LaunchSummary, LiveStats, ThinkingItem } from '../types.js';

function isKind<K extends CarbonEvent['kind']>(e: CarbonEvent, k: K): e is CarbonEvent<K> {
  return e.kind === k;
}

function bySeq(a: CarbonEvent, b: CarbonEvent): number {
  return a.seq - b.seq;
}

/** Only events with real ids (sha256 hex) are ever drawn. */
export function realEvents(events: readonly CarbonEvent[] | null | undefined): CarbonEvent[] {
  if (!events) return [];
  return events.filter((e) => e && isEventId(e.id)).sort(bySeq);
}

/** Bond flashes from logged hand-off events. */
export function flashesFromEvents(events: readonly CarbonEvent[] | null | undefined): BondFlash[] {
  const out: BondFlash[] = [];
  for (const e of realEvents(events)) {
    if (!isKind(e, 'handoff')) continue;
    const { from, to } = e.payload;
    if (!AGENT_IDS.includes(from) || !AGENT_IDS.includes(to) || from === to) continue;
    out.push({ pairKey: pairKey(from, to), hash: e.id, at: e.ts });
  }
  return out;
}

/** Drops flashes that do not carry a real event id. */
export function validFlashes(flashes: readonly BondFlash[] | null | undefined): BondFlash[] {
  if (!flashes) return [];
  return flashes.filter((f) => f && isEventId(f.hash) && Number.isFinite(f.at) && isPairKey(f.pairKey));
}

/** Drops bonds that are not backed by a real hand-off id; order-0 bonds are dropped too (nothing to draw). */
export function validBonds(bonds: readonly Bond[] | null | undefined): Bond[] {
  if (!bonds) return [];
  return bonds.filter((b) => b && b.order > 0 && b.order <= 3 && isEventId(b.lastHash) && isPairKey(b.pair));
}

export function isPairKey(k: unknown): k is PairKey {
  if (typeof k !== 'string') return false;
  const [a, b] = k.split('|');
  return AGENT_IDS.includes(a as AgentId) && AGENT_IDS.includes(b as AgentId) && a !== b;
}

export function pairAgents(k: PairKey): [AgentId, AgentId] {
  const [a, b] = k.split('|') as [AgentId, AgentId];
  return [a, b];
}

/**
 * Live HUD stats from real events and core's bonds.
 * load = hand-offs per minute involving the agent in the last BOND_WINDOW_MS,
 * loadDelta = load minus the previous window's load.
 * Returns null when there is nothing real to show.
 */
export function deriveLive(
  events: readonly CarbonEvent[] | null | undefined,
  bonds: readonly Bond[] | null | undefined,
  now?: number,
): LiveStats | null {
  const evs = realEvents(events);
  const bs = validBonds(bonds);
  const handoffs = evs.filter((e): e is CarbonEvent<'handoff'> => isKind(e, 'handoff'));
  if (handoffs.length === 0 && bs.length === 0) return null;
  const t = now ?? (evs.length ? evs[evs.length - 1]!.ts : Date.now());
  const perMin = 60_000 / BOND_WINDOW_MS;
  const agents: Partial<Record<AgentId, AgentLiveStats>> = {};
  for (const a of AGENT_IDS) {
    let cur = 0;
    let prev = 0;
    for (const h of handoffs) {
      if (h.payload.from !== a && h.payload.to !== a) continue;
      const age = t - h.ts;
      if (age >= 0 && age < BOND_WINDOW_MS) cur++;
      else if (age >= BOND_WINDOW_MS && age < 2 * BOND_WINDOW_MS) prev++;
    }
    let orders = 0;
    for (const b of bs) {
      const [x, y] = pairAgents(b.pair);
      if (x === a || y === a) orders += b.order;
    }
    agents[a] = { bondOrders: orders, load: cur * perMin, loadDelta: (cur - prev) * perMin };
  }
  const recentHandoffs = flashesFromEvents(handoffs).slice(-12);
  return { asOf: t, agents, recentHandoffs };
}

/** Builds the chapter 08 replay from a launch's full event log, or null if it never deployed. */
export function buildReplay(events: readonly CarbonEvent[] | null | undefined, bondsAtDeploy?: readonly Bond[] | null): LaunchReplay | null {
  const evs = realEvents(events);
  const created = evs.find((e): e is CarbonEvent<'launch.created'> => isKind(e, 'launch.created'));
  const deployed = evs.find((e): e is CarbonEvent<'launch.deployed'> => isKind(e, 'launch.deployed'));
  if (!created || !deployed) return null;
  const draft = [...evs].reverse().find((e): e is CarbonEvent<'forge.draft'> => isKind(e, 'forge.draft') && e.seq < deployed.seq);
  if (!draft) return null;
  const scoreEv = [...evs].reverse().find((e): e is CarbonEvent<'sentinel.score'> => isKind(e, 'sentinel.score') && e.seq < deployed.seq);
  const p = created.payload;
  if (!ISOTOPE_IDS.includes(p.isotope) || !SHAPE_IDS.includes(p.shape)) return null;
  return {
    launchId: created.launchId,
    ticker: draft.payload.ticker,
    name: draft.payload.name,
    ca: deployed.payload.ca,
    deployedAt: deployed.ts,
    deployEventId: deployed.id,
    isotope: p.isotope,
    shape: p.shape,
    heavyAgent: p.heavyAgent,
    network: deployed.payload.network,
    score: scoreEv ? scoreEv.payload : null,
    handoffs: evs.filter((e): e is CarbonEvent<'handoff'> => isKind(e, 'handoff') && e.seq <= deployed.seq),
    bondsAtDeploy: validBonds(bondsAtDeploy),
  };
}

/** A replay is drawable only if it carries real ids and a CA. */
export function isValidReplay(r: LaunchReplay | null | undefined): r is LaunchReplay {
  return (
    !!r &&
    typeof r.ca === 'string' &&
    r.ca.length > 0 &&
    typeof r.ticker === 'string' &&
    r.ticker.length > 0 &&
    Number.isFinite(r.deployedAt) &&
    isEventId(r.deployEventId) &&
    ISOTOPE_IDS.includes(r.isotope) &&
    SHAPE_IDS.includes(r.shape) &&
    Array.isArray(r.handoffs) &&
    r.handoffs.every((h) => isEventId(h.id))
  );
}

/** Graphene crystal for one launch's events, or null if it has not deployed. */
export function launchSummaryFromEvents(events: readonly CarbonEvent[] | null | undefined): LaunchSummary | null {
  const r = buildReplay(events);
  if (!r) return null;
  const collapsed = realEvents(events).some((e) => e.kind === 'decay.collapsed');
  return {
    launchId: r.launchId,
    ca: r.ca,
    ticker: r.ticker,
    name: r.name,
    isotope: r.isotope,
    shape: r.shape,
    heavyAgent: r.heavyAgent,
    deployedAt: r.deployedAt,
    network: r.network,
    deployEventId: r.deployEventId,
    collapsed,
  };
}

export function validLaunches(launches: readonly LaunchSummary[] | null | undefined): LaunchSummary[] {
  if (!launches) return [];
  return launches
    .filter(
      (l) =>
        l &&
        isEventId(l.deployEventId) &&
        typeof l.ca === 'string' &&
        l.ca.length > 0 &&
        ISOTOPE_IDS.includes(l.isotope) &&
        SHAPE_IDS.includes(l.shape) &&
        Number.isFinite(l.deployedAt),
    )
    .sort((a, b) => a.deployedAt - b.deployedAt || (a.ca < b.ca ? -1 : 1));
}

/** "agent reasoning" feed items from logged reasoning events. */
export function thinkingFromEvents(events: readonly CarbonEvent[] | null | undefined, limit = 8): ThinkingItem[] {
  return realEvents(events)
    .filter((e): e is CarbonEvent<'reasoning'> => isKind(e, 'reasoning'))
    .slice(-limit)
    .map((e) => ({ eventId: e.id, agent: e.payload.agent, text: e.payload.text, ts: e.ts }));
}

/** Latest Sentinel report in a log. */
export function latestSentinel(events: readonly CarbonEvent[] | null | undefined): { report: CarbonEvent<'sentinel.score'>['payload']; eventId: string } | null {
  const evs = realEvents(events);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]!;
    if (isKind(e, 'sentinel.score')) return { report: e.payload, eventId: e.id };
  }
  return null;
}

/** Stable 32-bit hash of a string (FNV-1a), for deterministic placement only. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
