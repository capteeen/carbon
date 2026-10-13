/**
 * Read model over the append-only event log. Every value a page shows comes
 * from here, i.e. from logged events. Nothing is seeded; an empty log gives
 * empty lists.
 */
import { ISOTOPES, type ArgonEvent, type EventKind, type EventPayloads } from '@argon/core/contracts';
import type { LaunchSummary, Network, ReceiptRow, ReplayData, WalletRow } from '@/lib/types';
import { getCore } from './core';

/** The core, or null when this deployment has no event log (honest empty reads). */
async function coreOrNull(): Promise<Awaited<ReturnType<typeof getCore>> | null> {
  try {
    return await getCore();
  } catch (err) {
    if (err instanceof Error && err.name === 'LogNotConfiguredError') return null;
    throw err;
  }
}

const SUMMARY_KINDS: EventKind[] = ['launch.created', 'forge.draft', 'sentinel.score', 'launch.deployed', 'holders.snapshot', 'decay.collapsed'];

/** Builds summaries from the summary-relevant events of any number of launches. */
export function summarize(events: readonly ArgonEvent[]): LaunchSummary[] {
  const byLaunch = new Map<string, ArgonEvent[]>();
  for (const e of events) {
    const l = byLaunch.get(e.launchId);
    if (l) l.push(e);
    else byLaunch.set(e.launchId, [e]);
  }
  const out: LaunchSummary[] = [];
  for (const [launchId, evs] of byLaunch) {
    evs.sort((a, b) => a.seq - b.seq);
    const created = evs.find((e) => e.kind === 'launch.created') as ArgonEvent<'launch.created'> | undefined;
    if (!created) continue;
    const p = created.payload;
    const drafts = evs.filter((e) => e.kind === 'forge.draft') as ArgonEvent<'forge.draft'>[];
    const draft = drafts[drafts.length - 1];
    const scores = evs.filter((e) => e.kind === 'sentinel.score') as ArgonEvent<'sentinel.score'>[];
    const score = scores[scores.length - 1];
    const deployed = evs.find((e) => e.kind === 'launch.deployed') as ArgonEvent<'launch.deployed'> | undefined;
    const unstable = !ISOTOPES[p.isotope]?.stable;
    let state: string | null = null;
    if (deployed) {
      state = 'live';
      if (unstable && evs.some((e) => e.kind === 'holders.snapshot' && e.seq > deployed.seq)) state = 'decaying';
      if (unstable && evs.some((e) => e.kind === 'decay.collapsed')) state = 'collapsed';
    }
    out.push({
      launchId,
      ca: deployed?.payload.ca ?? null,
      name: draft?.payload.name ?? null,
      ticker: draft?.payload.ticker ?? null,
      isotope: p.isotope,
      shape: p.shape,
      heavyAgent: p.heavyAgent,
      score: score?.payload.score ?? null,
      threshold: score?.payload.threshold ?? null,
      network: deployed?.payload.network ?? null,
      createdAt: created.ts,
      deployedAt: deployed?.ts ?? null,
      state,
      logoUri: draft?.payload.logoUri ?? null,
      deployEventId: deployed?.id ?? null,
      collapsed: evs.some((e) => e.kind === 'decay.collapsed'),
    });
  }
  return out.sort((a, b) => (b.deployedAt ?? b.createdAt) - (a.deployedAt ?? a.createdAt));
}

/** Every deployed launch (the graphene sheet). */
export async function listLiveLaunches(): Promise<LaunchSummary[]> {
  const core = await coreOrNull();
  if (!core) return [];
  const { bus } = core;
  return summarize(await bus.list('*', { kinds: SUMMARY_KINDS })).filter((s) => s.ca !== null);
}

export async function findLaunchIdByCa(ca: string): Promise<string | null> {
  const core = await coreOrNull();
  if (!core) return null;
  const { bus } = core;
  const r = await bus.pool.query<{ launch_id: string }>(
    "SELECT launch_id FROM events WHERE kind = 'launch.deployed' AND payload->>'ca' = $1 ORDER BY seq ASC LIMIT 1",
    [ca],
  );
  return r.rows[0]?.launch_id ?? null;
}

/** The launch an approval card belongs to (from its approval.requested event). */
export async function approvalLaunchId(approvalId: string): Promise<string | null> {
  const core = await coreOrNull();
  if (!core) return null;
  const { bus } = core;
  const r = await bus.pool.query<{ launch_id: string }>(
    "SELECT launch_id FROM events WHERE kind = 'approval.requested' AND payload->>'approvalId' = $1 ORDER BY seq ASC LIMIT 1",
    [approvalId],
  );
  return r.rows[0]?.launch_id ?? null;
}

export async function getLaunchEvents(launchId: string): Promise<ArgonEvent[]> {
  const core = await coreOrNull();
  if (!core) return [];
  const { bus } = core;
  return bus.list(launchId);
}

export async function getLaunchByCa(ca: string): Promise<{ summary: LaunchSummary; events: ArgonEvent[] } | null> {
  const launchId = await findLaunchIdByCa(ca);
  if (!launchId) return null;
  const events = await getLaunchEvents(launchId);
  const summary = summarize(events.filter((e) => SUMMARY_KINDS.includes(e.kind)))[0];
  return summary ? { summary, events } : null;
}

