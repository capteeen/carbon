/**
 * Shared quality state. The scene's frame loop feeds frame times into the
 * ladder; materials/post read `quality.settings` each frame (no React renders),
 * and the Canvas DPR subscribes to level changes.
 */
import { useSyncExternalStore } from 'react';
import { QualityLadder, QUALITY_LEVELS, type LadderOptions, type QualitySettings } from './ladder.js';

export interface QualityStore {
  readonly ladder: QualityLadder;
  readonly settings: Readonly<QualitySettings>;
  level(): number;
  /** Feed a frame time; notifies subscribers on level change. */
  sample(dtMs: number): void;
  setLevel(level: number): void;
  subscribe(fn: () => void): () => void;
}

export function createQualityStore(opts?: LadderOptions): QualityStore {
  const ladder = new QualityLadder(opts);
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((fn) => fn());
  return {
    ladder,
    get settings() {
      return ladder.settings;
    },
    level: () => ladder.level,
    sample(dt) {
      if (ladder.sample(dt) !== 0) notify();
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
