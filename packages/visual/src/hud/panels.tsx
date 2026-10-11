/**
 * HUD panels shared by the story and the standalone components. Pure render
 * (no effects), so honesty/empty states are unit-tested with
 * renderToStaticMarkup.
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
  protonLabel,
  type AgentId,
  type IsotopeId,
  type SentinelReport,
  type ShapeId,
} from '@carbon/core/contracts';
import type { Ref } from 'react';
import { COPY } from '../copy.js';
import type { LaunchReplay, LaunchSummary, LiveMolecule, LiveStats, ReceiptItem, ThinkingItem } from '../types.js';
import { HudLabel, HudMeta, HudPanel, HudReadout, HudSection } from './Hud.js';
import {
  fmtBonds,
  fmtClock,
  fmtDate,
  fmtDecayRule,
  fmtLamports,
  fmtLoad,
  fmtStability,
  replayLabel,
  shortCa,
  shortHash,
} from './format.js';

type LeaderRefFn = (id: string) => Ref<HTMLDivElement> | undefined;
const noRef: LeaderRefFn = () => undefined;

// ───────────────────────────── 03 protons ─────────────────────────────

export function ProtonHud({
  agent,
  live,
  onOpenAgent,
  leaderRef = noRef,
}: {
  agent: AgentId;
  live: LiveStats | null | undefined;
  onOpenAgent?: (agent: AgentId) => void;
  leaderRef?: LeaderRefFn;
}) {
  const stats = live?.agents[agent];
  const i = AGENT_IDS.indexOf(agent) + 1;
  const mol = live?.molecule ?? null;
  const orders = stats && mol ? stats.bondOrders : null;
  return (
    <div data-testid="proton-hud" data-agent={agent}>
      <span className="carbon-sr-only">{protonLabel(agent)}</span>
      <HudLabel leaderRef={leaderRef('focus')} testId="proton-label">{`PROTON_${String(i).padStart(2, '0')}`}</HudLabel>
      <div className="carbon-title">{agent.toUpperCase()}</div>
      <div className="carbon-hud__note" style={{ marginBottom: 6 }}>
        {AGENT_ROLES[agent]}
      </div>
      <HudReadout value={fmtBonds(orders)} testId="proton-bonds" />
      <HudMeta testId="proton-molecule">{mol ? `bonds in ${moleculeName(mol)} · most recent hand-off` : 'bonds: no molecule handing off yet'}</HudMeta>
      <HudReadout value={fmtLoad(stats ? stats.load : null, stats ? stats.loadDelta : null)} testId="proton-load" />
      <HudMeta>{live && stats ? `load across all launches · live · ${fmtClock(live.asOf)}` : 'no live data yet'}</HudMeta>
      {onOpenAgent ? (
        <button type="button" className="carbon-hud__btn" style={{ marginTop: 8 }} onClick={() => onOpenAgent(agent)} data-testid="proton-explore">
          {COPY.protons.explore}
        </button>
      ) : null}
    </div>
  );
}

function moleculeName(m: LiveMolecule): string {
  return m.ticker ? `$${m.ticker}` : `launch ${m.launchId.slice(0, 8)}`;
}

// ───────────────────────────── 06 chamber ─────────────────────────────

export function ChamberHud({
  value,
  onChange,
  heavyAgent,
  onHeavyAgentChange,
  leaderRef = noRef,
  compact = false,
}: {
  value: IsotopeId;
  onChange?: (v: IsotopeId) => void;
  heavyAgent: AgentId | null;
  onHeavyAgentChange?: (a: AgentId | null) => void;
  leaderRef?: LeaderRefFn;
  compact?: boolean;
}) {
  const iso = ISOTOPES[value];
  return (
    <div data-testid="chamber-hud">
      <div className="carbon-carousel" role="radiogroup" aria-label="Isotope">
        {ISOTOPE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === value}
            aria-pressed={id === value}
            className="carbon-hud__btn"
            onClick={() => onChange?.(id)}
            data-testid={`isotope-${id}`}
          >
            {`[ ${id} ]`}
          </button>
        ))}
      </div>
      {!compact ? <div style={{ height: 8 }} /> : null}
      <HudLabel leaderRef={leaderRef('pedestal')}>{iso.label}</HudLabel>
      <HudReadout label="NEUTRONS" value={String(iso.neutrons)} testId="chamber-neutrons" />
      <HudReadout label="STABILITY" value={fmtStability(value)} testId="chamber-stability" />
      <HudReadout label="DECAY_RULE" value={fmtDecayRule(value)} testId="chamber-decay-rule" />
      <div className="carbon-hud__readout" style={{ whiteSpace: 'normal' }} data-testid="chamber-behaviour">
        BEHAVIOUR {iso.name} · {iso.behaviour}
      </div>
      {!iso.stable ? <HudMeta>{`decay · ${fmtDecayRule(value).toLowerCase()}`}</HudMeta> : null}
      <HudMeta>{iso.realWorldNote}</HudMeta>
      {iso.heavyAgent ? (
        <div style={{ marginTop: 6 }} data-testid="heavy-picker">
          <HudMeta>{COPY.chamber.heavyHint}</HudMeta>
          <HudMeta>{COPY.chamber.heavyPick}</HudMeta>
          <div className="carbon-carousel" style={{ justifyContent: 'flex-start', marginTop: 4 }} role="radiogroup" aria-label="Heavy agent">
            {AGENT_IDS.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={heavyAgent === a}
                aria-pressed={heavyAgent === a}
                className="carbon-hud__btn"
                onClick={() => onHeavyAgentChange?.(a)}
                data-testid={`heavy-${a}`}
              >
                {a.toUpperCase()}
              </button>
            ))}
          </div>
          <HudReadout label="HEAVY_AGENT" value={heavyAgent ? heavyAgent.toUpperCase() : EMPTY_READOUT} testId="heavy-agent" />
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────── 07 shapes ─────────────────────────────

export function ShapeLabel({ shape, leaderRef = noRef, selected, onSelect }: { shape: ShapeId; leaderRef?: LeaderRefFn; selected?: boolean; onSelect?: (s: ShapeId) => void }) {
  const s = SHAPES[shape];
  return (
    <div data-testid={`shape-${shape}`} style={{ marginBottom: 10 }}>
      <HudLabel leaderRef={leaderRef(`shape:${shape}`)}>{s.label}</HudLabel>
      <div className="carbon-hud__note">{s.description}</div>
      <HudReadout label={COPY.shapes.threshold} value={String(s.sentinelThreshold)} />
      {onSelect ? (
        <button type="button" className="carbon-hud__btn" aria-pressed={!!selected} onClick={() => onSelect(shape)} style={{ marginTop: 4 }}>
          {selected ? `${shape.toUpperCase()} · SELECTED` : `PICK ${shape.toUpperCase()}`}
        </button>
      ) : null}
    </div>
  );
}

export function ShapesHud({ leaderRef = noRef, value, onChange }: { leaderRef?: LeaderRefFn; value?: ShapeId | null; onChange?: (s: ShapeId) => void }) {
  return (
    <div data-testid="shapes-hud">
      {SHAPE_IDS.map((s) => (
        <ShapeLabel key={s} shape={s} leaderRef={leaderRef} selected={value === s} onSelect={onChange} />
      ))}
    </div>
  );
}

// ───────────────────────────── 08 replay ─────────────────────────────

export function ReplayHud({
  replay,
  replayed,
  caTyped,
  leaderRef = noRef,
}: {
  replay: LaunchReplay | null;
  /** Hand-offs replayed so far (scroll-driven). */
  replayed: number;
  /** Text node content for the CA typing line (story writes it imperatively). */
  caTyped?: string;
  leaderRef?: LeaderRefFn;
}) {
  if (!replay) {
    return (
      <div data-testid="replay-empty" data-honesty="empty">
        <HudLabel leaderRef={leaderRef('coin')}>{COPY.launch.emptyTitle}</HudLabel>
        <div className="carbon-hud__note">{COPY.launch.empty}</div>
        <HudReadout label={COPY.launch.ca} value={EMPTY_READOUT} />
      </div>
    );
  }
  const shown = replay.handoffs.slice(0, replayed);
  const last = shown.slice(-4);
  return (
    <div data-testid="replay-hud" data-honesty="replay">
      <span className="carbon-hud__tag" style={{ textTransform: 'none' }} data-testid="replay-label">
        {replayLabel(replay.ticker, replay.deployedAt)}
      </span>
      <div style={{ height: 6 }} />
      <HudLabel leaderRef={leaderRef('coin')}>{`COIN_${replay.ticker.replace(/^\$/, '')}`}</HudLabel>
      <HudReadout label="ISOTOPE" value={replay.isotope} />
      <HudReadout label="SHAPE" value={replay.shape.toUpperCase()} />
      <HudReadout label={COPY.launch.score} value={replay.score ? `${replay.score.score}/100 · ${replay.score.passed ? 'PASSED' : 'BLOCKED'}` : EMPTY_READOUT} />
      <HudReadout label={COPY.launch.handoffs} value={`${shown.length}/${replay.handoffs.length}`} testId="replay-count" />
      {last.map((h) => (
        <div key={h.id} className="carbon-hud__readout carbon-hud__meta" style={{ whiteSpace: 'normal' }}>
          {`// ${shortHash(h.id)} ${h.payload.from.toUpperCase()}→${h.payload.to.toUpperCase()}`}
        </div>
      ))}
      <div className="carbon-hud__readout" data-testid="replay-ca" style={{ marginTop: 6 }}>
        {`${COPY.launch.ca} `}
        <span data-ca-typing>{caTyped ?? ''}</span>
      </div>
      <HudMeta>{`${replay.network} · ${fmtDate(replay.deployedAt)}`}</HudMeta>
    </div>
  );
}

