'use client';
/**
 * <CarbonStory>: the cinematic scroll story of the carbon atom (SPEC §5),
 * one pinned canvas, scroll progress as the only clock.
 *
 * HONESTY: chapters 00-07 are an illustrated explainer (no live values). HUD
 * readouts come only from `live` ("--.--" when absent). Chapter 08 replays
 * `replay` (a real recorded launch) or shows an empty state. Chapter 09 shows
 * `launches` (real launches) or "No molecules yet. Launch the first one."
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import type { AgentId, IsotopeId, ShapeId } from '@carbon/core/contracts';
import { isValidReplay, validFlashes, validLaunches } from '../data/derive.js';
import { HudLeaders } from '../hud/Hud.js';
import { LeaderRegistry } from '../hud/leaders.js';
import { typedCa } from '../hud/format.js';
import { createDeviceQualityStore, type QualityStore } from '../quality/store.js';
import { SoundToggle } from '../sound/SoundToggle.js';
import { useBondChimes } from '../sound/sound.js';
import { Stage } from '../three/Stage.js';
import { CHAPTERS, TRACK_SCREENS, caCharsAt, chapterLocal, protonAt, replayedCountAt } from './chapters.js';
import { progressStore as defaultStore, useChapter, type ProgressStore } from './progress.js';
import { useReducedMotion, useStoreSelector, useStoryScroll } from './scroll.js';
import { StoryHud } from './StoryHud.js';
import { StoryScene } from './StoryScene.js';
import type { LaunchReplay, LaunchSummary, LiveStats, ReceiptItem, ThinkingItem } from '../types.js';

export interface CarbonStoryProps {
  /** Live agent stats derived from real events (deriveLive). Absent → "--.--". */
  live?: LiveStats | null;
  /** A real recorded launch (buildReplay). Absent → honest empty state in ch08. */
  replay?: LaunchReplay | null;
  /** Real launches for the live graphene (ch09). Empty → EMPTY_GRAPHENE. */
  launches?: readonly LaunchSummary[] | null;
  /** "agent reasoning" items from logged reasoning events. */
  feed?: readonly ThinkingItem[] | null;
  /** Fee-split receipts. */
  receipts?: readonly ReceiptItem[] | null;
  /** "CLICK TO EXPLORE" on a proton: open that agent's live log. */
  onOpenAgent?: (agent: AgentId) => void;
  /** A crystal was clicked (after the fly-in). */
  onOpenLaunch?: (ca: string) => void;
  /** [Launch] in the corner of ch09 (or use launchHref). */
  onLaunch?: () => void;
  launchHref?: string;
  /** Progress store (defaults to the shared one). */
  store?: ProgressStore;
  /** Force reduced motion (defaults to the OS setting). */
  reducedMotion?: boolean;
  /** Let the story own page scroll with Lenis (default true). */
  smoothScroll?: boolean;
  /** Quality store (perf tooling may pass one to read the ladder level). */
  quality?: QualityStore;
  onFirstFrame?: () => void;
  onFrame?: (dtMs: number) => void;
  /** Hard cap on device pixel ratio. */
  maxDpr?: number;
  /** Render the story's own bottom-left "Sound: On/Off" toggle (default true). Pass false when the app layout hosts one. */
  soundToggle?: boolean;
}

