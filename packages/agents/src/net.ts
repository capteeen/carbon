import type { FetchBytes } from './context.js';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export function resolveImageUrl(uri: string): string {
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  return uri;
}

/** Size- and time-limited HTTPS GET for public coin images. */
export const defaultFetchBytes: FetchBytes = async (uri) => {
  const url = new URL(resolveImageUrl(uri));
  if (url.protocol !== 'https:') throw new Error(`refusing non-https image url: ${url.protocol}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error('image too large');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error('image too large');
  return { bytes: buf, mime: res.headers.get('content-type') ?? 'application/octet-stream' };
};
