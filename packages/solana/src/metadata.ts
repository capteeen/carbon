/**
 * Coin metadata on self-hosted IPFS through Pinata (pump.fun no longer
 * accepts direct uploads; see docs/fees-research.md §6).
 *
 *   POST https://uploads.pinata.cloud/v3/files   multipart: file, network=public, name
 *   → { data: { cid, ... } }
 *
 * Image first, then the metadata JSON {name, symbol, description, image,
 * showName, createdOn, twitter?, website?}. The returned uri must be ≤ 200
 * characters (create_v2 limit).
 */
import { ChainConfigError, ChainUnavailableError, errorMessage } from './errors.js';

export const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
export const MAX_URI_LENGTH = 200;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MetadataInput {
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  website?: string;
}

export class PinataUploader {
  constructor(
    private readonly jwt: () => string,
    private readonly gateway: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async upload(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    const form = new FormData();
    form.append('network', 'public');
    form.append('name', filename);
    form.append('file', new Blob([Buffer.from(bytes)], { type: mime }), filename);
    let res: Response;
    try {
      res = await this.fetchImpl(PINATA_UPLOAD_URL, { method: 'POST', headers: { Authorization: `Bearer ${this.jwt()}` }, body: form });
    } catch (e) {
      throw new ChainUnavailableError(`Pinata upload: ${errorMessage(e)}`, { cause: e });
    }
    if (!res.ok) throw new ChainUnavailableError(`Pinata upload returned HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { data?: { cid?: unknown } } | null;
    const cid = body?.data?.cid;
    if (typeof cid !== 'string' || !/^[A-Za-z0-9]{20,}$/.test(cid)) throw new ChainUnavailableError('Pinata upload: response has no CID');
    return cid;
  }

  uri(cid: string): string {
    const base = this.gateway.endsWith('/') ? this.gateway : `${this.gateway}/`;
    return `${base}${cid}`;
  }

  async uploadImage(image: Uint8Array): Promise<string> {
    const mime = sniffImageMime(image);
    return this.uri(await this.upload(image, `image.${mime.split('/')[1]}`, mime));
  }

  /** Upload the metadata JSON for an already-hosted image. */
  async uploadJson(meta: MetadataInput, imageUri: string): Promise<string> {
    if (meta.name.length === 0 || meta.name.length > 32) throw new ChainConfigError('name must be 1-32 characters');
    if (meta.symbol.length === 0 || meta.symbol.length > 10) throw new ChainConfigError('symbol must be 1-10 characters');
    const json: Record<string, unknown> = { name: meta.name, symbol: meta.symbol, description: meta.description, image: imageUri, showName: true, createdOn: 'https://pump.fun' };
    if (meta.twitter) json['twitter'] = meta.twitter;
    if (meta.website) json['website'] = meta.website;
    const uri = this.uri(await this.upload(new TextEncoder().encode(JSON.stringify(json)), 'metadata.json', 'application/json'));
    if (uri.length > MAX_URI_LENGTH) throw new ChainConfigError(`metadata uri is ${uri.length} characters; pump.fun allows ${MAX_URI_LENGTH}`);
    return uri;
  }

  async uploadMetadata(args: MetadataInput & { image: Uint8Array }): Promise<{ metadataUri: string; imageUri: string }> {
    const imageUri = await this.uploadImage(args.image);
    const metadataUri = await this.uploadJson(args, imageUri);
    return { metadataUri, imageUri };
  }
}

export function sniffImageMime(b: Uint8Array): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString() === 'WEBP') return 'image/webp';
  if (b.length >= 6 && Buffer.from(b.subarray(0, 6)).toString().startsWith('GIF8')) return 'image/gif';
  throw new ChainConfigError('image must be PNG, JPEG, WebP or GIF');
}