// ───────────────────────────── 09 live ─────────────────────────────

export function GrapheneHud({
  launches,
  hovered,
  onLaunch,
  launchHref,
}: {
  launches: readonly LaunchSummary[];
  hovered: LaunchSummary | null;
  onLaunch?: () => void;
  launchHref?: string;
}) {
  return (
    <div data-testid="graphene-hud" data-honesty="live">
      {launches.length === 0 ? (
        <div className="carbon-hud__empty" data-testid="graphene-empty">
          {EMPTY_GRAPHENE}
        </div>
      ) : (
        <>
          <HudReadout label="MOLECULES" value={String(launches.length)} testId="graphene-count" />
          <HudMeta testId="graphene-legend">one crystal per launch · form = shape · size = neutrons (isotope) · shimmer = decaying</HudMeta>
          <HudMeta>{COPY.live.fly}</HudMeta>
          {hovered ? (
            <div data-testid="graphene-hovered" style={{ marginTop: 6 }}>
              <HudLabel>{`$${hovered.ticker.replace(/^\$/, '')}`}</HudLabel>
              <HudReadout label="ISOTOPE" value={hovered.isotope} />
              <HudReadout label="SHAPE" value={hovered.shape.toUpperCase()} />
              <HudReadout label="CA" value={shortCa(hovered.ca)} />
              <HudMeta>{`${hovered.network} · ${fmtDate(hovered.deployedAt)}${hovered.collapsed ? ' · decayed' : ''}`}</HudMeta>
            </div>
          ) : null}
        </>
      )}
      <div style={{ marginTop: 8 }}>
        {launchHref ? (
          <a className="carbon-hud__btn" href={launchHref} data-testid="launch-cta" style={{ display: 'inline-block', textDecoration: 'none' }}>
            [ {COPY.live.launch} ]
          </a>
        ) : onLaunch ? (
          <button type="button" className="carbon-hud__btn" onClick={onLaunch} data-testid="launch-cta">
            [ {COPY.live.launch} ]
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ThinkingPanel({ items }: { items: readonly ThinkingItem[] }) {
  return (
    <HudPanel title={COPY.live.feedHead} testId="thinking-panel">
      {items.length === 0 ? (
        <div className="carbon-hud__empty">{COPY.live.feedEmpty}</div>
      ) : (
        <ul>
          {items.map((t) => (
            <li key={t.eventId}>
              <span className="carbon-hud__meta">{`${fmtClock(t.ts)} ${t.agent.toUpperCase()} ${shortHash(t.eventId)} `}</span>
              {t.text}
            </li>
          ))}
        </ul>
      )}
    </HudPanel>
  );
}

export function ReceiptsPanel({ items }: { items: readonly ReceiptItem[] }) {
  return (
    <HudPanel title={COPY.live.receiptsHead} testId="receipts-panel">
      {items.length === 0 ? (
        <div className="carbon-hud__empty">{COPY.live.receiptsEmpty}</div>
      ) : (
        <ul>
          {items.map((r) => (
            <li key={r.splitId}>
              <span className="carbon-hud__meta">{`${fmtClock(r.at)} `}</span>
              {`SPLIT ${fmtLamports(r.totalLamports)} · ${r.legs.filter((l) => l.status === 'confirmed').length}/${r.legs.length} confirmed`}
            </li>
          ))}
        </ul>
      )}
    </HudPanel>
  );
}

// ───────────────────────────── sentinel ─────────────────────────────

export function SentinelHud({ report }: { report: SentinelReport | null }) {
  if (!report) {
    return (
      <div data-testid="sentinel-empty">
        <HudLabel>SENTINEL_CHECK</HudLabel>
        <HudReadout label="STABILITY" value={EMPTY_READOUT} />
      </div>
    );
  }
  return (
    <div data-testid="sentinel-hud">
      <HudLabel>SENTINEL_CHECK</HudLabel>
      <HudReadout label="STABILITY" value={`${report.score}/100 · ≥${report.threshold}`} testId="sentinel-score" />
      <HudReadout value={report.passed ? 'PASSED · LOCKED' : report.hardFail ? 'BLOCKED · HARD FAIL' : 'BLOCKED · BELOW THRESHOLD'} testId="sentinel-verdict" />
      {report.inputs.map((i) => (
        <div key={i.key} className="carbon-hud__readout" style={{ whiteSpace: 'normal' }}>
          {`${i.key.toUpperCase()} ${i.points}/${i.max}${i.hardFail ? ' HARD_FAIL' : ''} `}
          <span className="carbon-hud__meta">{`// ${i.reason}`}</span>
        </div>
      ))}
      <HudMeta>{`run ${report.run}`}</HudMeta>
    </div>
  );
}

export { HudSection };