export async function launchCreated(launchId: string): Promise<ArgonEvent<'launch.created'> | null> {
  const core = await coreOrNull();
  if (!core) return null;
  const { bus } = core;
  const [e] = await bus.list(launchId, { kinds: ['launch.created'], limit: 1 });
  return (e as ArgonEvent<'launch.created'> | undefined) ?? null;
}

function launchIndex(events: readonly ArgonEvent[]): Map<string, { ca: string | null; ticker: string | null; network: Network | null }> {
  const m = new Map<string, { ca: string | null; ticker: string | null; network: Network | null }>();
  for (const e of events) {
    const cur = m.get(e.launchId) ?? { ca: null, ticker: null, network: null };
    if (e.kind === 'launch.deployed') {
      const p = e.payload as EventPayloads['launch.deployed'];
      cur.ca = p.ca;
      cur.network = p.network;
    }
    if (e.kind === 'forge.draft') cur.ticker = (e.payload as EventPayloads['forge.draft']).ticker;
    m.set(e.launchId, cur);
  }
  return m;
}

/** Every split.receipt, newest first. Superseded receipts for the same split are kept: the log is the record. */
export async function listReceipts(): Promise<ReceiptRow[]> {
  const core = await coreOrNull();
  if (!core) return [];
  const { bus } = core;
  const evs = await bus.list('*', { kinds: ['split.receipt', 'launch.deployed', 'forge.draft'] });
  const idx = launchIndex(evs);
  return evs
    .filter((e): e is ArgonEvent<'split.receipt'> => e.kind === 'split.receipt')
    .map((e) => ({ launchId: e.launchId, eventId: e.id, receipt: e.payload, ...(idx.get(e.launchId) ?? { ca: null, ticker: null, network: null }) }))
    .reverse();
}

/** Every per-launch public fee address (wallet.created; launch.deployed's creatorWallet when no wallet.created exists). */
export async function listLaunchWallets(): Promise<WalletRow[]> {
  const core = await coreOrNull();
  if (!core) return [];
  const { bus } = core;
  const evs = await bus.list('*', { kinds: ['wallet.created', 'launch.deployed', 'forge.draft'] });
  const idx = launchIndex(evs);
  const rows = new Map<string, WalletRow>();
  for (const e of evs) {
    if (e.kind === 'wallet.created' && !rows.has(e.launchId)) {
      const p = e.payload as EventPayloads['wallet.created'];
      rows.set(e.launchId, { launchId: e.launchId, address: p.address, mode: p.mode, eventId: e.id, ...idx.get(e.launchId)! });
    }
  }
  for (const e of evs) {
    if (e.kind === 'launch.deployed' && !rows.has(e.launchId)) {
      const p = e.payload as EventPayloads['launch.deployed'];
      rows.set(e.launchId, { launchId: e.launchId, address: p.creatorWallet, mode: null, eventId: e.id, ...idx.get(e.launchId)! });
    }
  }
  return [...rows.values()].reverse();
}

/** The most recent deployed launch, for the chapter 08 replay. */
export async function latestReplay(): Promise<ReplayData | null> {
  const core = await coreOrNull();
  if (!core) return null;
  const { bus } = core;
  const r = await bus.pool.query<{ launch_id: string }>("SELECT launch_id FROM events WHERE kind = 'launch.deployed' ORDER BY seq DESC LIMIT 1");
  const launchId = r.rows[0]?.launch_id;
  if (!launchId) return null;
  const events = await bus.list(launchId);
  const dep = events.find((e) => e.kind === 'launch.deployed') as ArgonEvent<'launch.deployed'> | undefined;
  const drafts = events.filter((e) => e.kind === 'forge.draft') as ArgonEvent<'forge.draft'>[];
  const ticker = drafts[drafts.length - 1]?.payload.ticker;
  if (!dep || !ticker) return null;
  return { launchId, ca: dep.payload.ca, ticker, date: new Date(dep.ts).toISOString().slice(0, 10), events: events.filter((e) => e.seq <= dep.seq) };
}

/**
 * The molecule the home BONDS readout shows: the launch with the most recent
 * hand-off, with its COMPLETE log (bonds are recomputed over the full log,
 * never over the global window). Call after recentGlobalEvents() so the log
 * covers every event up to that window's lastSeq. null when nothing handed off.
 */
export async function activeMolecule(): Promise<{ launchId: string; events: ArgonEvent[] } | null> {
  const core = await coreOrNull();
  if (!core) return null;
  const { bus } = core;
  const r = await bus.pool.query<{ launch_id: string }>("SELECT launch_id FROM events WHERE kind = 'handoff' ORDER BY seq DESC LIMIT 1");
  const launchId = r.rows[0]?.launch_id;
  if (!launchId) return null;
  return { launchId, events: await bus.list(launchId) };
}

/** The latest global events (thinking feed + receipts panels) and the resume point for SSE. */
export async function recentGlobalEvents(limit = 60): Promise<{ events: ArgonEvent[]; lastSeq: number }> {
  const core = await coreOrNull();
  if (!core) return { events: [], lastSeq: 0 };
  const { bus } = core;
  const lastSeq = await bus.maxSeq();
  const events = await bus.list('*', { afterSeq: Math.max(0, lastSeq - limit) });
  return { events, lastSeq };
}
