/**
 * HUD formatting. Pure. Real values only: anything missing, NaN or infinite
 * renders as EMPTY_READOUT ("--.--"), never as a zero or a guess.
 */
import { EMPTY_READOUT, ISOTOPES, VALENCE, type IsotopeId } from '@carbon/core/contracts';

export { EMPTY_READOUT };

type Num = number | null | undefined;

function ok(n: Num): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** 41.08 ; integer part zero-padded to `intDigits`. */
export function fmtNumber(n: Num, intDigits = 2, decimals = 2): string {
  if (!ok(n)) return EMPTY_READOUT;
  const neg = n < 0;
  const [i, d] = Math.abs(n).toFixed(decimals).split('.');
  const body = (i ?? '0').padStart(intDigits, '0') + (decimals > 0 ? '.' + (d ?? '') : '');
  return neg ? '-' + body : body;
}

/** +02.13 / -00.40 ; always signed. */
export function fmtDelta(n: Num, intDigits = 2, decimals = 2): string {
  if (!ok(n)) return EMPTY_READOUT;
  const s = fmtNumber(Math.abs(n), intDigits, decimals);
  return (n < 0 ? '-' : '+') + s;
}

/** "BONDS 3/4" or "BONDS --.--". Bond orders are clamped to valence for display only if the source exceeds it (it never should). */
export function fmtBonds(orders: Num): string {
  if (!ok(orders)) return `BONDS ${EMPTY_READOUT}`;
  const n = Math.max(0, Math.round(orders));
  return `BONDS ${n}/${VALENCE}`;
}

/** "LOAD 41.08 +02.13", "LOAD 41.08" (no delta) or "LOAD --.--". */
export function fmtLoad(load: Num, delta?: Num): string {
  if (!ok(load)) return `LOAD ${EMPTY_READOUT}`;
  return ok(delta) ? `LOAD ${fmtNumber(load)} ${fmtDelta(delta)}` : `LOAD ${fmtNumber(load)}`;
}

/** UPPERCASE_SNAKE label from any phrase: "hello world-x" → "HELLO_WORLD_X". */
export function snake(s: string): string {
  return s
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/** "// text" metadata line. */
export function meta(s: string): string {
  return `// ${s}`;
}

/** "////// Section" head. */
export function sectionHead(s: string): string {
  return `////// ${s}`;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** True for a CarbonEvent id (sha256 hex). Visuals refuse anything else as a hash. */
export function isEventId(id: unknown): id is string {
  return typeof id === 'string' && HEX64.test(id);
}

/** First 8 chars of a real event id, or EMPTY_READOUT. */
export function shortHash(id: string | null | undefined): string {
  return isEventId(id) ? id.slice(0, 8) : EMPTY_READOUT;
}

/** UTC date "2026-10-11" or EMPTY_READOUT. */
export function fmtDate(ts: Num): string {
  if (!ok(ts)) return EMPTY_READOUT;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return EMPTY_READOUT;
  return d.toISOString().slice(0, 10);
}

/** Chapter 08 label: "replaying $TICKER, 2026-10-11". */
export function replayLabel(ticker: string, deployedAt: number): string {
  const t = ticker.replace(/^\$/, '').toUpperCase();
  return `replaying $${t}, ${fmtDate(deployedAt)}`;
}

/** "ISOTOPE_C14" from the contract table. */
export function isotopeLabel(id: IsotopeId): string {
  return ISOTOPES[id].label;
}

function fmtDuration(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400} D`;
  if (sec % 3600 === 0) return `${sec / 3600} H`;
  if (sec % 60 === 0) return `${sec / 60} MIN`;
  return `${sec} S`;
}

/** HALF-LIFE readout for the chamber, from the coin's decay rule (never the real isotope's). */
export function fmtHalfLife(id: IsotopeId): string {
  const d = ISOTOPES[id].decay;
  switch (d.kind) {
    case 'none':
      return 'STABLE';
    case 'quiet':
      return `COIN DECAYS AFTER ${fmtDuration(d.quietSec)} WITHOUT TRADES`;
    case 'clock':
      return `COIN DECAYS ON A ${fmtDuration(d.clockSec)} CLOCK`;
  }
}

export function fmtStability(id: IsotopeId): string {
  return ISOTOPES[id].stable ? 'STABLE' : 'UNSTABLE';
}

/** Countdown "06D 23:59:59" / "19:59" or EMPTY_READOUT. */
export function fmtCountdown(ms: Num): string {
  if (!ok(ms)) return EMPTY_READOUT;
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  if (d > 0) return `${p(d)}D ${p(h)}:${p(m)}:${p(sec)}`;
  if (h > 0) return `${p(h)}:${p(m)}:${p(sec)}`;
  return `${p(m)}:${p(sec)}`;
}

/** CA typing beneath the coin: first `n` chars, then a caret. */
export function typedCa(ca: string, n: number): string {
  const k = Math.max(0, Math.min(ca.length, Math.floor(n)));
  return ca.slice(0, k) + (k < ca.length ? '_' : '');
}

/** Short CA for small HUD: "AbCd…WxYz". */
export function shortCa(ca: string | null | undefined): string {
  if (!ca) return EMPTY_READOUT;
  return ca.length <= 12 ? ca : `${ca.slice(0, 4)}…${ca.slice(-4)}`;
}

/** Lamports string → "0.0123 SOL" (exact decimal, no float drift for display). */
export function fmtLamports(lamports: string | null | undefined): string {
  if (!lamports || !/^\d+$/.test(lamports)) return EMPTY_READOUT;
  const s = lamports.padStart(10, '0');
  const whole = s.slice(0, -9).replace(/^0+(?=\d)/, '');
  const frac = s.slice(-9).replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} SOL`;
}

/** HUD time "12:04:31Z". */
export function fmtClock(ts: Num): string {
  if (!ok(ts)) return EMPTY_READOUT;
  return new Date(ts).toISOString().slice(11, 19) + 'Z';
}
