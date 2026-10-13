/**
 * Sentinel check choreography (pure). Triggered only by a real sentinel.score
 * event; a report already present at mount renders in its final state.
 */
import type { SentinelReport } from '@argon/core/contracts';

export interface GaugeSegment {
  key: string;
  start: number;
  end: number;
  /** points / max, 0..1 */
  fill: number;
  hardFail: boolean;
}

/** Ring gauge: one arc per input, arc length ∝ the input's max points. */
export function gaugeSegments(report: SentinelReport | null): GaugeSegment[] {
  if (!report || report.inputs.length === 0) return [];
  const total = report.inputs.reduce((s, i) => s + Math.max(0, i.max), 0);
  if (total <= 0) return [];
  let acc = 0;
  return report.inputs.slice(0, 8).map((i) => {
    const start = acc / total;
    acc += Math.max(0, i.max);
    const end = acc / total;
    const fill = i.max > 0 ? Math.max(0, Math.min(1, i.points / i.max)) : 0;
    return { key: i.key, start, end, fill, hardFail: i.hardFail };
  });
}

export const SEAM_GROW_S = 0.45;
export const INPUT_FILL_S = 0.4;

export interface SentinelPhase {
  /** Check seams from Sentinel to every atom, 0..1 growth (all at once). */
  seams: number;
  /** Per-input fill factor 0..1 (input by input). */
  fills: number[];
  /** All inputs filled. */
  done: boolean;
  /** Lock flash 0..1 (pass only), decays after done. */
  lock: number;
  /** Red broken seams (block only, persist after done). */
  broken: boolean;
}

/** Phase of the check `ageS` seconds after the event arrived (Infinity = historical/final). */
export function sentinelPhase(report: SentinelReport, ageS: number): SentinelPhase {
  const n = Math.min(8, report.inputs.length);
  const seams = Math.max(0, Math.min(1, ageS / SEAM_GROW_S));
  const fills: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = SEAM_GROW_S + i * INPUT_FILL_S;
    fills.push(Math.max(0, Math.min(1, (ageS - t0) / INPUT_FILL_S)));
  }
  const doneAt = SEAM_GROW_S + n * INPUT_FILL_S;
  const done = ageS >= doneAt;
  const since = ageS - doneAt;
  const lock = report.passed && done && Number.isFinite(since) ? Math.exp(-since * 2.5) : 0;
  return { seams, fills, done, lock, broken: done && !report.passed };
}
