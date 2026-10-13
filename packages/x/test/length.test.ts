import { describe, expect, it } from 'vitest';
import { weightedLength } from '../src/length.js';

describe('weighted length (X counting rules, twitter-text v3 config)', () => {
  it('counts Latin as 1 and enforces 280', () => {
    expect(weightedLength('a'.repeat(280))).toMatchObject({ weightedLength: 280, valid: true });
    expect(weightedLength('a'.repeat(281))).toMatchObject({ weightedLength: 281, valid: false });
  });
  it('counts every URL as 23 regardless of length', () => {
    const long = `https://example.com/${'x'.repeat(200)}`;
    expect(weightedLength(long).weightedLength).toBe(23);
    expect(weightedLength('see https://t.co/a').weightedLength).toBe(4 + 23);
    expect(weightedLength(`${'a'.repeat(257)} ${long}`)).toMatchObject({ weightedLength: 281, valid: false });
    expect(weightedLength(`${'a'.repeat(256)} ${long}`)).toMatchObject({ weightedLength: 280, valid: true });
  });
  it('treats bare domains as URLs and strips trailing punctuation', () => {
    expect(weightedLength('pump.fun').weightedLength).toBe(23);
    expect(weightedLength('go to https://pump.fun/coin/abc.').weightedLength).toBe(6 + 23 + 1);
    expect(weightedLength('$ARGON').weightedLength).toBe(6);
    expect(weightedLength('e.g. this').weightedLength).toBe(9);
  });
  it('counts CJK and other non-Latin as 2', () => {
    expect(weightedLength('炭素').weightedLength).toBe(4);
    expect(weightedLength('炭'.repeat(140)).valid).toBe(true);
    expect(weightedLength('炭'.repeat(141)).valid).toBe(false);
  });
  it('counts each emoji as 2 including ZWJ, skin tone, flags and keycaps', () => {
    expect(weightedLength('🔥').weightedLength).toBe(2);
    expect(weightedLength('👨‍👩‍👧‍👦').weightedLength).toBe(2);
    expect(weightedLength('👍🏽').weightedLength).toBe(2);
    expect(weightedLength('🇯🇵').weightedLength).toBe(2);
    expect(weightedLength('1️⃣').weightedLength).toBe(2);
  });
  it('measures after NFC normalisation', () => {
    expect(weightedLength('é').weightedLength).toBe(weightedLength('é').weightedLength);
    expect(weightedLength('é').weightedLength).toBe(1);
  });
  it('general punctuation inside the v3 ranges weighs 1, outside weighs 2', () => {
    expect(weightedLength(String.fromCodePoint(0x2014, 0x2019)).weightedLength).toBe(2); // em dash, right quote: 8208-8223
    expect(weightedLength(String.fromCodePoint(0x2026)).weightedLength).toBe(2); // ellipsis (8230) is in no range
  });
});
