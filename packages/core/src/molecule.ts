/**
 * Molecule (launch) state machine. State is a PURE fold over the launch's events,
 * so replaying a recorded log yields the identical state and history.
 * Browser-safe (imports only contracts).
 *
 *   draft → scouting → forging → checking → awaiting_approval → deploying → live → (decaying →) collapsed
 *   checking → blocked (Sentinel below threshold or hard fail); blocked → checking on a revised forge.draft
 *   deploying → failed (an `error` event while deploying)
 *
 * Transitions (the event that causes each):
 *   (none)            → draft              launch.created
 *   draft             → scouting           first event whose actor is 'scout'
 *   scouting          → forging            scout.proposals
 *   forging|blocked   → checking           forge.draft
 *   checking          → awaiting_approval  sentinel.score with passed && !hardFail
 *   checking          → blocked            sentinel.score otherwise
 *   awaiting_approval → deploying          approval.granted for an approval.requested with action 'launch'
 *                                          (never via autopilot: such a grant is ignored)
 *   awaiting_approval → forging            approval.rejected for the launch approval (revise)
 *   deploying         → live               launch.deployed
 *   deploying         → failed             error
 *   live              → decaying           holders.snapshot on an unstable isotope (C-11/C-14): the decay
 *                                          watcher snapshots holders when collapse is due
 *   live|decaying     → collapsed          decay.collapsed (unstable isotopes only)
 * Any other event leaves the state unchanged (recorded in `ignored` when it was a transition kind).
 */
import { ISOTOPES, launchConfig, type CarbonEvent, type EventPayloads, type LaunchConfig } from './contracts.js';

export const MOLECULE_STATES = [
  'draft',
  'scouting',
  'forging',
  'checking',
  'awaiting_approval',
  'deploying',
  'live',
  'decaying',
  'collapsed',
  'blocked',
  'failed',
] as const;
export type MoleculeState = (typeof MOLECULE_STATES)[number];

export interface MoleculeSnapshot {
  launchId: string | null;
  state: MoleculeState | null;
  config: LaunchConfig | null;
  /** Pending approval id for the launch, once requested. */
  launchApprovalId: string | null;
  ca: string | null;
  lastScore: EventPayloads['sentinel.score'] | null;
  history: { state: MoleculeState; eventId: string; seq: number; ts: number }[];
  ignored: { eventId: string; kind: string; state: MoleculeState | null }[];
}

export function initialMolecule(): MoleculeSnapshot {
  return { launchId: null, state: null, config: null, launchApprovalId: null, ca: null, lastScore: null, history: [], ignored: [] };
}

const TRANSITION_KINDS = new Set<string>([
  'launch.created',
  'scout.proposals',
  'forge.draft',
  'sentinel.score',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'launch.deployed',
  'holders.snapshot',
  'decay.collapsed',
  'error',
]);

/** One step of the fold. Returns a new snapshot (never mutates `s`). */
export function stepMolecule(s: MoleculeSnapshot, e: CarbonEvent): MoleculeSnapshot {
  if (s.launchId !== null && e.launchId !== s.launchId) return s;
  const next = (state: MoleculeState, patch: Partial<MoleculeSnapshot> = {}): MoleculeSnapshot => ({
    ...s,
    ...patch,
    state,
    history: [...s.history, { state, eventId: e.id, seq: e.seq, ts: e.ts }],
  });
  const ignore = (): MoleculeSnapshot =>
    TRANSITION_KINDS.has(e.kind) ? { ...s, ignored: [...s.ignored, { eventId: e.id, kind: e.kind, state: s.state }] } : s;

  if (s.state === null) {
    if (e.kind !== 'launch.created') return ignore();
    const p = e.payload as EventPayloads['launch.created'];
    let config: LaunchConfig;
    try {
      config = launchConfig(p.isotope, p.shape, p.heavyAgent);
    } catch {
      return ignore();
    }
    return next('draft', { launchId: e.launchId, config });
  }

  const unstable = s.config ? !ISOTOPES[s.config.isotope].stable : false;

  if (e.kind === 'approval.requested') {
    const p = e.payload as EventPayloads['approval.requested'];
    if (p.action === 'launch' && (s.state === 'checking' || s.state === 'awaiting_approval')) {
      return { ...s, launchApprovalId: p.approvalId };
    }
    return s;
  }

  switch (s.state) {
    case 'draft':
      if (e.actor === 'scout') {
        const sc = next('scouting');
        // The same event may also complete scouting.
        return e.kind === 'scout.proposals' ? stepMolecule(sc, e) : sc;
      }
      return ignore();
    case 'scouting':
      return e.kind === 'scout.proposals' ? next('forging') : ignore();
    case 'forging':
    case 'blocked':
      return e.kind === 'forge.draft' ? next('checking', { launchApprovalId: null }) : ignore();
    case 'checking':
      if (e.kind === 'sentinel.score') {
        const r = e.payload as EventPayloads['sentinel.score'];
        const ok = r.passed === true && r.hardFail !== true && r.score >= r.threshold;
        return next(ok ? 'awaiting_approval' : 'blocked', { lastScore: r });
      }
      if (e.kind === 'forge.draft') return next('checking', { launchApprovalId: null }); // a revision restarts the check
      return ignore();
    case 'awaiting_approval': {
      if (e.kind === 'approval.granted') {
        const p = e.payload as EventPayloads['approval.granted'];
        if (p.approvalId !== s.launchApprovalId || p.viaAutopilot) return ignore();
        return next('deploying');
      }
      if (e.kind === 'approval.rejected') {
        const p = e.payload as EventPayloads['approval.rejected'];
        if (p.approvalId !== s.launchApprovalId) return s;
        return next('forging', { launchApprovalId: null });
      }
      return ignore();
    }
    case 'deploying':
      if (e.kind === 'launch.deployed') return next('live', { ca: (e.payload as EventPayloads['launch.deployed']).ca });
      if (e.kind === 'error') return next('failed');
      return ignore();
    case 'live':
      if (unstable && e.kind === 'holders.snapshot') return next('decaying');
      if (unstable && e.kind === 'decay.collapsed') return next('collapsed');
      return ignore();
    case 'decaying':
      return e.kind === 'decay.collapsed' ? next('collapsed') : ignore();
    case 'collapsed':
    case 'failed':
      return ignore();
  }
}

/** State of one launch: a pure fold over its events in seq order. */
export function foldMolecule(events: readonly CarbonEvent[]): MoleculeSnapshot {
  return [...events].sort((a, b) => a.seq - b.seq).reduce(stepMolecule, initialMolecule());
}
