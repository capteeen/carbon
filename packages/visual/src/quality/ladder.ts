/**
 * Adaptive quality ladder (SPEC §5 PERFORMANCE). Degrades in this exact order:
 *   grain → fog density → point-cloud count → aberration
 * then, only if still slow, render resolution. It NEVER touches HUD values,
 * labels, bond orders, seam counts or hashes: those are not quality settings.
 *
 * Pure and allocation-free per sample (ring buffer + preallocated scratch).
 */

export interface QualitySettings {
  /** Film grain amount multiplier (0 = off). */
  grain: number;
  /** Post fog density multiplier (1 = full volumetric look). */
  fog: number;
  /** Fraction of point-cloud points drawn (nucleus cloud, electron cloud, decay particles). */
  points: number;
  /** Chromatic aberration amount multiplier (0 = off). The glitch pixel-stretch itself stays. */
  aberration: number;
  /** Device-pixel-ratio cap. */
  dpr: number;
}

export const QUALITY_LEVELS: readonly Readonly<QualitySettings>[] = [
  { grain: 1, fog: 1, points: 1, aberration: 1, dpr: 1.5 },
  { grain: 0, fog: 1, points: 1, aberration: 1, dpr: 1.5 }, // 1 grain off
  { grain: 0, fog: 0.55, points: 1, aberration: 1, dpr: 1.5 }, // 2 fog density down
  { grain: 0, fog: 0.55, points: 0.5, aberration: 1, dpr: 1.5 }, // 3 point clouds halved
  { grain: 0, fog: 0.55, points: 0.25, aberration: 1, dpr: 1.5 }, // 4 point clouds quartered
  { grain: 0, fog: 0.55, points: 0.25, aberration: 0, dpr: 1.5 }, // 5 aberration off
  { grain: 0, fog: 0.55, points: 0.25, aberration: 0, dpr: 1 }, // 6 resolution
  { grain: 0, fog: 0.55, points: 0.25, aberration: 0, dpr: 0.75 }, // 7 resolution floor
];

export const MAX_LEVEL = QUALITY_LEVELS.length - 1;

/** Names of the setting each step down degrades, in order (for docs/tests). */
export const DEGRADE_ORDER = ['grain', 'fog', 'points', 'points', 'aberration', 'dpr', 'dpr'] as const;

export interface LadderOptions {
  /** Frame budget in ms (60 fps → 16.67). */
  budgetMs?: number;
  /** Frames per evaluation window. */
  window?: number;
  /** Degrade when the window median exceeds budget × this. */
  degradeAt?: number;
  /** Upgrade when the window's 90th percentile is below budget × this... */
  upgradeAt?: number;
  /** ...for this many consecutive windows. */
  upgradeWindows?: number;
  /** Ignore frames longer than this (tab switches, GC pauses spanning seconds). */
  outlierMs?: number;
  /** Starting level. */
  start?: number;
  /** Lowest level the ladder may reach (e.g. 0 to lock to full quality in a test). */
  floor?: number;
}

export class QualityLadder {
  readonly budgetMs: number;
  private readonly size: number;
  private readonly degradeAt: number;
  private readonly upgradeAt: number;
  private readonly upgradeWindows: number;
  private readonly outlierMs: number;
  private readonly floor: number;
  private readonly buf: Float32Array;
  private readonly scratch: Float32Array;
  private n = 0;
  private goodWindows = 0;
  /** After a bounce (degrade right after an upgrade) upgrades need twice as long. */
  private upgradePenalty = 1;
  private lastChange: 'up' | 'down' | null = null;
  level: number;

  constructor(opts: LadderOptions = {}) {
    this.budgetMs = opts.budgetMs ?? 1000 / 60;
    this.size = opts.window ?? 45;
    this.degradeAt = opts.degradeAt ?? 1.12;
    this.upgradeAt = opts.upgradeAt ?? 0.72;
    this.upgradeWindows = opts.upgradeWindows ?? 4;
    this.outlierMs = opts.outlierMs ?? 250;
    this.floor = Math.min(MAX_LEVEL, Math.max(0, opts.floor ?? MAX_LEVEL));
    this.level = Math.min(this.floor, Math.max(0, opts.start ?? 0));
    this.buf = new Float32Array(this.size);
    this.scratch = new Float32Array(this.size);
  }

  get settings(): Readonly<QualitySettings> {
    return QUALITY_LEVELS[this.level]!;
  }

  /** Feed one frame time. Returns +1 if degraded, -1 if upgraded, 0 otherwise. */
  sample(dtMs: number): -1 | 0 | 1 {
    if (!(dtMs > 0) || dtMs > this.outlierMs) return 0;
    this.buf[this.n++] = dtMs;
    if (this.n < this.size) return 0;
    this.n = 0;
    this.scratch.set(this.buf);
    this.scratch.sort();
    const median = this.scratch[(this.size / 2) | 0]!;
    const p90 = this.scratch[Math.min(this.size - 1, Math.floor(this.size * 0.9))]!;
    if (median > this.budgetMs * this.degradeAt && this.level < this.floor) {
      if (this.lastChange === 'up') this.upgradePenalty = Math.min(8, this.upgradePenalty * 2);
      this.level++;
      this.goodWindows = 0;
      this.lastChange = 'down';
      return 1;
    }
    if (p90 < this.budgetMs * this.upgradeAt && this.level > 0) {
      this.goodWindows++;
      if (this.goodWindows >= this.upgradeWindows * this.upgradePenalty) {
        this.level--;
        this.goodWindows = 0;
        this.lastChange = 'up';
        return -1;
      }
      return 0;
    }
    this.goodWindows = 0;
    return 0;
  }

  reset(level = 0): void {
    this.level = Math.min(this.floor, Math.max(0, level));
    this.n = 0;
    this.goodWindows = 0;
  }
}

/** Initial level from coarse device hints (before any frame is measured). */
export function initialLevel(hints: { hardwareConcurrency?: number; deviceMemory?: number; width?: number }): number {
  let l = 0;
  if ((hints.hardwareConcurrency ?? 8) <= 4 || (hints.deviceMemory ?? 8) <= 4) l = Math.max(l, 1);
  if ((hints.width ?? 1280) < 500 && (hints.hardwareConcurrency ?? 8) <= 4) l = Math.max(l, 2);
  return l;
}
