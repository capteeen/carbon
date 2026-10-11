import { describe, expect, it } from 'vitest';
import { CHAPTER_RANGES } from '../src/story/chapters.js';
import { createStoryState, evalStory, type StoryState } from '../src/story/timeline.js';

const numericKeys = (s: StoryState) => (Object.keys(s) as (keyof StoryState)[]).filter((k) => typeof s[k] === 'number');

describe('timeline (progress → scene)', () => {
  it('is deterministic: same progress, same state, regardless of the path taken (rewind)', () => {
    const a = createStoryState();
    const b = createStoryState();
    const target = 0.437;
    evalStory(target, 0.46, a);
    // b scrolls far forward, back to the start, then to target
    for (const p of [0.9, 1, 0.2, 0, 0.6]) evalStory(p, 0.46, b);
    evalStory(target, 0.46, b);
    for (const k of numericKeys(a)) expect(b[k], k).toBe(a[k]);
  });

  it('returns the same object (allocation-free) and finite values everywhere', () => {
    const s = createStoryState();
    for (let i = 0; i <= 400; i++) {
      const p = i / 400;
      for (const aspect of [0.46, 1.78]) {
        expect(evalStory(p, aspect, s)).toBe(s);
        for (const k of numericKeys(s)) expect(Number.isFinite(s[k] as number), `${k} at ${p}`).toBe(true);
      }
    }
  });

  it('is continuous: no camera jumps across chapter boundaries', () => {
    const a = createStoryState();
    const b = createStoryState();
    const eps = 1e-5;
    for (const r of CHAPTER_RANGES.slice(1)) {
      evalStory(r.start - eps, 0.46, a);
      evalStory(r.start + eps, 0.46, b);
      for (const k of ['camX', 'camY', 'camZ', 'tgtX', 'tgtY', 'tgtZ', 'fov'] as const) {
        expect(Math.abs(a[k] - b[k]), `${k} at chapter ${r.index}`).toBeLessThan(0.05);
      }
    }
  });

  it('effects stay in range', () => {
    const s = createStoryState();
    for (let i = 0; i <= 200; i++) {
      evalStory(i / 200, 1.2, s);
      for (const k of ['atom', 'glitch', 'aberration', 'flash', 'shells', 'plain', 'chamber', 'shapes', 'coin'] as const) {
        expect(s[k]).toBeGreaterThanOrEqual(0);
        expect(s[k]).toBeLessThanOrEqual(1.0001);
      }
    }
  });
});
