'use client';
import { EMPTY_READOUT, protonLabel, type AgentId, type ArgonEvent } from '@argon/core/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { shortId } from '@/lib/launch-view';
import type { LaunchSummary, ReplayData } from '@/lib/types';
import { useEventStream, useNow } from '@/lib/use-events';
import {
  feedFromEvents,
  foldIntoLogs,
  lastHandoffLaunch,
  liveFromLogs,
  receiptsFromEvents,
  toVisualLaunches,
  toVisualReplay,
} from '@/lib/visual-data';
import { ArgonStory } from '@/visual';

const REFRESH_KINDS = new Set(['launch.deployed', 'sentinel.score', 'holders.snapshot', 'decay.collapsed']);
/** Complete logs kept in memory: the active molecule plus a few recent ones. */
const MAX_LOGS = 4;

export interface HomeLiveProps {
  launches: LaunchSummary[];
  replay: ReplayData | null;
  /** The latest global events (feed, receipts, LOAD) and the SSE resume point. */
  live: { events: ArgonEvent[]; lastSeq: number };
  /** The launch that most recently handed off, with its COMPLETE log (BONDS readout). */
  molecule: { launchId: string; events: ArgonEvent[] } | null;
  /** Server render time: the display time of the first render. */
  renderedAt: number;
}

export function HomeLive(props: HomeLiveProps) {
  const router = useRouter();
  const { events } = useEventStream('*', props.live.events, props.live.lastSeq, { max: 200 });
  const [launches, setLaunches] = useState(props.launches);
  const [agent, setAgent] = useState<AgentId | null>(null);
  const last = events[events.length - 1];

  // Complete per-launch logs: seeded with the server's full log of the active
  // molecule, extended by the global stream, and fetched in full for a launch
  // that starts handing off while the page is open.
  const [logs, setLogs] = useState<ReadonlyMap<string, ArgonEvent[]>>(
    () => new Map(props.molecule ? [[props.molecule.launchId, props.molecule.events]] : []),
  );
  useEffect(() => setLogs((prev) => foldIntoLogs(prev, events)), [events]);
  const fetching = useRef(new Set<string>());
  const active = lastHandoffLaunch(events, ...logs.values());
  useEffect(() => {
    if (!active || logs.has(active) || fetching.current.has(active)) return;
    fetching.current.add(active);
    fetch(`/api/launch/${encodeURIComponent(active)}/events`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ events: ArgonEvent[] }>) : null))
      .then((j) => {
        if (!j) return;
        setLogs((prev) => {
          const next = new Map(prev);
          next.set(active, j.events);
          while (next.size > MAX_LOGS) next.delete(next.keys().next().value!);
          return foldIntoLogs(next, events);
        });
      })
      .catch(() => undefined)
      .finally(() => fetching.current.delete(active));
  }, [active, logs, events]);

  // Visual props, all derived from the real log (empty log → empty states).
  // Display time ticks every second so bonds age out of the 60 s window.
  // (only ticks while there is a molecule whose bonds can age out)
  const now = useNow(1000, active !== null, props.renderedAt) ?? props.renderedAt;
  const live = useMemo(() => liveFromLogs(events, logs, now), [events, logs, now]);
  const replay = useMemo(() => toVisualReplay(props.replay), [props.replay]);
  const crystals = useMemo(() => toVisualLaunches(launches), [launches]);
  const feed = useMemo(() => feedFromEvents(events), [events]);
  const receipts = useMemo(() => receiptsFromEvents(events), [events]);

  // A new deploy / score / decay event changes the graphene: re-read it from the log.
  useEffect(() => {
    if (!last || last.seq <= props.live.lastSeq || !REFRESH_KINDS.has(last.kind)) return;
    let cancelled = false;
    fetch('/api/launches', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ launches: LaunchSummary[] }>) : null))
      .then((j) => {
        if (j && !cancelled) setLaunches(j.launches);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [last, props.live.lastSeq]);

  const agentEvents = agent ? events.filter((e) => e.actor === agent).slice(-20).reverse() : [];

  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Link href="/launch" className="hud-label">
          [ LAUNCH ]
        </Link>
      </div>
      <div className="story-bleed">
        <ArgonStory
          live={live}
          replay={replay}
          launches={crystals}
          feed={feed}
          receipts={receipts}
          onOpenAgent={setAgent}
          onOpenLaunch={(ca) => router.push(`/l/${ca}`)}
          launchHref="/launch"
          soundToggle={false}
        />
      </div>
      {agent ? (
        <div className="card" role="dialog" aria-label={`${agent} live log`}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="hud-label">{protonLabel(agent)} // live log</span>
            <button type="button" onClick={() => setAgent(null)}>
              Close
            </button>
          </div>
          {agentEvents.length === 0 ? (
            <p className="meta">{EMPTY_READOUT} // no events from {agent.toUpperCase()} in the live window yet.</p>
          ) : (
            <ul className="plain">
              {agentEvents.map((e) => (
                <li key={e.id}>
                  <code>{shortId(e.id)}</code> {e.kind}
                  {e.kind === 'reasoning' ? ` · agent reasoning: ${(e as ArgonEvent<'reasoning'>).payload.text}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </>
  );
}
