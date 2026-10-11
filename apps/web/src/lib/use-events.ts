'use client';
/**
 * Live tail of the event log over SSE (/api/events/<launchId|*>). Starts after the
 * seq the server render ended at, so nothing is missed or duplicated; the browser
 * resumes with Last-Event-ID on reconnect.
 */
import type { CarbonEvent, EventKind } from '@carbon/core/contracts';
import { useEffect, useRef, useState } from 'react';
import { mergeEvents } from './launch-view';

/** Every EventKind (the SSE `event:` field). Compile-time checked to be complete. */
export const EVENT_KINDS = [
  'launch.created',
  'handoff',
  'handoff.queued',
  'agent.blocked',
  'agent.unblocked',
  'reasoning',
  'scout.proposals',
  'forge.draft',
  'sentinel.score',
  'approval.requested',
  'approval.granted',
  'approval.consumed',
  'approval.rejected',
  'wallet.created',
  'launch.deployed',
  'post.published',
  'fee.claimed',
  'split.receipt',
  'buyback.executed',
  'autopilot.changed',
  'killswitch.engaged',
  'holders.snapshot',
  'decay.started',
  'decay.collapsed',
  'daughter.launched',
  'airdrop.sent',
  'budget.exceeded',
  'error',
] as const satisfies readonly EventKind[];
type Missing = Exclude<EventKind, (typeof EVENT_KINDS)[number]>;
const _complete: [Missing] extends [never] ? true : Missing = true;
void _complete;

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

export function useEventStream(
  launchId: string | '*' | null,
  initial: CarbonEvent[],
  afterSeq: number,
  opts: { max?: number } = {},
): { events: CarbonEvent[]; status: StreamStatus } {
  const [events, setEvents] = useState<CarbonEvent[]>(initial);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const max = opts.max;
  const startRef = useRef(afterSeq);

  useEffect(() => {
    if (!launchId) return;
    const url = `/api/events/${launchId === '*' ? '*' : encodeURIComponent(launchId)}?after=${startRef.current}`;
    const es = new EventSource(url);
    const onEvent = (m: MessageEvent<string>) => {
      let e: CarbonEvent;
      try {
        e = JSON.parse(m.data) as CarbonEvent;
      } catch {
        return;
      }
      setEvents((prev) => {
        const merged = mergeEvents(prev, [e]);
        return max && merged.length > max ? merged.slice(merged.length - max) : merged;
      });
    };
    for (const k of EVENT_KINDS) es.addEventListener(k, onEvent as EventListener);
    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus('reconnecting');
    return () => es.close();
  }, [launchId, max]);

  return { events, status };
}

/** Re-renders every `ms` while `active`, for clocks and the rolling 60 s bond window. */
export function useNow(ms = 1000, active = true): number | null {
  // null on the server and the first client render (no hydration mismatch).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}
