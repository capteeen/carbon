import { describe, expect, it } from 'vitest';
import {
  EMPTY_READOUT,
  fmtBonds,
  fmtCountdown,
  fmtDate,
  fmtDelta,
  fmtLamports,
  fmtLoad,
  fmtNumber,
  isEventId,
  meta,
  replayLabel,
  sectionHead,
  shortCa,
  shortHash,
  snake,
  typedCa,
} from '../src/hud/format.js';

const ID = 'ab'.repeat(32);

describe('HUD formatting', () => {
  it('empty readout is "--.--"', () => expect(EMPTY_READOUT).toBe('--.--'));

  it('numbers and deltas', () => {
    expect(fmtNumber(41.08)).toBe('41.08');
    expect(fmtNumber(3.5)).toBe('03.50');
    expect(fmtDelta(2.13)).toBe('+02.13');
    expect(fmtDelta(-0.4)).toBe('-00.40');
    expect(fmtNumber(null)).toBe('--.--');
    expect(fmtNumber(Number.NaN)).toBe('--.--');
    expect(fmtDelta(Infinity)).toBe('--.--');
  });

  it('BONDS and LOAD never fake a value', () => {
    expect(fmtBonds(3)).toBe('BONDS 3/4');
    expect(fmtBonds(undefined)).toBe('BONDS --.--');
    expect(fmtLoad(41.08, 2.13)).toBe('LOAD 41.08 +02.13');
    expect(fmtLoad(41.08)).toBe('LOAD 41.08');
    expect(fmtLoad(null, 2)).toBe('LOAD --.--');
  });

  it('label grammar', () => {
    expect(snake('hello world-x')).toBe('HELLO_WORLD_X');
    expect(meta('Element 18')).toBe('// Element 18');
    expect(sectionHead('Manifesto')).toBe('////// Manifesto');
  });

  it('hashes: only real 64-hex event ids', () => {
    expect(isEventId(ID)).toBe(true);
    expect(isEventId('ABCD'.repeat(16))).toBe(false);
    expect(isEventId('abc')).toBe(false);
    expect(shortHash(ID)).toBe('abababab');
    expect(shortHash('not-a-hash')).toBe('--.--');
  });

  it('replay label and dates', () => {
    const t = Date.UTC(2026, 9, 11, 13);
    expect(replayLabel('$fixt', t)).toBe('replaying $FIXT, 2026-10-11');
    expect(fmtDate(null)).toBe('--.--');
  });

  it('countdown, CA typing, lamports', () => {
    expect(fmtCountdown(6 * 86_400_000 + 3_661_000)).toBe('06D 01:01:01');
    expect(fmtCountdown(61_000)).toBe('01:01');
    expect(fmtCountdown(-5)).toBe('00:00');
    expect(fmtCountdown(null)).toBe('--.--');
    expect(typedCa('ABCDEF', 3)).toBe('ABC_');
    expect(typedCa('ABCDEF', 99)).toBe('ABCDEF');
    expect(shortCa('ABCDEFGHIJKLMNOP')).toBe('ABCD…MNOP');
    expect(shortCa(null)).toBe('--.--');
    expect(fmtLamports('250000000')).toBe('0.25 SOL');
    expect(fmtLamports('1000000000')).toBe('1 SOL');
    expect(fmtLamports('12.5')).toBe('--.--');
  });
});
