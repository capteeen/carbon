/**
 * Pure derivation of everything a launch page shows, from the launch's own
 * events. Server and client run the same function, so the page after an SSE
 * event is identical to a fresh server render of the same log.
 * Browser-safe: imports only browser-safe core modules.
 */
import {
  AUTOPILOT_CLASSES,
  ISOTOPES,
  launchConfig,
  type AutopilotClass,
  type CarbonEvent,
  type EventPayloads,
  type LaunchConfig,
} from '@carbon/core/contracts';
import { foldMolecule, type MoleculeSnapshot } from '@carbon/core/molecule';

type Ev<K extends keyof EventPayloads> = CarbonEvent<K>;

export interface PendingApproval {
  approvalId: string;
  action: EventPayloads['approval.requested']['action'];
  draft: unknown;
  actor: CarbonEvent['actor'];
  eventId: string;
  ts: number;
}

export interface DecayView {
  rule: 'none' | 'quiet' | 'clock';
  /** From decay.started (clock rule only). */
  collapseAt: number | null;
  startedEventId: string | null;
  quietSec: number | null;
  collapsed: Ev<'decay.collapsed'> | null;
  daughter: Ev<'daughter.launched'> | null;
  airdrops: Ev<'airdrop.sent'>[];
}

export interface LaunchView {
  launchId: string;
  created: Ev<'launch.created'> | null;
  config: LaunchConfig | null;
  molecule: MoleculeSnapshot;
  proposals: Ev<'scout.proposals'> | null;
  drafts: Ev<'forge.draft'>[];
  latestDraft: Ev<'forge.draft'> | null;
  scores: Ev<'sentinel.score'>[];
  latestScore: Ev<'sentinel.score'> | null;
  deployed: Ev<'launch.deployed'> | null;
  wallet: Ev<'wallet.created'> | null;
  reasoning: Ev<'reasoning'>[];
  receipts: Ev<'split.receipt'>[];
  claims: Ev<'fee.claimed'>[];
  buybacks: Ev<'buyback.executed'>[];
  posts: Ev<'post.published'>[];
  holders: Ev<'holders.snapshot'> | null;
  pending: PendingApproval[];
  autopilot: Record<AutopilotClass, boolean>;
  killed: Ev<'killswitch.engaged'> | null;
  decay: DecayView;
  errors: Ev<'error'>[];
  /** Highest seq seen (SSE resume point). */
  lastSeq: number;
}

export function deriveLaunchView(launchId: string, events: readonly CarbonEvent[]): LaunchView {
  const evs = [...events].filter((e) => e.launchId === launchId).sort((a, b) => a.seq - b.seq);
  const of = <K extends keyof EventPayloads>(k: K) => evs.filter((e) => e.kind === k) as Ev<K>[];
  const last = <T>(xs: T[]): T | null => (xs.length ? xs[xs.length - 1]! : null);

  const created = of('launch.created')[0] ?? null;
  let config: LaunchConfig | null = null;
  if (created) {
    try {
      config = launchConfig(created.payload.isotope, created.payload.shape, created.payload.heavyAgent);
    } catch {
      config = null;
    }
  }

  const decided = new Set<string>();
  for (const e of evs) {
    if (e.kind === 'approval.granted' || e.kind === 'approval.rejected' || e.kind === 'approval.consumed') {
      decided.add((e.payload as { approvalId: string }).approvalId);
    }
  }
  const pending: PendingApproval[] = of('approval.requested')
    .filter((e) => !decided.has(e.payload.approvalId))
    .map((e) => ({ approvalId: e.payload.approvalId, action: e.payload.action, draft: e.payload.draft, actor: e.actor, eventId: e.id, ts: e.ts }));

  const killed = of('killswitch.engaged')[0] ?? null;
  const autopilot = Object.fromEntries(AUTOPILOT_CLASSES.map((c) => [c, false])) as Record<AutopilotClass, boolean>;
  for (const e of of('autopilot.changed')) autopilot[e.payload.actionClass] = e.payload.enabled;
  if (killed || config?.gateEveryAction) for (const c of AUTOPILOT_CLASSES) autopilot[c] = false;

  const iso = created ? ISOTOPES[created.payload.isotope] : null;
  const started = of('decay.started')[0] ?? null;
  const decay: DecayView = {
    rule: iso ? iso.decay.kind : 'none',
    collapseAt: started?.payload.collapseAt ?? null,
    startedEventId: started?.id ?? null,
    quietSec: iso && iso.decay.kind === 'quiet' ? iso.decay.quietSec : null,
    collapsed: of('decay.collapsed')[0] ?? null,
    daughter: of('daughter.launched')[0] ?? null,
    airdrops: of('airdrop.sent'),
  };

  const drafts = of('forge.draft');
  const scores = of('sentinel.score');
  return {
    launchId,
    created,
    config,
    molecule: foldMolecule(evs),
    proposals: last(of('scout.proposals')),
    drafts,
    latestDraft: last(drafts),
    scores,
    latestScore: last(scores),
    deployed: of('launch.deployed')[0] ?? null,
    wallet: of('wallet.created')[0] ?? null,
    reasoning: of('reasoning'),
    receipts: of('split.receipt'),
    claims: of('fee.claimed'),
    buybacks: of('buyback.executed'),
    posts: of('post.published'),
    holders: last(of('holders.snapshot')),
    pending,
    autopilot,
    killed,
    decay,
    errors: of('error'),
    lastSeq: evs.length ? evs[evs.length - 1]!.seq : 0,
  };
}

/** Merge new events into a list without duplicates, in seq order. */
export function mergeEvents(prev: readonly CarbonEvent[], incoming: readonly CarbonEvent[]): CarbonEvent[] {
  const seen = new Set(prev.map((e) => e.seq));
  const out = [...prev];
  for (const e of incoming) if (!seen.has(e.seq)) {
    seen.add(e.seq);
    out.push(e);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Explorer link for a tx or address on the launch's own cluster; null when the cluster is unknown. */
export function explorerUrl(kind: 'tx' | 'address', value: string, network: 'devnet' | 'mainnet-beta' | null): string | null {
  if (network === null) return null;
  const base = `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}`;
  return network === 'mainnet-beta' ? base : `${base}?cluster=devnet`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Formats an optional number for a HUD readout: "--.--" when there is no data. */
export function readout(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '--.--' : n.toFixed(digits);
}

export function lamportsToSol(l: string | bigint): string {
  const v = typeof l === 'bigint' ? l : BigInt(l);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
