'use client';
/**
 * Scroll plumbing: Lenis drives the page scroll and writes the progress
 * store; anime.js v4 onScroll observers scrub the 2D/HUD chapter layers.
 * Both read the SAME scroll offset over geometry derived from the SAME
 * chapter table (marker i spans exactly chapter i, laid out in px from the
 * measured scroll distance), so HUD and 3D agree at every scroll position,
 * forward or back.
 */
import { animate, onScroll } from 'animejs';
import Lenis from 'lenis';
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { CHAPTER_COUNT, CHAPTER_RANGES, chapterFade } from './chapters.js';
import type { ProgressStore } from './progress.js';

export function useReducedMotion(override?: boolean): boolean {
  const [rm, setRm] = useState(false);
  useEffect(() => {
    if (override !== undefined) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setRm(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [override]);
  return override ?? rm;
}

/** Re-render only when selector(progress) changes. */
export function useStoreSelector<T>(store: ProgressStore, selector: (p: number) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}

/** Writes a chapter layer's scroll-scrubbed state (opacity = chapterFade, slight drift). */
export function applyLayer(layer: HTMLElement, i: number, p: number, onFade?: (i: number, o: number) => void): void {
  const o = chapterFade(p, i);
  onFade?.(i, o);
  const vis = o > 0.002;
  layer.style.opacity = vis ? o.toFixed(3) : '0';
  layer.style.transform = `translate3d(0, ${((0.5 - p) * 14).toFixed(2)}px, 0)`;
  layer.style.visibility = vis ? 'visible' : 'hidden';
  layer.dataset.fade = o.toFixed(3);
  layer.dataset.active = o > 0.5 ? 'true' : 'false';
  layer.setAttribute('aria-hidden', o > 0.5 ? 'false' : 'true');
}

/**
 * Binds window scroll over `track` to the store (Lenis owns the page scroll
 * while mounted when smooth=true), lays the chapter markers out, and (unless
 * reduced motion) creates one anime.js onScroll observer per chapter that
 * scrubs that chapter's HUD layer.
 */
export function useStoryScroll(opts: {
  track: RefObject<HTMLElement | null>;
  markers: RefObject<(HTMLElement | null)[]>;
  layers: RefObject<(HTMLElement | null)[]>;
  store: ProgressStore;
  smooth: boolean;
  anime: boolean;
  /** Receives each layer's opacity (leader lines follow their label's layer). */
  onFade?: (i: number, o: number) => void;
}): void {
  const { track, markers, layers, store, smooth, anime, onFade } = opts;
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let top = 0;
    let dist = 1;
    const observers: { refresh(): unknown }[] = [];
    const measure = () => {
      const r = el.getBoundingClientRect();
      top = r.top + window.scrollY;
      dist = Math.max(1, el.offsetHeight - window.innerHeight);
      const ms = markers.current ?? [];
      for (let i = 0; i < CHAPTER_COUNT; i++) {
        const m = ms[i];
        const cr = CHAPTER_RANGES[i]!;
        if (!m) continue;
        m.style.top = `${cr.start * dist}px`;
        m.style.height = `${(cr.end - cr.start) * dist}px`;
      }
      observers.forEach((o) => o.refresh());
    };
    const write = (y: number) => store.set((y - top) / dist);
    measure();

    const cleanups: (() => void)[] = [];
    if (anime) {
      for (let i = 0; i < CHAPTER_COUNT; i++) {
        const marker = markers.current?.[i];
        const layer = layers.current?.[i];
        if (!marker || !layer) continue;
        const driver = { p: 0 };
        const apply = () => applyLayer(layer, i, driver.p, onFade);
        const observer = onScroll({
          target: marker,
          enter: { target: 'top', container: 'top' },
          leave: { target: 'bottom', container: 'top' },
          sync: true,
        });
        observers.push(observer);
        const anim = animate(driver, { p: [0, 1], ease: 'linear', duration: 1000, autoplay: observer, onUpdate: apply, onRender: apply });
        apply();
        cleanups.push(() => {
          anim.revert();
          observer.revert();
        });
      }
    }

    let lenis: Lenis | null = null;
    if (smooth) {
      lenis = new Lenis({ autoRaf: true, lerp: 0.09, smoothWheel: true, syncTouch: false });
      lenis.on('scroll', (l: Lenis) => write(l.scroll));
    }
    const onScrollNative = () => write(window.scrollY);
    const onResize = () => {
      measure();
      write(window.scrollY);
    };
    window.addEventListener('scroll', onScrollNative, { passive: true });
    window.addEventListener('resize', onResize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(el);
    write(window.scrollY);
    return () => {
      lenis?.destroy();
      window.removeEventListener('scroll', onScrollNative);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      cleanups.forEach((c) => c());
    };
  }, [track, markers, layers, store, smooth, anime, onFade]);
}
