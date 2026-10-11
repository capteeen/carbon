/**
 * All ten chapter HUD layers. Pure render: the scroll scrub (anime.js) and
 * leader lines attach through refs; tests render this with
 * renderToStaticMarkup to check honesty and empty states.
 */
import { AGENT_IDS, type AgentId, type IsotopeId, type ShapeId } from '@carbon/core/contracts';
import type { Ref } from 'react';
import { COPY } from '../copy.js';
import { HudCorner, HudLabel, HudMeta, HudSection, HudTag } from '../hud/Hud.js';
import { shortHash } from '../hud/format.js';
import { ChamberHud, GrapheneHud, ProtonHud, ReceiptsPanel, ReplayHud, ShapesHud, ThinkingPanel } from '../hud/panels.js';
import type { BondFlash, LaunchReplay, LaunchSummary, LiveStats, ReceiptItem, ThinkingItem } from '../types.js';
import { CHAPTERS } from './chapters.js';

export interface StoryHudProps {
  live: LiveStats | null;
  replay: LaunchReplay | null;
  launches: readonly LaunchSummary[];
  feed: readonly ThinkingItem[];
  receipts: readonly ReceiptItem[];
  recent: readonly BondFlash[];
  onOpenAgent?: (a: AgentId) => void;
  onLaunch?: () => void;
  launchHref?: string;
  isotope: IsotopeId;
  onIsotope?: (v: IsotopeId) => void;
  heavyAgent: AgentId | null;
  onHeavyAgent?: (a: AgentId | null) => void;
  shape: ShapeId;
  onShape?: (s: ShapeId) => void;
  /** ch03 proton index (0..5). */
  proton: number;
  /** ch08 recorded hand-offs replayed so far. */
  replayed: number;
  hovered: LaunchSummary | null;
  /** Chapter shown when reduced motion (stepped fades); ignored otherwise (anime scrubs). */
  activeChapter: number;
  reducedMotion: boolean;
  layerRef?: (i: number) => Ref<HTMLElement>;
  leaderRef?: (id: string) => Ref<HTMLDivElement> | undefined;
}

const none = () => undefined;

