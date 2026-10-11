/**
 * The chapter table (SPEC §5 scroll story). Scroll progress 0..1 is the only
 * clock; every layer (3D, HUD, copy, sound) maps progress through THIS table.
 * Pure: no DOM, no three.
 */

export const CHAPTER_KEYS = [
  'HERO',
  'DISMANTLE',
  'GLITCH',
  'SIX_PROTONS',
  'SHELLS',
  'BONDING',
  'ISOTOPE_CHAMBER',
  'SHAPES',
  'THE_LAUNCH',
  'REASSEMBLE_LIVE',
] as const;
export type ChapterKey = (typeof CHAPTER_KEYS)[number];

export interface ChapterDef {
  index: number;
  /** "00".."09" */
  id: string;
  key: ChapterKey;
  /** Relative share of the scroll track. */
  weight: number;
  /**
   * HONESTY: chapters 00-07 are an illustrated explainer and are labelled as
   * such on screen. 08 replays a real recorded launch (or shows an empty state);
   * 09 is live only.
   */
  mode: 'illustration' | 'replay' | 'live';
}

const DEFS: Omit<ChapterDef, 'index' | 'id'>[] = [
  { key: 'HERO', weight: 8, mode: 'illustration' },
  { key: 'DISMANTLE', weight: 9, mode: 'illustration' },
  { key: 'GLITCH', weight: 6, mode: 'illustration' },
  { key: 'SIX_PROTONS', weight: 21, mode: 'illustration' },
  { key: 'SHELLS', weight: 10, mode: 'illustration' },
  { key: 'BONDING', weight: 10, mode: 'illustration' },
  { key: 'ISOTOPE_CHAMBER', weight: 11, mode: 'illustration' },
  { key: 'SHAPES', weight: 8, mode: 'illustration' },
  { key: 'THE_LAUNCH', weight: 8, mode: 'replay' },
  { key: 'REASSEMBLE_LIVE', weight: 9, mode: 'live' },
];

export const CHAPTERS: readonly ChapterDef[] = DEFS.map((d, index) => ({
  ...d,
  index,
  id: String(index).padStart(2, '0'),
}));

export const CHAPTER_COUNT = CHAPTERS.length;

export interface ChapterRange {
  index: number;
  start: number;
  end: number;
}

const TOTAL_WEIGHT = DEFS.reduce((s, d) => s + d.weight, 0);

/** [start, end) progress ranges; the last chapter ends at exactly 1. */
export const CHAPTER_RANGES: readonly ChapterRange[] = (() => {
  let acc = 0;
  return CHAPTERS.map((c, i) => {
    const start = acc / TOTAL_WEIGHT;
    acc += c.weight;
    const end = i === CHAPTERS.length - 1 ? 1 : acc / TOTAL_WEIGHT;
    return { index: i, start, end };
  });
})();

/** Scroll distance of the whole story, in viewport heights. */
export const TRACK_SCREENS = 14;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0;
}

/** Chapter index at progress p (end-exclusive; p = 1 is the last chapter). */
export function chapterAt(p: number): number {
  const q = clamp01(p);
  for (let i = 0; i < CHAPTER_RANGES.length; i++) {
    const r = CHAPTER_RANGES[i]!;
    if (q < r.end) return i;
  }
  return CHAPTER_RANGES.length - 1;
}

/** Local progress 0..1 within chapter `index` at global progress p (clamped). */
export function chapterLocal(p: number, index: number): number {
  const r = CHAPTER_RANGES[index];
  if (!r) return 0;
  return clamp01((clamp01(p) - r.start) / (r.end - r.start));
}

export interface Located {
  index: number;
  local: number;
}

/** Allocation-free locate: writes into `out`. */
export function locate(p: number, out: Located = { index: 0, local: 0 }): Located {
  out.index = chapterAt(p);
  out.local = chapterLocal(p, out.index);
  return out;
}

/** Global progress at the centre of a chapter (used by reduced motion and tests). */
export function chapterCenter(index: number): number {
  const r = CHAPTER_RANGES[index];
  if (!r) return 0;
  return (r.start + r.end) / 2;
}

/** Global progress of a local position inside a chapter. */
export function globalProgress(index: number, local: number): number {
  const r = CHAPTER_RANGES[index];
  if (!r) return 0;
  return r.start + clamp01(local) * (r.end - r.start);
}

/**
 * Envelope used by every 2D layer of a chapter (copy, HUD, leader lines):
 * fades in over the first `edge` of the chapter and out over the last.
 * The anime.js timelines are built with the same keyframes, so a
 * scroll-synced HUD and this function agree.
 */
export const FADE_EDGE = 0.12;
export function chapterFade(local: number, index: number): number {
  const l = clamp01(local);
  const first = index === 0;
  const last = index === CHAPTER_COUNT - 1;
  const fin = first ? 1 : smoothstep(0, FADE_EDGE, l);
  const fout = last ? 1 : 1 - smoothstep(1 - FADE_EDGE, 1, l);
  return Math.min(fin, fout);
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Proton shown in chapter 03 at local progress (0..5, Scout first). */
export function protonAt(local: number): number {
  return Math.min(5, Math.floor(clamp01(local) * 6));
}

/** Bond stage in chapter 05: 0 none yet, 1 single, 2 double, 3 triple. */
export function bondStageAt(local: number): number {
  const l = clamp01(local);
  if (l < 0.1) return 0;
  return Math.min(3, 1 + Math.floor(((l - 0.1) / 0.9) * 3));
}

/** Characters of the CA revealed in chapter 08 (typing beneath the coin). */
export function caCharsAt(local: number, length: number): number {
  return Math.round(smoothstep(0.4, 0.85, local) * length);
}

/** Chapter 08 replay: how many of `n` recorded hand-offs have been replayed at local progress. */
export function replayedCountAt(local: number, n: number): number {
  if (n <= 0) return 0;
  return Math.min(n, Math.floor(smoothstep(0.02, 0.4, local) * n + 1e-9));
}
