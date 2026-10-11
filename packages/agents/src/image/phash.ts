/**
 * Perceptual logo hash (dHash, 64 bits) on decoded pixels. Pure JS: PNG via
 * pngjs, JPEG via jpeg-js. Hash is 16 hex chars; similarity = Hamming distance.
 */
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

export class UnsupportedImageError extends Error {}

export function sniffFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'other' {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return 'other';
}

export function decodeImage(bytes: Uint8Array): Pixels {
  const fmt = sniffFormat(bytes);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fmt === 'png') {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
  }
  if (fmt === 'jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 128, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new UnsupportedImageError('unsupported image format (PNG and JPEG only)');
}

/** Luma with alpha composited over white (transparent logos hash like they look on a light page). */
function grayscale(p: Pixels): Float64Array {
  const g = new Float64Array(p.width * p.height);
  for (let i = 0; i < g.length; i++) {
    const r = p.data[i * 4]!;
    const gr = p.data[i * 4 + 1]!;
    const b = p.data[i * 4 + 2]!;
    const a = p.data[i * 4 + 3]! / 255;
    const l = 0.299 * r + 0.587 * gr + 0.114 * b;
    g[i] = l * a + 255 * (1 - a);
  }
  return g;
}

/** Box-filter downscale to w×h. */
function resize(gray: Float64Array, sw: number, sh: number, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * sh) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * sw) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / w));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        for (let xx = x0; xx < x1 && xx < sw; xx++) {
          sum += gray[yy * sw + xx]!;
          n++;
        }
      }
      out[y * w + x] = n ? sum / n : 255;
    }
  }
  return out;
}

/** 64-bit difference hash: 9×8 grid, bit = left pixel brighter than right. */
export function dHash(p: Pixels): string {
  if (p.width < 1 || p.height < 1) throw new UnsupportedImageError('empty image');
  const small = resize(grayscale(p), p.width, p.height, 9, 8);
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (small[y * 9 + x]! > small[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hashImageBytes(bytes: Uint8Array): string {
  return dHash(decodeImage(bytes));
}

export function hamming(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) throw new Error('hash must be 16 hex chars');
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