export function CarbonStory(props: CarbonStoryProps) {
  const store = props.store ?? defaultStore;
  const reduced = useReducedMotion(props.reducedMotion);
  const track = useRef<HTMLElement | null>(null);
  const markers = useRef<(HTMLElement | null)[]>([]);
  const layers = useRef<(HTMLElement | null)[]>([]);
  const [pin, setPin] = useState<HTMLDivElement | null>(null);
  const leaders = useMemo(() => new LeaderRegistry(), []);
  const quality = useMemo(
    () =>
      props.quality ??
      createDeviceQualityStore(),
    [props.quality],
  );

  // honesty filters: only real ids get drawn
  const live = props.live ?? null;
  const recent = useMemo(() => validFlashes(live?.recentHandoffs), [live]);
  const replay = isValidReplay(props.replay) ? props.replay : null;
  const launches = useMemo(() => validLaunches(props.launches), [props.launches]);
  const feed = props.feed ?? [];
  const receipts = props.receipts ?? [];

  // sound: crystalline tones only for real hand-offs
  useBondChimes(recent);

  // visitor's choices in the illustrated chamber / shapes (illustration only)
  const [isotope, setIsotope] = useState<IsotopeId>('C-12');
  const [heavy, setHeavy] = useState<AgentId | null>(null);
  const [shape, setShape] = useState<ShapeId>('ring');
  const onIsotope = useCallback((v: IsotopeId) => {
    setIsotope(v);
    if (v !== 'C-13') setHeavy(null);
  }, []);
  const [hovered, setHovered] = useState<LaunchSummary | null>(null);

  const onFade = useCallback((i: number, o: number) => leaders.setLayerFade(i, o), [leaders]);
  useStoryScroll({ track, markers, layers, store, smooth: props.smoothScroll !== false && !reduced, anime: !reduced, onFade });
  const chapter = useChapter(store);
  // reduced motion: stepped fades, one layer at a time
  useEffect(() => {
    if (!reduced) return;
    for (let i = 0; i < CHAPTERS.length; i++) leaders.setLayerFade(i, i === chapter ? 1 : 0);
  }, [reduced, chapter, leaders]);
  const proton = useStoreSelector(store, (p) => protonAt(chapterLocal(p, 3)));
  const replayed = useStoreSelector(store, (p) => (replay ? replayedCountAt(chapterLocal(p, 8), replay.handoffs.length) : 0));

  // CA typing beneath the coin: written imperatively (no re-render per character)
  useEffect(() => {
    if (!replay) return;
    const write = () => {
      const el = pin?.querySelector<HTMLElement>('[data-ca-typing]');
      if (!el) return;
      const local = chapterLocal(store.get(), 8);
      const txt = typedCa(replay.ca, reduced ? replay.ca.length : caCharsAt(local, replay.ca.length));
      if (el.textContent !== txt) el.textContent = txt;
    };
    write();
    return store.subscribe(write);
  }, [replay, store, pin, reduced]);

  useEffect(() => {
    if (pin) pin.dataset.chapterHud = String(chapter);
  }, [chapter, pin]);
  // quality level on the pin (perf tooling / debugging); written only on change
  useEffect(() => {
    if (!pin) return;
    const write = () => {
      pin.dataset.quality = String(quality.level());
    };
    write();
    return quality.subscribe(write);
  }, [pin, quality]);
  useEffect(() => leaders.invalidate(), [chapter, proton, leaders]);

  const layerRef = useCallback(
    (i: number): Ref<HTMLElement> =>
      (el: HTMLElement | null) => {
        layers.current[i] = el;
      },
    [],
  );
  const leaderRef = useCallback((id: string) => leaders.labelRef(id), [leaders]);

  const onSelectLaunch = useCallback((l: LaunchSummary) => props.onOpenLaunch?.(l.ca), [props.onOpenLaunch]);

  return (
    <section
      ref={(el) => {
        track.current = el;
      }}
      className="carbon-story"
      style={{ height: `${TRACK_SCREENS * 100}vh` }}
      data-reduced-motion={reduced}
      aria-label="Carbon: the story of the atom"
    >
      <div className="carbon-story__markers" aria-hidden="true">
        {CHAPTERS.map((c, i) => (
          <div
            key={c.id}
            className="carbon-story__marker"
            data-marker={i}
            ref={(el) => {
              markers.current[i] = el;
            }}
          />
        ))}
      </div>
      <div ref={setPin} className="carbon-story__pin" data-testid="story-pin">
        <Stage
          quality={quality}
          leaders={leaders}
          reducedMotion={reduced}
          eventSource={pin}
          onFirstFrame={props.onFirstFrame}
          onFrame={props.onFrame}
          maxDpr={props.maxDpr}
          ariaLabel="Animated carbon atom; the chapter text describes each scene"
        >
          <StoryScene
            store={store}
            leaders={leaders}
            pin={pin}
            recent={recent}
            replay={replay}
            launches={launches}
            isotope={isotope}
            heavyAgent={heavy}
            onHeavyDrop={setHeavy}
            shape={shape}
            onSelectLaunch={onSelectLaunch}
            onHoverLaunch={setHovered}
            hovered={hovered?.ca ?? null}
          />
        </Stage>
        <div className="carbon-hud" data-testid="story-hud">
          <HudLeaders registry={leaders} />
          <StoryHud
            live={live}
            replay={replay}
            launches={launches}
            feed={feed}
            receipts={receipts}
            recent={recent}
            onOpenAgent={props.onOpenAgent}
            onLaunch={props.onLaunch}
            launchHref={props.launchHref}
            isotope={isotope}
            onIsotope={onIsotope}
            heavyAgent={heavy}
            onHeavyAgent={setHeavy}
            shape={shape}
            onShape={setShape}
            proton={proton}
            replayed={replayed}
            hovered={hovered}
            activeChapter={chapter}
            reducedMotion={reduced}
            layerRef={layerRef}
            leaderRef={leaderRef}
          />
        </div>
        {props.soundToggle !== false ? <SoundToggle /> : null}
      </div>
    </section>
  );
}
