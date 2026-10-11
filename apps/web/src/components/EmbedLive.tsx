'use client';
import { computeBonds } from '@carbon/core/bonds';
import type { CarbonEvent } from '@carbon/core/contracts';
import { useMemo } from 'react';
import { deriveLaunchView } from '@/lib/launch-view';
import type { LaunchSummary } from '@/lib/types';
import { toVisualDaughter, toVisualDecay, toVisualLaunch } from '@/lib/visual-data';
import { useEventStream, useNow } from '@/lib/use-events';
import { EmbedPlayer } from '@/visual';

/** Display bonds: core's computeBonds over the full log at display time (ticks every second; first render at the server's renderedAt). */
export function EmbedLive({ launch, initial, lastSeq, site, renderedAt }: { launch: LaunchSummary; initial: CarbonEvent[]; lastSeq: number; site: string; renderedAt: number }) {
  const { events } = useEventStream(launch.launchId, initial, lastSeq);
  const now = useNow(1000, true, renderedAt) ?? renderedAt;
  const bonds = useMemo(() => computeBonds(events, Math.max(now, events[events.length - 1]?.ts ?? 0)), [events, now]);
  const v = useMemo(() => deriveLaunchView(launch.launchId, events), [launch.launchId, events]);
  const visual = useMemo(() => toVisualLaunch(launch), [launch]);
  return (
    <>
      <EmbedPlayer
        launch={visual}
        events={events}
        bonds={bonds}
        sentinel={v.latestScore?.payload ?? null}
        decay={toVisualDecay(events, v.decay)}
        daughter={toVisualDaughter(v.decay)}
        href={launch.ca ? `${site}/l/${launch.ca}` : undefined}
      />
      {launch.ca ? (
        <a className="hud-label" href={`${site}/l/${launch.ca}`} target="_blank" rel="noreferrer">
          OPEN ON CARBON →
        </a>
      ) : null}
    </>
  );
}
