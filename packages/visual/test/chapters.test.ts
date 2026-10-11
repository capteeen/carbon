import { describe, expect, it } from 'vitest';
import {
  CHAPTERS,
  CHAPTER_RANGES,
  FADE_EDGE,
  bondStageAt,
  caCharsAt,
  chapterAt,
  chapterCenter,
  chapterFade,
  chapterLocal,
  globalProgress,
  locate,
  protonAt,
  replayedCountAt,
} from '../src/story/chapters.js';
import { createProgressStore } from '../src/story/progress.js';

describe('chapter table', () => {
  it('has chapters 00..09 in SPEC order with honest modes', () => {
    expect(CHAPTERS.map((c) => c.id)).toEqual(['00', '01', '02', '03', '04', '05', '06', '07', '08', '09']);
    expect(CHAPTERS.slice(0, 8).every((c) => c.mode === 'illustration')).toBe(true);
    expect(CHAPTERS[8]!.mode).toBe('replay');
    expect(CHAPTERS[9]!.mode).toBe('live');
  });

  it('ranges tile [0,1] contiguously', () => {
    expect(CHAPTER_RANGES[0]!.start).toBe(0);
    expect(CHAPTER_RANGES[9]!.end).toBe(1);
    for (let i = 1; i < CHAPTER_RANGES.length; i++) expect(CHAPTER_RANGES[i]!.start).toBe(CHAPTER_RANGES[i - 1]!.end);
  });
});

describe('progress → chapter', () => {
  it('maps boundaries end-exclusive and clamps', () => {
    for (const r of CHAPTER_RANGES) {
      expect(chapterAt(r.start)).toBe(r.index);
      expect(chapterAt(chapterCenter(r.index))).toBe(r.index);
    }
    expect(chapterAt(-1)).toBe(0);
    expect(chapterAt(1)).toBe(9);
    expect(chapterAt(2)).toBe(9);
    expect(chapterAt(Number.NaN)).toBe(0);
  });

  it('local and global progress are inverses', () => {
    for (let i = 0; i < 10; i++) {
      for (const l of [0, 0.25, 0.5, 0.99]) {
        const p = globalProgress(i, l);
        expect(chapterAt(p)).toBe(i);
        expect(chapterLocal(p, i)).toBeCloseTo(l, 9);
      }
    }
  });

  it('locate writes into the given object (no allocation)', () => {
    const out = { index: -1, local: -1 };
    expect(locate(chapterCenter(4), out)).toBe(out);
    expect(out.index).toBe(4);
    expect(out.local).toBeCloseTo(0.5);
  });

  it('fade envelope: first chapter starts visible, last ends visible, middle fades at edges', () => {
    expect(chapterFade(0, 0)).toBe(1);
    expect(chapterFade(1, 9)).toBe(1);
    expect(chapterFade(0, 4)).toBe(0);
    expect(chapterFade(1, 4)).toBe(0);
    expect(chapterFade(0.5, 4)).toBe(1);
    expect(chapterFade(FADE_EDGE / 2, 4)).toBeCloseTo(0.5);
  });

  it('chapter sub-steps are monotonic in progress', () => {
    let prev = -1;
    for (let l = 0; l <= 1; l += 0.01) {
      const p = protonAt(l);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    expect(protonAt(0)).toBe(0);
    expect(protonAt(1)).toBe(5);
    expect(bondStageAt(0)).toBe(0);
    expect(bondStageAt(0.2)).toBe(1);
    expect(bondStageAt(1)).toBe(3);
    expect(caCharsAt(0, 44)).toBe(0);
    expect(caCharsAt(1, 44)).toBe(44);
    expect(replayedCountAt(1, 0)).toBe(0);
    expect(replayedCountAt(1, 7)).toBe(7);
    expect(replayedCountAt(0, 7)).toBe(0);
  });
});

describe('progress store', () => {
  it('notifies progress and chapter subscribers; scrolling back rewinds the chapter', () => {
    const s = createProgressStore(0);
    let ticks = 0;
    let chapters = 0;
    s.subscribe(() => ticks++);
    s.subscribeChapter(() => chapters++);
    s.set(0.001);
    expect(ticks).toBe(1);
    expect(chapters).toBe(0);
    s.set(chapterCenter(6));
    expect(s.chapter()).toBe(6);
    s.set(chapterCenter(2));
    expect(s.chapter()).toBe(2);
    expect(chapters).toBe(2);
    s.set(chapterCenter(2));
    expect(ticks).toBe(3);
    s.set(5);
    expect(s.get()).toBe(1);
  });
});
