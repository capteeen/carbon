'use client';
/**
 * <EmbedPlayer />: compact player-card view for /embed/[ca] (twitter:card=player).
 * A live LaunchScene with the coin's identity; without a launch it shows "--.--".
 */
import { EMPTY_READOUT, type Bond, type ArgonEvent, type SentinelReport } from '@argon/core/contracts';
import { fmtDate, shortCa } from '../hud/format.js';
import type { DaughterView, DecayView, LaunchSummary } from '../types.js';
import { LaunchScene } from './LaunchScene.js';
import { isEventId } from '../hud/format.js';

export interface EmbedPlayerProps {
  launch: LaunchSummary | null;
  events?: readonly ArgonEvent[];
  bonds?: readonly Bond[];
  sentinel?: SentinelReport | null;
  decay?: DecayView | null;
  daughter?: DaughterView | null;
  /** Link to the full launch page. */
  href?: string;
  reducedMotion?: boolean;
}

export function EmbedPlayer({ launch, events = [], bonds = [], sentinel, decay, daughter, href, reducedMotion }: EmbedPlayerProps) {
  const real = launch && isEventId(launch.deployEventId) ? launch : null;
  return (
    <div className="argon-embed" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }} data-testid="embed-player">
      <LaunchScene events={real ? events : []} bonds={real ? bonds : []} sentinel={real ? sentinel : null} decay={real ? decay : null} daughter={real ? daughter : null} shape={real?.shape} compact reducedMotion={reducedMotion} />
      <div className="argon-hud" style={{ pointerEvents: 'none' }}>
        <div className="argon-hud__corner argon-hud__corner--tr" data-testid="embed-identity">
          {real ? (
            <>
              <div className="argon-title">{`$${real.ticker.replace(/^\$/, '')}`}</div>
              <div className="argon-hud__readout">{`${real.isotope} · ${real.shape.toUpperCase()}`}</div>
              <div className="argon-hud__readout">{`CA ${shortCa(real.ca)}`}</div>
              <div className="argon-hud__meta">{`// ${real.network} · ${fmtDate(real.deployedAt)}`}</div>
            </>
          ) : (
            <div className="argon-hud__readout" data-empty="true">
              {EMPTY_READOUT}
            </div>
          )}
        </div>
        {href ? (
          <div className="argon-hud__corner argon-hud__corner--bl">
            <a className="argon-hud__btn" href={href} target="_blank" rel="noopener noreferrer" style={{ pointerEvents: 'auto', textDecoration: 'none' }}>
              Open on Argon
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
