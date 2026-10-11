'use client';
/**
 * The single progress store (0..1). Lenis writes it; r3f reads it every frame
 * (store.get()), React HUD subscribes to chapter changes only, anime.js scroll
 * observers read the same scroll offset through markers derived from the
 * same chapter table. Scrolling back rewinds everything because nothing keeps
 * its own clock.
 */
import { useSyncExternalStore } from 'react';
import { chapterAt, clamp01 } from './chapters.js';

export interface ProgressStore {
  get(): number;
  /** Current chapter index (cached; recomputed on set). */
  chapter(): number;
  set(p: number): void;
  /** Called on every progress change. Returns unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** Called only when the chapter index changes. Returns unsubscribe. */
  subscribeChapter(fn: () => void): () => void;
}

export function createProgressStore(initial = 0): ProgressStore {
  let value = clamp01(initial);
  let chapter = chapterAt(value);
  const subs = new Set<() => void>();
  const chapterSubs = new Set<() => void>();
  return {
    get: () => value,
    chapter: () => chapter,
    set(p: number) {
      const v = clamp01(p);
      if (v === value) return;
      value = v;
      const c = chapterAt(v);
      const changed = c !== chapter;
      chapter = c;
      subs.forEach((fn) => fn());
      if (changed) chapterSubs.forEach((fn) => fn());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    subscribeChapter(fn) {
      chapterSubs.add(fn);
      return () => {
        chapterSubs.delete(fn);
      };
    },
  };
}

/** Default story store (one story per page). Components accept their own store too. */
export const progressStore: ProgressStore = createProgressStore(0);

/** Re-renders on every progress change. Use sparingly (3D reads store.get() in useFrame instead). */
export function useProgress(store: ProgressStore = progressStore): number {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Re-renders only when the chapter changes. */
export function useChapter(store: ProgressStore = progressStore): number {
  return useSyncExternalStore(store.subscribeChapter, store.chapter, store.chapter);
}
