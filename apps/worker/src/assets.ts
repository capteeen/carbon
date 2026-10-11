/**
 * AssetStore (@carbon/agents) in Postgres. Forge's logo copy, banner and site HTML
 * are stored under a name that carries their content hash, so every URI is
 * immutable. The web app serves them at /api/assets/<launchId>/<name>.
 */
import { createHash } from 'node:crypto';
import type { AssetStore } from '@carbon/agents';
import type pg from 'pg';

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export function assetName(name: string, sha256: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'asset';
  return `${sha256.slice(0, 16)}-${clean}`;
}

export class PgAssetStore implements AssetStore {
  constructor(
    private readonly pool: pg.Pool,
    /** Public origin of the web app, e.g. https://carbon.example. */
    private readonly publicUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  async put(launchId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ uri: string }> {
    if (bytes.byteLength === 0) throw new Error('asset is empty');
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error(`asset is larger than ${MAX_ASSET_BYTES} bytes`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const key = assetName(name, sha);
    await this.pool.query(
      `INSERT INTO carbon_assets (launch_id, name, mime, bytes, sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (launch_id, name) DO NOTHING`,
      [launchId, key, mime, Buffer.from(bytes), sha, this.now()],
    );
    return { uri: `${this.base()}/${encodeURIComponent(launchId)}/${encodeURIComponent(key)}` };
  }

  /** Bytes behind a URI this store issued (Sentinel reads drafts' logo, banner and site with it, AG-035). */
  async read(uri: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const prefix = `${this.base()}/`;
    if (!uri.startsWith(prefix)) return null;
    const parts = uri.slice(prefix.length).split('/');
    if (parts.length !== 2) return null;
    let launchId: string;
    let name: string;
    try {
      launchId = decodeURIComponent(parts[0]!);
      name = decodeURIComponent(parts[1]!);
    } catch {
      return null;
    }
    const r = await this.pool.query<{ bytes: Buffer; mime: string; sha256: string }>('SELECT bytes, mime, sha256 FROM carbon_assets WHERE launch_id = $1 AND name = $2', [launchId, name]);
    const row = r.rows[0];
    if (!row) return null;
    const bytes = new Uint8Array(row.bytes);
    // The name carries the content hash: never return bytes that do not match it.
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256 || !name.startsWith(row.sha256.slice(0, 16))) return null;
    return { bytes, mime: row.mime };
  }

  private base(): string {
    return `${this.publicUrl.replace(/\/+$/, '')}/api/assets`;
  }
}
