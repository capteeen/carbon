/**
 * Bond calculator. PURE: depends only on the event log and a time. This is THE
 * function the UI uses to display bond orders, and the function Handoffs uses to
 * enforce valence, so displayed order always equals the order recomputed from the log.
 * Browser-safe (imports only contracts).
 *
 * Rules (SPEC §1):
 * - Rolling window: a hand-off counts at time `at` when at - BOND_WINDOW_MS < ts <= at.
 * - Order per undirected pair: 1 if >= 1 hand-off, 2 if >= 3, 3 if >= 8,
 *   or 3 if the pair has >= 1 hand-off in the window AND both agents are blocked on
 *   each other (agent.blocked A→B and B→A, neither followed by agent.unblocked by `at`).
 * - lastHash = id of the most recent counted hand-off on the pair.
 * - Valence: an agent's total bond order across all bonds is <= VALENCE (4).
 *
 * Valence is enforced in the replay itself, so computeBonds never reports > 4 for
 * any agent even for a log written by something that bypassed Handoffs:
 * - an event whose ts is earlier than the previous event's ts in seq order is ignored
 *   (the bus never writes one; only a writer that bypassed it could);
 * - a `handoff` counts only if it was ACCEPTED: it passes the payload checks (from≠to,
 *   actor === from, pair in the launch's shape topology when launch.created is in the
 *   log) and, at its own ts, counting it would keep both agents' total order <= 4;
 * - a mutual-block upgrade to triple is applied (pairs in canonical order) only if
 *   it keeps both agents' totals <= 4; otherwise the pair keeps its traffic order.
 */
import {
  AGENT_IDS,
  BOND_WINDOW_MS,
  SHAPES,
  VALENCE,
  pairKey,
  type AgentId,
  type Bond,
  type BondOrder,
  type CarbonEvent,
  type EventPayloads,
  type PairKey,
} from './contracts.js';

export const ALL_PAIR_KEYS: readonly PairKey[] = AGENT_IDS.flatMap((a, i) => AGENT_IDS.slice(i + 1).map((b) => pairKey(a, b)));

const isAgent = (x: unknown): x is AgentId => typeof x === 'string' && (AGENT_IDS as readonly string[]).includes(x);

/** Order from traffic alone (no block rule). */
export function orderFromExchanges(exchanges: number): BondOrder {
  if (exchanges >= 8) return 3;
  if (exchanges >= 3) return 2;
  if (exchanges >= 1) return 1;
  return 0;
}

export interface BondAnalysis {
  /** Bonds with order >= 1, in canonical pair order. */
  bonds: Bond[];
  /** Each agent's total bond order (always <= VALENCE). */
  totals: Record<AgentId, number>;
  /** Hand-off ids counted toward bonds (all time up to `at`). */
  acceptedHandoffIds: string[];
  /** Hand-off events in the log that were NOT counted, with the reason. */
  ignoredHandoffs: { id: string; reason: string }[];
  /** Pairs currently blocked on each other (both directions active at `at`). */
  mutualBlocks: PairKey[];
  at: number;
}

interface Accepted {
  id: string;
  pair: PairKey;
  ts: number;
}

function zeroTotals(): Record<AgentId, number> {
  return Object.fromEntries(AGENT_IDS.map((a) => [a, 0])) as Record<AgentId, number>;
}

function splitPair(p: PairKey): [AgentId, AgentId] {
  return p.split('|') as [AgentId, AgentId];
}

/** Traffic per pair in the window ending at t. */
function windowCounts(accepted: readonly Accepted[], t: number): Map<PairKey, { n: number; last: Accepted }> {
  const m = new Map<PairKey, { n: number; last: Accepted }>();
  const from = t - BOND_WINDOW_MS;
  for (const h of accepted) {
    if (h.ts <= from || h.ts > t) continue;
    const cur = m.get(h.pair);
    if (cur) {
      cur.n += 1;
      cur.last = h; // accepted is in seq order, so the later one is the most recent
    } else m.set(h.pair, { n: 1, last: h });
  }
  return m;
}

function rawTotals(counts: Map<PairKey, { n: number }>): Record<AgentId, number> {
  const totals = zeroTotals();
  for (const [p, { n }] of counts) {
    const o = orderFromExchanges(n);
    const [a, b] = splitPair(p);
    totals[a] += o;
    totals[b] += o;
  }
  return totals;
}

function validateHandoff(e: CarbonEvent, topology: ReadonlySet<PairKey> | null): { pair: PairKey } | { reason: string } {
  const p = e.payload as EventPayloads['handoff'];
  if (!p || !isAgent(p.from) || !isAgent(p.to)) return { reason: 'malformed payload' };
  if (p.from === p.to) return { reason: 'self hand-off' };
  if (e.actor !== p.from) return { reason: 'actor is not the sender' };
  const pair = pairKey(p.from, p.to);
  if (topology && !topology.has(pair)) return { reason: `pair ${pair} not in shape topology` };
  return { pair };
}

