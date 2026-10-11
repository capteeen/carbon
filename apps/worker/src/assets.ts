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
    return { uri: `${this.publicUrl.replace(/\/+$/, '')}/api/assets/${encodeURIComponent(launchId)}/${encodeURIComponent(key)}` };
  }
}
