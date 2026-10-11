'use client';
/**
 * Shared quality state. The scene's frame loop feeds frame times into the
 * ladder; materials/post read `quality.settings` each frame (no React renders),
 * and the Canvas DPR subscribes to level changes.
 */
import { useSyncExternalStore } from 'react';
import { QualityLadder, QUALITY_LEVELS, initialLevel, type LadderOptions, type QualitySettings } from './ladder.js';

export interface QualityStore {
  readonly ladder: QualityLadder;
  readonly settings: Readonly<QualitySettings>;
  level(): number;
  /** Feed a frame time; notifies subscribers on level change. */
  sample(dtMs: number): void;
  setLevel(level: number): void;
  subscribe(fn: () => void): () => void;
}

/**
 * A resolution change resizes the canvas and its render targets, which costs a
 * visible hitch. Level changes that reach React (the Canvas DPR) therefore wait
 * until scrolling has been idle this long; per-frame settings still apply at once.
 */
const SCROLL_IDLE_MS = 350;
let lastScrollAt = -Infinity;
let scrollWatch = false;
function watchScroll(): void {
  if (scrollWatch || typeof window === 'undefined') return;
  scrollWatch = true;
  const mark = () => {
    lastScrollAt = performance.now();
  };
  window.addEventListener('scroll', mark, { passive: true });
  window.addEventListener('touchmove', mark, { passive: true });
  window.addEventListener('wheel', mark, { passive: true });
}

export function createQualityStore(opts?: LadderOptions): QualityStore {
  const ladder = new QualityLadder(opts);
  const subs = new Set<() => void>();
  let published = ladder.level;
  const notify = () => {
    published = ladder.level;
    subs.forEach((fn) => fn());
  };
  watchScroll();
  return {
    ladder,
    get settings() {
      return ladder.settings;
    },
    level: () => published,
    sample(dt) {
      ladder.sample(dt);
      if (ladder.level !== published && (typeof performance === 'undefined' || performance.now() - lastScrollAt > SCROLL_IDLE_MS)) notify();
    },
    setLevel(l) {
      ladder.reset(l);
      notify();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export function useQualityLevel(store: QualityStore): number {
  return useSyncExternalStore(store.subscribe, store.level, store.level);
}

export function settingsFor(level: number): Readonly<QualitySettings> {
  return QUALITY_LEVELS[Math.max(0, Math.min(QUALITY_LEVELS.length - 1, level))]!;
}

/**
 * Store with a starting level from coarse device hints (cores, memory, width).
 * Every level caps DPR at ≤1.5; the ladder then adjusts from measured frame
 * times (grain → fog → points → aberration → resolution).
 */
export function createDeviceQualityStore(opts: Omit<LadderOptions, 'start'> = {}): QualityStore {
  let start = 0;
  if (typeof navigator !== 'undefined' && typeof window !== 'undefined') {
    const nav = navigator as Navigator & { deviceMemory?: number };
    start = initialLevel({ hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, width: window.innerWidth });
  }
  return createQualityStore({ ...opts, start });
}
