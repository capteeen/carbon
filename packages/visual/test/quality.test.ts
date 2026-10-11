import { describe, expect, it } from 'vitest';
import { DEGRADE_ORDER, MAX_LEVEL, QUALITY_LEVELS, QualityLadder, initialLevel } from '../src/quality/ladder.js';

const feed = (l: QualityLadder, ms: number, n: number) => {
  for (let i = 0; i < n; i++) l.sample(ms);
};

describe('quality ladder', () => {
  it('degrades grain → fog → points → aberration, then resolution', () => {
    const changed: string[] = [];
    for (let i = 1; i <= MAX_LEVEL; i++) {
      const a = QUALITY_LEVELS[i - 1]!;
      const b = QUALITY_LEVELS[i]!;
      const keys = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k]);
      expect(keys.length, `step ${i}`).toBe(1);
      changed.push(keys[0]!);
    }
    expect(changed).toEqual([...DEGRADE_ORDER]);
    const first = (k: string) => changed.indexOf(k);
    expect(first('grain')).toBeLessThan(first('fog'));
    expect(first('fog')).toBeLessThan(first('points'));
    expect(first('points')).toBeLessThan(first('aberration'));
    expect(first('aberration')).toBeLessThan(first('dpr'));
  });

  it('only holds visual settings (HUD truth and bond accuracy are not on the ladder)', () => {
    expect(Object.keys(QUALITY_LEVELS[0]!).sort()).toEqual(['aberration', 'dpr', 'fog', 'grain', 'points']);
  });

  it('steps down one level per slow window and stops at the floor', () => {
    const l = new QualityLadder({ window: 10 });
    feed(l, 30, 10);
    expect(l.level).toBe(1);
    feed(l, 30, 200);
    expect(l.level).toBe(MAX_LEVEL);
    const locked = new QualityLadder({ window: 10, floor: 0 });
    feed(locked, 50, 100);
    expect(locked.level).toBe(0);
  });

  it('ignores outliers and recovers only after sustained fast windows (hysteresis)', () => {
    const l = new QualityLadder({ window: 10, upgradeWindows: 3 });
    feed(l, 1000, 100);
    expect(l.level).toBe(0);
    feed(l, 30, 10);
    expect(l.level).toBe(1);
    feed(l, 8, 20);
    expect(l.level).toBe(1);
    feed(l, 8, 10);
    expect(l.level).toBe(0);
    // a bounce doubles the time needed to upgrade again
    feed(l, 30, 10);
    expect(l.level).toBe(1);
    feed(l, 8, 30);
    expect(l.level).toBe(1);
    feed(l, 8, 30);
    expect(l.level).toBe(0);
  });

  it('frame times near budget hold the level', () => {
    const l = new QualityLadder({ window: 10, start: 3 });
    feed(l, 16.5, 500);
    expect(l.level).toBe(3);
  });

  it('initial level from device hints', () => {
    expect(initialLevel({})).toBe(0);
    expect(initialLevel({ hardwareConcurrency: 4 })).toBe(1);
    expect(initialLevel({ hardwareConcurrency: 4, width: 390 })).toBe(2);
  });
});
