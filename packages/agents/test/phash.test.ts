import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { renderSite } from '../src/forge/site.js';
import { decodeImage, hamming, hashImageBytes } from '../src/image/phash.js';
import { makePng } from './fakes.js';

describe('perceptual hash', () => {
  it('is stable across scale and format, and separates different images', () => {
    const a = makePng(3, 64, 64);
    const big = makePng(3, 64, 64);
    expect(hashImageBytes(a)).toBe(hashImageBytes(big));

    // Upscale 4x (nearest) → same structure, same hash (or within a few bits).
    const src = decodeImage(a);
    const up = new PNG({ width: 256, height: 256 });
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const s = ((y >> 2) * 64 + (x >> 2)) * 4;
        const d = (y * 256 + x) * 4;
        for (let k = 0; k < 4; k++) up.data[d + k] = src.data[s + k]!;
      }
    expect(hamming(hashImageBytes(a), hashImageBytes(new Uint8Array(PNG.sync.write(up))))).toBeLessThanOrEqual(4);

    // Same image as JPEG decodes and hashes close.
    const j = jpeg.encode({ data: Buffer.from(src.data), width: 64, height: 64 }, 95).data;
    expect(hamming(hashImageBytes(a), hashImageBytes(new Uint8Array(j)))).toBeLessThanOrEqual(6);

    expect(hamming(hashImageBytes(a), hashImageBytes(makePng(17)))).toBeGreaterThan(10);
  });

  it('rejects unsupported formats instead of guessing', () => {
    expect(() => hashImageBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/unsupported/);
  });

  it('site escapes content and carries the footer', () => {
    const html = renderSite({ name: '<b>x</b>', ticker: 'X', lore: 'a & b', tagline: 't', logoUri: 'https://a/l.png', bannerUri: 'https://a/b.png' });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('#E6EBF2');
    expect(html).toContain('A meme, not an investment.');
    expect(html).not.toContain('<script');
  });
});