export function StoryHud(props: StoryHudProps) {
  const L = props.leaderRef ?? none;
  const layer = (i: number, children: React.ReactNode) => {
    const c = CHAPTERS[i]!;
    return (
      <section
        key={c.id}
        ref={props.layerRef ? props.layerRef(i) : undefined}
        className="carbon-chapter"
        data-chapter={i}
        data-mode={c.mode}
        data-active={props.reducedMotion ? String(props.activeChapter === i) : undefined}
        aria-label={`Chapter ${c.id} ${c.key.replace(/_/g, ' ').toLowerCase()}`}
      >
        {children}
      </section>
    );
  };
  const agent: AgentId = AGENT_IDS[Math.max(0, Math.min(5, props.proton))]!;
  const hashes = props.recent.slice(-3).reverse();

  return (
    <>
      {layer(
        0,
        <>
          <HudCorner at="tl">
            <h1 className="carbon-wordmark">{COPY.hero.wordmark}</h1>
            {COPY.hero.meta.map((m) => (
              <HudMeta key={m}>{m}</HudMeta>
            ))}
          </HudCorner>
          <HudCorner at="tr">
            <HudSection>{COPY.hero.manifestoHead}</HudSection>
            {COPY.hero.manifesto.map((m) => (
              <div key={m}>{m}</div>
            ))}
          </HudCorner>
          <HudCorner at="mr" style={{ top: '62%' }}>
            <HudLabel leaderRef={L('atom')}>ATOM_06</HudLabel>
            <HudMeta>6 protons · 6 neutrons · 6 electrons</HudMeta>
          </HudCorner>
          <HudCorner at="br">
            <HudMeta>{COPY.hero.dragHint}</HudMeta>
            <HudMeta>{COPY.hero.scrollHint}</HudMeta>
          </HudCorner>
        </>,
      )}
      {layer(
        1,
        <HudCorner at="tl">
          <HudSection>{COPY.dismantle.head}</HudSection>
          {COPY.dismantle.lines.map((m) => (
            <HudMeta key={m}>{m}</HudMeta>
          ))}
        </HudCorner>,
      )}
      {layer(
        2,
        <HudCorner at="tl">
          <HudSection>{COPY.glitch.head}</HudSection>
          {COPY.glitch.lines.map((m) => (
            <HudMeta key={m}>{m}</HudMeta>
          ))}
        </HudCorner>,
      )}
      {layer(
        3,
        <>
          <HudCorner at="tl">
            <HudSection>{COPY.protons.head}</HudSection>
            <div className="carbon-hud__note" data-testid="protons-note">
              {COPY.protons.note}
            </div>
          </HudCorner>
          <HudCorner at="br" className="carbon-hud__proton">
            <ProtonHud agent={agent} live={props.live} onOpenAgent={props.onOpenAgent} leaderRef={L} />
            <HudMeta>{COPY.protons.liveReadouts}</HudMeta>
          </HudCorner>
        </>,
      )}
      {layer(
        4,
        <>
          <HudCorner at="tl">
            <HudSection>{COPY.shells.head}</HudSection>
            <div className="carbon-title" data-testid="shells-note">
              {COPY.shells.note}
            </div>
          </HudCorner>
          <HudCorner at="br">
            <HudLabel leaderRef={L('inner')}>SHELL_INNER</HudLabel>
            <HudMeta>{COPY.shells.lines[0]}</HudMeta>
            <div style={{ height: 8 }} />
            <HudLabel leaderRef={L('outer')}>SHELL_OUTER</HudLabel>
            <HudMeta>{COPY.shells.lines[1]}</HudMeta>
          </HudCorner>
        </>,
      )}
      {layer(
        5,
        <>
          <HudCorner at="tl">
            <HudSection>{COPY.bonding.head}</HudSection>
            <HudMeta>{COPY.bonding.hashNote}</HudMeta>
          </HudCorner>
          <HudCorner at="mr" style={{ top: '50%', maxWidth: 'min(40vw, 260px)' }}>
            {COPY.bonding.kinds.map((k, i) => (
              <div key={k.label} style={{ marginBottom: 14 }}>
                <HudLabel leaderRef={L(`bond:${i + 1}`)}>{k.label}</HudLabel>
                <div>{k.copy}</div>
                <HudMeta>{k.rule}</HudMeta>
              </div>
            ))}
          </HudCorner>
          <HudCorner at="bc" testId="bond-hashes">
            {hashes.length === 0 ? (
              <HudMeta>{COPY.bonding.noHashNote}</HudMeta>
            ) : (
              <>
                <HudMeta>{COPY.bonding.realHashNote}</HudMeta>
                {hashes.map((h) => (
                  <div key={h.hash} className="carbon-hud__readout">
                    {`${shortHash(h.hash)} ${h.pairKey.replace('|', '·').toUpperCase()}`}
                  </div>
                ))}
              </>
            )}
          </HudCorner>
        </>,
      )}
      {layer(
        6,
        <>
          <HudCorner at="tl">
            <HudSection>{COPY.chamber.head}</HudSection>
          </HudCorner>
          <HudCorner at="bc" style={{ width: 'calc(100% - 2 * var(--carbon-gutter))', maxWidth: 520, textAlign: 'left' }}>
            <div data-interactive>
              <ChamberHud value={props.isotope} onChange={props.onIsotope} heavyAgent={props.heavyAgent} onHeavyAgentChange={props.onHeavyAgent} leaderRef={L} compact />
            </div>
          </HudCorner>
        </>,
      )}
      {layer(
        7,
        <>
          <HudCorner at="tl">
            <HudSection>{COPY.shapes.head}</HudSection>
          </HudCorner>
          <HudCorner at="br" style={{ maxWidth: 'min(52vw, 360px)' }}>
            <ShapesHud leaderRef={L} value={props.shape} onChange={props.onShape} />
          </HudCorner>
        </>,
      )}
      {layer(
        8,
        <>
          <HudCorner at="tl">
            <HudSection>{COPY.launch.head}</HudSection>
            <div style={{ height: 6 }} />
            {props.replay ? <HudTag>{COPY.replayTag}</HudTag> : null}
          </HudCorner>
          <HudCorner at="br">
            <ReplayHud replay={props.replay} replayed={props.replayed} leaderRef={L} />
          </HudCorner>
        </>,
      )}
      {layer(
        9,
        <>
          <HudCorner at="tl">
            <HudSection>{COPY.live.head}</HudSection>
            <div style={{ height: 6 }} />
            <HudTag testId="live-tag">{COPY.liveTag}</HudTag>
          </HudCorner>
          <HudCorner at="tr">
            <div data-interactive>
              <GrapheneHud launches={props.launches} hovered={props.hovered} onLaunch={props.onLaunch} launchHref={props.launchHref} />
            </div>
          </HudCorner>
          <HudCorner at="br" style={{ width: 'min(60vw, 340px)' }}>
            <div data-interactive style={{ display: 'grid', gap: 6, textAlign: 'left' }}>
              <ThinkingPanel items={props.feed.slice(-3)} />
              <ReceiptsPanel items={props.receipts} />
            </div>
          </HudCorner>
        </>,
      )}
    </>
  );
}