/** Full analysis of one launch's log at time `at` (default: the last event's ts). */
export function analyzeBonds(events: readonly CarbonEvent[], at?: number): BondAnalysis {
  const sorted = [...events].sort((x, y) => x.seq - y.seq);
  const launchIds = new Set(sorted.map((e) => e.launchId));
  if (launchIds.size > 1) throw new Error('computeBonds expects the events of exactly one launch');
  const t = at ?? (sorted.length ? sorted[sorted.length - 1]!.ts : 0);

  let topology: Set<PairKey> | null = null;
  const blocked = new Map<string, boolean>(); // `${agent}>${on}`
  const accepted: Accepted[] = [];
  const ignored: { id: string; reason: string }[] = [];

  // The bus appends with non-decreasing ts in seq order. A row that breaks that (written
  // around the bus, e.g. raw SQL) is not trusted: its ts would let it be judged against a
  // window it was never in (AG-012). Valence is checked at each accepted event's own ts
  // against the state at its seq.
  let floor = -Infinity;
  for (const e of sorted) {
    if (e.ts < floor) {
      if (e.kind === 'handoff') ignored.push({ id: e.id, reason: 'ts earlier than its predecessor in seq order' });
      continue;
    }
    if (e.ts > t) break; // the log as it stood at `at` (every later trusted event has ts >= this one)
    floor = e.ts;
    switch (e.kind) {
      case 'launch.created': {
        const p = e.payload as EventPayloads['launch.created'];
        if (topology === null && p && p.shape in SHAPES) topology = new Set(SHAPES[p.shape].topology);
        break;
      }
      case 'agent.blocked': {
        const p = e.payload as EventPayloads['agent.blocked'];
        if (isAgent(p?.agent) && isAgent(p?.on) && p.agent !== p.on) blocked.set(`${p.agent}>${p.on}`, true);
        break;
      }
      case 'agent.unblocked': {
        const p = e.payload as EventPayloads['agent.unblocked'];
        if (isAgent(p?.agent) && isAgent(p?.on)) blocked.set(`${p.agent}>${p.on}`, false);
        break;
      }
      case 'handoff': {
        const v = validateHandoff(e, topology);
        if ('reason' in v) {
          ignored.push({ id: e.id, reason: v.reason });
          break;
        }
        const candidate: Accepted = { id: e.id, pair: v.pair, ts: e.ts };
        const totals = rawTotals(windowCounts([...accepted, candidate], e.ts));
        const [a, b] = splitPair(v.pair);
        if (totals[a] > VALENCE || totals[b] > VALENCE) {
          ignored.push({ id: e.id, reason: `valence: would exceed ${VALENCE}` });
          break;
        }
        accepted.push(candidate);
        break;
      }
      default:
        break;
    }
  }

  const counts = windowCounts(accepted, t);
  const orders = new Map<PairKey, BondOrder>();
  for (const [p, { n }] of counts) orders.set(p, orderFromExchanges(n));
  const totals = rawTotals(counts);

  // Mutual-block upgrades, canonical pair order, only when they fit the valence.
  const mutualBlocks: PairKey[] = [];
  for (const p of ALL_PAIR_KEYS) {
    const [a, b] = splitPair(p);
    if (!(blocked.get(`${a}>${b}`) && blocked.get(`${b}>${a}`))) continue;
    mutualBlocks.push(p);
    const cur = orders.get(p);
    if (!cur || cur === 3) continue; // needs >= 1 hand-off in the window
    const delta = 3 - cur;
    if (totals[a] + delta <= VALENCE && totals[b] + delta <= VALENCE) {
      orders.set(p, 3);
      totals[a] += delta;
      totals[b] += delta;
    }
  }

  const bonds: Bond[] = [];
  for (const p of ALL_PAIR_KEYS) {
    const c = counts.get(p);
    const order = orders.get(p);
    if (!c || !order) continue;
    bonds.push({ pair: p, order, exchanges: c.n, lastHash: c.last.id });
  }
  return { bonds, totals, acceptedHandoffIds: accepted.map((h) => h.id), ignoredHandoffs: ignored, mutualBlocks, at: t };
}

/** Bonds of one launch at time `at` (default: last event's ts). THE display function. */
export function computeBonds(events: readonly CarbonEvent[], at?: number): Bond[] {
  return analyzeBonds(events, at).bonds;
}

/** Each agent's total bond order, e.g. for the HUD "BONDS 3/4". */
export function bondTotals(events: readonly CarbonEvent[], at?: number): Record<AgentId, number> {
  return analyzeBonds(events, at).totals;
}

/**
 * Would a hand-off from→to appended at `ts` be accepted by computeBonds?
 * Simulates it against the log; used by Handoffs.send before appending.
 */
export function handoffFits(
  events: readonly CarbonEvent[],
  from: AgentId,
  to: AgentId,
  ts: number,
): { fits: true } | { fits: false; reason: string } {
  const sorted = [...events].sort((x, y) => x.seq - y.seq);
  const last = sorted[sorted.length - 1];
  const probe: CarbonEvent<'handoff'> = {
    id: 'probe',
    seq: (last?.seq ?? 0) + 1,
    launchId: last?.launchId ?? 'probe',
    ts: Math.max(ts, last?.ts ?? 0),
    kind: 'handoff',
    actor: from,
    payload: { from, to, topic: 'probe', summary: 'probe' },
    signer: '',
    sig: '',
  };
  const a = analyzeBonds([...sorted, probe], probe.ts);
  const ig = a.ignoredHandoffs.find((i) => i.id === 'probe');
  return ig ? { fits: false, reason: ig.reason } : { fits: true };
}
