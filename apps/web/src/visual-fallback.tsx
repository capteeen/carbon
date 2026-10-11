'use client';
/**
 * Minimal, honest 2D fallbacks for @carbon/visual, used until that package lands.
 * Text and HUD only: no 3D, no animation, no invented values. Every live
 * readout comes from props (logged events); missing data renders "--.--".
 */
import {
  AGENT_IDS,
  AGENT_ROLES,
  EMPTY_GRAPHENE,
  EMPTY_READOUT,
  ISOTOPES,
  ISOTOPE_IDS,
  SHAPES,
  SHAPE_IDS,
  VALENCE,
  protonLabel,
  type AgentId,
  type CarbonEvent,
  type EventPayloads,
} from '@carbon/core/contracts';
import { bondTotals } from '@carbon/core/bonds';
import { formatDecay } from '@carbon/core/render-config';
import { useState } from 'react';
import { readout, shortId } from '@/lib/launch-view';
import type {
  CarbonStoryProps,
  EmbedPlayerProps,
  GrapheneSheetProps,
  HudLabelProps,
  HudReadoutProps,
  IsotopeChamberProps,
  LaunchSceneProps,
  ShapePickerProps,
} from './visual-types';

export const tokens = {
  color: { fogLight: '#B9C0CB', fogMid: '#9AA2AF', slate: '#5C6472', frost: '#E6EBF2', ink: '#2B313B' },
  font: { display: 'var(--font-display)', mono: 'var(--font-mono)' },
} as const;

export function HudLabel({ children, as = 'span' }: HudLabelProps) {
  const Tag = as;
  return <Tag className="hud-label">{children}</Tag>;
}

export function HudReadout({ label, value, delta, digits = 2 }: HudReadoutProps) {
  const d = delta === undefined || delta === null || !Number.isFinite(delta) ? null : delta;
  return (
    <span className="hud-readout">
      <span className="hud-readout-label">{label}</span> <span className="hud-readout-value">{readout(value, digits)}</span>
      {d !== null ? <span className="hud-readout-delta"> {d >= 0 ? '+' : ''}{d.toFixed(digits)}</span> : null}
    </span>
  );
}

/** Sound is part of @carbon/visual. The fallback has no sound engine, so the toggle is shown off and disabled. */
export function SoundToggle() {
  return (
    <button type="button" className="sound-toggle" disabled aria-disabled="true" title="Sound arrives with the 3D scene">
      Sound: Off
    </button>
  );
}

