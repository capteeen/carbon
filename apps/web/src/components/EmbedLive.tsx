'use client';
import { computeBonds } from '@carbon/core/bonds';
import type { CarbonEvent } from '@carbon/core/contracts';
import { useMemo } from 'react';
import type { LaunchSummary } from '@/lib/types';
import { useEventStream, useNow } from '@/lib/use-events';
import { EmbedPlayer } from '@/visual';

export function EmbedLive({ launch, initial, lastSeq, site }: { launch: LaunchSummary; initial: CarbonEvent[]; lastSeq: number; site: string }) {
  const { events } = useEventStream(launch.launchId, initial, lastSeq);
  const now = useNow(1000);
  const bonds = useMemo(() => (now === null ? computeBonds(events) : computeBonds(events, Math.max(now, events[events.length - 1]?.ts ?? 0))), [events, now]);
  return (
    <>
      <EmbedPlayer launch={launch} events={events} bonds={bonds} />
      {launch.ca ? (
        <a className="hud-label" href={`${site}/l/${launch.ca}`} target="_blank" rel="noreferrer">
          OPEN ON CARBON →
        </a>
      ) : null}
    </>
  );
}
