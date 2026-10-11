import { describe, it, expect } from 'vitest';
import { BEDS, bedAt, cueStage } from '../src/sound/score.js';
import { CHAPTERS, CHAPTER_RANGES, globalProgress } from '../src/story/chapters.js';

const inputs = { isotope: 'C-12' as const, shape: 'ring' as const, replayHandoffs: 0 };

describe('scroll score', () => {
  it('has one bed per chapter', () => {
    expect(BEDS.length).toBe(CHAPTERS.length);
  });

  it('is continuous across chapter edges (no jumps when scrubbing)', () => {
    for (let i = 1; i < CHAPTERS.length; i++) {
      const edge = CHAPTER_RANGES[i]!.start;
      const a = bedAt(edge - 1e-6);
      const b = bedAt(edge + 1e-6);
      for (let k = 0; k < 3; k++) expect(Math.abs(Math.log(a.freqs[k]! / b.freqs[k]!))).toBeLessThan(0.01);
      expect(Math.abs(a.level - b.level)).toBeLessThan(0.001);
    }
  });

  it("plays a chapter's own bed in its middle", () => {
    const mid = bedAt(globalProgress(6, 0.5));
    expect(mid.freqs[0]).toBeCloseTo(BEDS[6]!.root, 3);
  });

  it('cue stages follow the scene: protons, bond orders', () => {
    expect([0, 0.2, 0.4, 0.6, 0.8, 0.99].map((l) => cueStage(globalProgress(3, l), inputs).stage)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cueStage(globalProgress(5, 0.05), inputs).stage).toBe(0);
    expect(cueStage(globalProgress(5, 0.95), inputs).stage).toBe(3);
  });

  it('chapter 08 stays silent without a real recorded launch', () => {
    for (const l of [0.1, 0.5, 0.9]) expect(cueStage(globalProgress(8, l), inputs).stage).toBe(0);
    expect(cueStage(globalProgress(8, 0.9), { ...inputs, replayHandoffs: 4 }).stage).toBeGreaterThan(0);
  });
});
