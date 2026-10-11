'use client';
import { EMPTY_READOUT, protonLabel, type AgentId, type CarbonEvent } from '@carbon/core/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { shortId } from '@/lib/launch-view';
import type { LaunchSummary, ReplayData } from '@/lib/types';
import { useEventStream } from '@/lib/use-events';
import { CarbonStory } from '@/visual';

const REFRESH_KINDS = new Set(['launch.deployed', 'sentinel.score', 'holders.snapshot', 'decay.collapsed']);

export function HomeLive(props: { launches: LaunchSummary[]; replay: ReplayData | null; live: { events: CarbonEvent[]; lastSeq: number } }) {
  const router = useRouter();
  const { events } = useEventStream('*', props.live.events, props.live.lastSeq, { max: 200 });
  const [launches, setLaunches] = useState(props.launches);
  const [agent, setAgent] = useState<AgentId | null>(null);
  const last = events[events.length - 1];

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
      <CarbonStory
        live={{ events, lastSeq: last?.seq ?? props.live.lastSeq }}
        replay={props.replay}
        launches={launches}
        onOpenAgent={setAgent}
        onOpenLaunch={(ca) => router.push(`/l/${ca}`)}
      />
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
                  {e.kind === 'reasoning' ? ` · agent reasoning: ${(e as CarbonEvent<'reasoning'>).payload.text}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </>
  );
}
