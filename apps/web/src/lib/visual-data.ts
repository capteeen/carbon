/**
 * Adapters from the web read model (real logged events) to @argon/visual's
 * props. Browser-safe and pure. Nothing here invents a value: anything the log
 * does not contain becomes null / [] and the visuals render their empty states.
 */
import { computeBonds } from '@argon/core/bonds';
import { EMPTY_READOUT, type ArgonEvent, type SplitReceipt } from '@argon/core/contracts';
import {
  buildReplay,
  deriveLive,
  thinkingFromEvents,
  type DaughterView,
  type DecayView as VisualDecayView,
  type LaunchReplay,
  type LaunchSummary as VisualLaunchSummary,
  type LiveStats,
  type ThinkingItem,
} from '@argon/visual';
import type { DecayView } from './launch-view';
import type { LaunchSummary, ReplayData } from './types';

/** A graphene crystal / embed card for a deployed launch, or null if it has not deployed. */
export function toVisualLaunch(s: LaunchSummary): VisualLaunchSummary | null {
  if (!s.ca || !s.deployEventId || !s.ticker || s.deployedAt === null || !s.network) return null;
  return {
    launchId: s.launchId,
    ca: s.ca,
    ticker: s.ticker,
    name: s.name ?? EMPTY_READOUT,
    isotope: s.isotope,
    shape: s.shape,
    heavyAgent: s.heavyAgent,
    deployedAt: s.deployedAt,
    network: s.network,
    deployEventId: s.deployEventId,
    collapsed: s.collapsed,
  };
}

export function toVisualLaunches(list: readonly LaunchSummary[]): VisualLaunchSummary[] {
  const out: VisualLaunchSummary[] = [];
  for (const s of list) {
    const v = toVisualLaunch(s);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Chapter 08: the most recent real deployed launch, replayed from its own log.
 * Bond orders are core's, recomputed at the deploy time.
 */
export function toVisualReplay(r: ReplayData | null): LaunchReplay | null {
  if (!r) return null;
  const dep = r.events.find((e) => e.kind === 'launch.deployed');
  if (!dep) return null;
  return buildReplay(r.events, computeBonds(r.events, dep.ts));
}

/** Complete per-launch event logs held by the home page (launchId → full log, seq order). */
export type LaunchLogs = ReadonlyMap<string, readonly ArgonEvent[]>;

/** The launch of the most recent hand-off (highest seq) across the given seq-ordered lists, or null. */
export function lastHandoffLaunch(...lists: (readonly ArgonEvent[])[]): string | null {
  let best: ArgonEvent | null = null;
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (e.kind !== 'handoff') continue;
      if (!best || e.seq > best.seq) best = e;
      break; // seq-ordered: the last hand-off is this list's newest
    }
  }
  return best?.launchId ?? null;
}

/**
 * Home HUD stats (chapter 03).
 * LOAD: hand-offs per minute per agent across every launch in the global stream
 * (agents serve all launches).
 * BONDS: ONE molecule, named in the HUD: the launch that most recently handed
 * off. Its bond orders are core's computeBonds over that launch's COMPLETE log
 * (from `logs`), evaluated at display time `now`, never over the global window.
 * If that launch's full log is not loaded yet the BONDS readout is unknown
 * ("--.--"), not a count from a partial slice.
 */
export function liveFromLogs(window: readonly ArgonEvent[], logs: LaunchLogs, now: number): LiveStats | null {
  const active = lastHandoffLaunch(window, ...logs.values());
  const log = active ? logs.get(active) : undefined;
  const at = Math.max(now, lastTs(window), log ? lastTs(log) : 0);
  const bonds = log ? computeBonds(log, at) : null;
  // the molecule's own recent hand-offs reach the LOAD/seam readouts even if the window lost them
  const forLoad = log ? mergeBySeq(window, log.filter((e) => e.kind === 'handoff')) : window;
  const molecule = active ? { launchId: active, ticker: tickerOf(log ?? window.filter((e) => e.launchId === active)) } : null;
  return deriveLive(forLoad, bonds, at, molecule);
}

function lastTs(events: readonly ArgonEvent[]): number {
  return events.length ? events[events.length - 1]!.ts : 0;
}

function tickerOf(events: readonly ArgonEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'forge.draft') return (e as ArgonEvent<'forge.draft'>).payload.ticker;
  }
  return null;
}

function mergeBySeq(a: readonly ArgonEvent[], b: readonly ArgonEvent[]): ArgonEvent[] {
  const m = new Map<number, ArgonEvent>();
  for (const e of a) m.set(e.seq, e);
  for (const e of b) m.set(e.seq, e);
  return [...m.values()].sort((x, y) => x.seq - y.seq);
}

/**
 * Folds newly streamed events into the complete logs we hold (only launches
 * whose full log was loaded). Returns the same map when nothing changed.
 */
export function foldIntoLogs(logs: ReadonlyMap<string, ArgonEvent[]>, incoming: readonly ArgonEvent[]): ReadonlyMap<string, ArgonEvent[]> {
  let next: Map<string, ArgonEvent[]> | null = null;
  for (const [id, log] of logs) {
    const tail = log.length ? log[log.length - 1]!.seq : 0;
    const add = incoming.filter((e) => e.launchId === id && e.seq > tail);
    if (!add.length) continue;
    next ??= new Map(logs);
    next.set(id, mergeBySeq(log, add));
  }
  return next ?? logs;
}

export function feedFromEvents(events: readonly ArgonEvent[]): ThinkingItem[] {
  return thinkingFromEvents(events, 8);
}

export function receiptsFromEvents(events: readonly ArgonEvent[]): SplitReceipt[] {
  return events.filter((e): e is ArgonEvent<'split.receipt'> => e.kind === 'split.receipt').map((e) => e.payload);
}

/**
 * Decay dimming for the launch scene. Clock rule: from decay.started to its
 * collapseAt. Quiet rule: the last-trade time is not in the log, so no
 * countdown is drawn until it collapses. Collapsed: fully dimmed, tied to the event id.
 */
export function toVisualDecay(events: readonly ArgonEvent[], d: DecayView): VisualDecayView | null {
  if (d.rule === 'none') return null;
  const started = d.startedEventId ? events.find((e) => e.id === d.startedEventId) : undefined;
  if (d.collapsed) {
    return { kind: d.rule, startedAt: started?.ts ?? d.collapsed.ts, deadline: d.collapsed.payload.at, collapsedEventId: d.collapsed.id };
  }
  if (d.rule === 'clock' && started && d.collapseAt !== null) {
    return { kind: 'clock', startedAt: started.ts, deadline: d.collapseAt, collapsedEventId: null };
  }
  return null;
}

export function toVisualDaughter(d: DecayView): DaughterView | null {
  return d.daughter ? { eventId: d.daughter.id, daughterCa: d.daughter.payload.daughterCa } : null;
}