export function IsotopeChamber({ value, onChange, heavyAgent, onHeavyAgentChange }: IsotopeChamberProps) {
  const iso = ISOTOPES[value];
  return (
    <div className="chamber" data-testid="isotope-chamber">
      <div className="carousel" role="radiogroup" aria-label="Isotope">
        {ISOTOPE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === value}
            className={id === value ? 'bracket on' : 'bracket'}
            onClick={() => {
              onChange(id);
              if (!ISOTOPES[id].heavyAgent) onHeavyAgentChange(null);
            }}
          >
            [ {id} ]
          </button>
        ))}
      </div>
      <dl className="readouts">
        <div><dt>NEUTRONS</dt><dd>{iso.neutrons}</dd></div>
        <div><dt>STABILITY</dt><dd>{iso.stable ? 'STABLE' : 'UNSTABLE'}</dd></div>
        <div><dt>HALF-LIFE</dt><dd>{formatDecay(iso.decay)}</dd></div>
        <div><dt>BEHAVIOUR</dt><dd>{iso.behaviour}</dd></div>
      </dl>
      <p className="meta">// {iso.realWorldNote}</p>
      {iso.heavyAgent ? (
        <fieldset className="heavy">
          <legend className="hud-label">EXTRA NEUTRON → PROTON</legend>
          <div className="chips">
            {AGENT_IDS.map((a) => (
              <button key={a} type="button" aria-pressed={heavyAgent === a} className={heavyAgent === a ? 'chip on' : 'chip'} onClick={() => onHeavyAgentChange(a)}>
                {a.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="meta">// {heavyAgent ? `Heavy ${heavyAgent}: capacity ×2. No other agent changes.` : 'Pick the agent whose capacity doubles.'}</p>
        </fieldset>
      ) : null}
    </div>
  );
}

export function ShapePicker({ value, onChange }: ShapePickerProps) {
  return (
    <div className="shapes" role="radiogroup" aria-label="Shape">
      {SHAPE_IDS.map((id) => {
        const s = SHAPES[id];
        return (
          <button key={id} type="button" role="radio" aria-checked={id === value} className={id === value ? 'shape on' : 'shape'} onClick={() => onChange(id)}>
            <span className="hud-label">{s.label}</span>
            <span className="shape-desc">{s.description}</span>
            <span className="meta">// THRESHOLD {s.sentinelThreshold}{s.loopMinutes ? ` · LOOP ${s.loopMinutes} MIN` : ''}{s.gateEveryAction ? ' · EVERY ACTION GATED' : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

export function GrapheneSheet({ launches, onOpenLaunch }: GrapheneSheetProps) {
  if (launches.length === 0) return <p className="empty" data-testid="graphene-empty">{EMPTY_GRAPHENE}</p>;
  return (
    <ul className="graphene" data-testid="graphene">
      {launches.map((l) =>
        l.ca ? (
          <li key={l.launchId}>
            <button type="button" className="crystal" onClick={() => onOpenLaunch(l.ca!)}>
              <span className="crystal-ticker">{l.ticker ? `$${l.ticker}` : EMPTY_READOUT}</span>
              <span className="meta">
                {l.isotope} · {SHAPES[l.shape].label.replace('SHAPE_', '')} · {l.state ?? EMPTY_READOUT}
              </span>
            </button>
          </li>
        ) : null,
      )}
    </ul>
  );
}

function latestLaunchEvents(events: CarbonEvent[]): CarbonEvent[] {
  const lastHandoff = [...events].reverse().find((e) => e.kind === 'handoff');
  return lastHandoff ? events.filter((e) => e.launchId === lastHandoff.launchId) : [];
}

export function CarbonStory({ live, replay, launches, onOpenAgent, onOpenLaunch }: CarbonStoryProps) {
  const [iso, setIso] = useState<IsotopeChamberProps['value']>('C-12');
  const [heavy, setHeavy] = useState<AgentId | null>(null);
  const [shape, setShape] = useState<ShapePickerProps['value']>('chain');
  const liveLaunch = latestLaunchEvents(live.events);
  const totals = liveLaunch.length ? bondTotals(liveLaunch) : null;
  const replayDeployed = replay?.events.find((e) => e.kind === 'launch.deployed') as CarbonEvent<'launch.deployed'> | undefined;
  const replayScore = replay ? ([...replay.events].reverse().find((e) => e.kind === 'sentinel.score') as CarbonEvent<'sentinel.score'> | undefined) : undefined;
  const replayHandoffs = replay ? (replay.events.filter((e) => e.kind === 'handoff') as CarbonEvent<'handoff'>[]) : [];
  const reasoning = live.events.filter((e) => e.kind === 'reasoning').slice(-6).reverse() as CarbonEvent<'reasoning'>[];
  const receipts = live.events.filter((e) => e.kind === 'split.receipt').slice(-4).reverse() as CarbonEvent<'split.receipt'>[];

  return (
    <div className="story">
      <section className="chapter hero" aria-label="00 Hero">
        <div className="corner-tl">
          <h1 className="wordmark">CARBON</h1>
          <p className="meta">// Element 06</p>
          <p className="meta">// Agents that bond.</p>
        </div>
        <div className="corner-tr">
          <p className="hud-label">////// Manifesto</p>
          <p className="mono-line">Six agents. One molecule. One coin.</p>
          <p className="mono-line">Every bond is a real, signed hand-off.</p>
          <p className="mono-line">You approve every launch and every post.</p>
        </div>
        <p className="meta illustration-note">// Chapters 00-07 are an illustrated explainer, not live activity.</p>
      </section>

      <section className="chapter" aria-label="01 Dismantle">
        <p className="hud-label">////// 01 DISMANTLE</p>
        <p>The nucleus holds 12 nucleons: 6 protons, each one an agent, and 6 neutrons. They lift apart to show what a launch is made of.</p>
      </section>

      <section className="chapter" aria-label="03 Six protons">
        <p className="hud-label">////// 03 SIX PROTONS</p>
        <p className="meta">// 6 protons make it carbon. 6 agents make it a Carbon launch.</p>
        <ol className="protons">
          {AGENT_IDS.map((a) => (
            <li key={a}>
              <button type="button" className="proton" onClick={() => onOpenAgent(a)}>
                <span className="hud-label">{protonLabel(a)}</span>
                <span className="role">{AGENT_ROLES[a]}</span>
                <span className="meta">
                  BONDS {totals ? `${totals[a]}/${VALENCE}` : `${EMPTY_READOUT}/${VALENCE}`} · LOAD {EMPTY_READOUT} · CLICK TO EXPLORE
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className="chapter" aria-label="04 Shells">
        <p className="hud-label">////// 04 SHELLS</p>
        <p>Two shells: 2 inner electrons, 4 outer. The 4 outer electrons are the 4 bond arms.</p>
        <p className="meta">// Every agent holds exactly 4 bonds.</p>
      </section>

      <section className="chapter" aria-label="05 Bonding">
        <p className="hud-label">////// 05 BONDING</p>
        <ul className="plain">
          <li>SINGLE · light hand-off · 1 hand-off in 60 s</li>
          <li>DOUBLE · partnership · ≥3 exchanges in 60 s</li>
          <li>TRIPLE · locked team · ≥8, or both agents blocked on each other</li>
        </ul>
      </section>

      <section className="chapter" aria-label="06 Isotope chamber">
        <p className="hud-label">////// 06 ISOTOPE CHAMBER</p>
        <IsotopeChamber value={iso} onChange={setIso} heavyAgent={heavy} onHeavyAgentChange={setHeavy} />
      </section>

      <section className="chapter" aria-label="07 Shapes">
        <p className="hud-label">////// 07 SHAPES</p>
        <ShapePicker value={shape} onChange={setShape} />
      </section>

      <section className="chapter" aria-label="08 The launch">
        <p className="hud-label">////// 08 THE LAUNCH</p>
        {replay && replayDeployed ? (
          <div className="replay">
            <p className="meta">
              replaying ${replay.ticker}, {replay.date}
            </p>
            <ul className="plain">
              {replayHandoffs.map((h) => (
                <li key={h.id}>
                  {h.payload.from.toUpperCase()} → {h.payload.to.toUpperCase()} · <code>{shortId(h.id)}</code>
                </li>
              ))}
            </ul>
            <p>STABILITY {replayScore ? `${replayScore.payload.score}/${replayScore.payload.threshold}` : EMPTY_READOUT}</p>
            <p className="ca">CA {replayDeployed.payload.ca}</p>
          </div>
        ) : (
          <p className="meta">// No launch has been recorded yet, so there is nothing to replay.</p>
        )}
      </section>

      <section className="chapter live" aria-label="09 Live">
        <p className="hud-label">////// 09 LIVE</p>
        <GrapheneSheet launches={launches} onOpenLaunch={onOpenLaunch} />
        <div className="panels">
          <div className="panel">
            <p className="hud-label">THINKING FEED // agent reasoning</p>
            {reasoning.length === 0 ? (
              <p className="meta">{EMPTY_READOUT}</p>
            ) : (
              <ul className="plain">
                {reasoning.map((r) => (
                  <li key={r.id}>
                    <span className="hud-label">{r.payload.agent.toUpperCase()}</span> {r.payload.text} <code>{shortId(r.payload.forEventId)}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="panel">
            <p className="hud-label">RECEIPTS</p>
            {receipts.length === 0 ? (
              <p className="meta">{EMPTY_READOUT}</p>
            ) : (
              <ul className="plain">
                {receipts.map((r) => (
                  <li key={r.id}>
                    split <code>{shortId(r.payload.splitId)}</code> · {r.payload.legs.length} legs
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export function LaunchScene({ events, bonds, sentinel, decay, daughter }: LaunchSceneProps) {
  const totals = events.length ? bondTotals(events) : null;
  return (
    <div className="scene" data-testid="launch-scene">
      <p className="hud-label">BONDS</p>
      {bonds.length === 0 ? (
        <p className="meta">{EMPTY_READOUT}</p>
      ) : (
        <ul className="plain">
          {bonds.map((b) => (
            <li key={b.pair}>
              {b.pair.replace('|', ' — ').toUpperCase()} · ORDER {b.order} · <code>{shortId(b.lastHash)}</code>
            </li>
          ))}
        </ul>
      )}
      <p className="meta">
        {AGENT_IDS.map((a) => `${a.toUpperCase()} ${totals ? totals[a] : EMPTY_READOUT}/${VALENCE}`).join(' · ')}
      </p>
      <p className="hud-label">SENTINEL</p>
      <p>
        {sentinel ? `${sentinel.score}/${sentinel.threshold} · ${sentinel.hardFail ? 'BLOCKED (hard fail)' : sentinel.passed ? 'LOCKED: PASS' : 'BLOCKED'}` : EMPTY_READOUT}
      </p>
      <p className="hud-label">DECAY</p>
      <p>
        {decay.rule === 'none' ? 'stable' : decay.collapsed ? 'collapsed' : decay.rule === 'clock' ? 'clock running' : 'decays after 20 min with no trades'}
      </p>
      {daughter ? <p className="ca">DAUGHTER {daughter.daughterCa}</p> : null}
    </div>
  );
}

export function EmbedPlayer({ launch, events, bonds }: EmbedPlayerProps) {
  const last = [...events].reverse().find((e) => e.kind === 'reasoning') as CarbonEvent<'reasoning'> | undefined;
  const p = last?.payload as EventPayloads['reasoning'] | undefined;
  return (
    <div className="embed" data-testid="embed-player">
      <p className="hud-label">CARBON // {ISOTOPES[launch.isotope].label} · {SHAPES[launch.shape].label}</p>
      <p className="embed-ticker">{launch.ticker ? `$${launch.ticker}` : EMPTY_READOUT}</p>
      <p className="meta">STATE {launch.state ?? EMPTY_READOUT} · STABILITY {launch.score === null ? EMPTY_READOUT : `${launch.score}/${launch.threshold}`} · BONDS {bonds.length}</p>
      {p ? (
        <p className="meta">
          agent reasoning · {p.agent.toUpperCase()}: {p.text}
        </p>
      ) : null}
      {launch.ca ? <p className="ca">CA {launch.ca}</p> : null}
    </div>
  );
}

