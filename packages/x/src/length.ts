/**
 * Weighted post length, following X's "Counting characters" rules and the
 * twitter-text v3 config (see README for sources):
 *   - text is NFC-normalised first
 *   - code points in the v3 ranges weigh 1, everything else 2
 *   - every emoji (including ZWJ sequences, skin tones, flags, keycaps) weighs 2
 *   - every URL weighs 23 regardless of its length
 *   - limit 280
 * URL detection is a reimplementation (scheme URLs, plus bare domains on a
 * list of common TLDs); twitter-text recognises every IANA TLD.
 */

export const MAX_WEIGHTED_LENGTH = 280;
export const TRANSFORMED_URL_LENGTH = 23;
const SCALE = 100;
const DEFAULT_WEIGHT = 200;
const RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 4351, 100],
  [8192, 8205, 100],
  [8208, 8223, 100],
  [8242, 8247, 100],
];

const TLDS = [
  'com', 'net', 'org', 'io', 'xyz', 'fun', 'so', 'ai', 'app', 'dev', 'co', 'gg', 'me', 'tv', 'info', 'biz', 'us',
  'uk', 'ly', 'to', 'sh', 'link', 'site', 'online', 'tech', 'wtf', 'money', 'finance', 'gov', 'edu', 'news', 'xxx',
  'social', 'club', 'live', 'world', 'art', 'lol', 'meme', 'gl', 'de', 'fr', 'jp', 'ca', 'in', 'eu', 'cc', 'ws',
];

const SCHEME_URL = /\bhttps?:\/\/[^\s<>"]+/giu;
const BARE_URL = new RegExp(
  String.raw`(?<![\p{L}\p{N}_@.\/$#-])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS.join('|')})(?![\p{L}\p{N}_-])(?::\d{1,5})?(?:\/[^\s<>"]*)?`,
  'giu',
);
const TRAILING_PUNCT = /[.,!?;:)\]}'"]+$/u;

export interface UrlSpan {
  start: number;
  end: number;
  url: string;
}

/** URL spans (UTF-16 indices) in already-normalised text. */
export function findUrls(text: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  const add = (start: number, raw: string) => {
    const url = raw.replace(TRAILING_PUNCT, '');
    if (!url) return;
    const end = start + url.length;
    if (spans.some((s) => start < s.end && end > s.start)) return;
    spans.push({ start, end, url });
  };
  for (const m of text.matchAll(SCHEME_URL)) add(m.index, m[0]);
  for (const m of text.matchAll(BARE_URL)) add(m.index, m[0]);
  return spans.sort((a, b) => a.start - b.start);
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const PICTO = /\p{Extended_Pictographic}/u;
const REGIONAL = /\p{Regional_Indicator}/u;

function isEmojiGrapheme(g: string): boolean {
  if (REGIONAL.test(g)) return true;
  if (g.includes('⃣')) return true; // keycap sequence
  if (g.includes('️') && PICTO.test(g)) return true;
  for (const ch of g) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xff && PICTO.test(ch)) return true;
  }
  return false;
}

function codePointWeight(cp: number): number {
  for (const [start, end, weight] of RANGES) if (cp >= start && cp <= end) return weight;
  return DEFAULT_WEIGHT;
}

function weightOfPlain(text: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (isEmojiGrapheme(segment)) {
      w += DEFAULT_WEIGHT;
      continue;
    }
    for (const ch of segment) w += codePointWeight(ch.codePointAt(0)!);
  }
  return w;
}

export interface LengthResult {
  weightedLength: number;
  valid: boolean;
  urls: string[];
}

export function weightedLength(input: string): LengthResult {
  const text = input.normalize('NFC');
  const urls = findUrls(text);
  let total = 0;
  let cursor = 0;
  for (const u of urls) {
    total += weightOfPlain(text.slice(cursor, u.start));
    total += TRANSFORMED_URL_LENGTH * SCALE;
    cursor = u.end;
  }
  total += weightOfPlain(text.slice(cursor));
  const weighted = Math.ceil(total / SCALE);
  return {
    weightedLength: weighted,
    valid: text.trim().length > 0 && weighted <= MAX_WEIGHTED_LENGTH,
    urls: urls.map((u) => u.url),
  };
}
