/**
 * Adapters from the web read model (real logged events) to @carbon/visual's
 * props. Browser-safe and pure. Nothing here invents a value: anything the log
 * does not contain becomes null / [] and the visuals render their empty states.
 */
import { computeBonds } from '@carbon/core/bonds';
import { EMPTY_READOUT, type CarbonEvent, type SplitReceipt } from '@carbon/core/contracts';
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
} from '@carbon/visual';
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

/**
 * Live HUD stats from the global event window.
 * LOAD: hand-offs per minute per agent across every launch (agents serve all of them).
 * BONDS: core's bond orders in the molecule that most recently handed off (one
 * molecule, so a count never exceeds valence).
 */
export function liveFromEvents(events: readonly CarbonEvent[], now: number | null): LiveStats | null {
  let lastLaunch: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'handoff') {
      lastLaunch = events[i]!.launchId;
      break;
    }
  }
  const at = now ?? undefined;
  const bonds = lastLaunch ? computeBonds(events.filter((e) => e.launchId === lastLaunch), at) : [];
  return deriveLive(events, bonds, at);
}

export function feedFromEvents(events: readonly CarbonEvent[]): ThinkingItem[] {
  return thinkingFromEvents(events, 8);
}

export function receiptsFromEvents(events: readonly CarbonEvent[]): SplitReceipt[] {
  return events.filter((e): e is CarbonEvent<'split.receipt'> => e.kind === 'split.receipt').map((e) => e.payload);
}

/**
 * Decay dimming for the launch scene. Clock rule: from decay.started to its
 * collapseAt. Quiet rule: the last-trade time is not in the log, so no
 * countdown is drawn until it collapses. Collapsed: fully dimmed, tied to the event id.
 */
export function toVisualDecay(events: readonly CarbonEvent[], d: DecayView): VisualDecayView | null {
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
