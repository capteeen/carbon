/**
 * Postgres persistence: encrypted token rows (x_tokens) and the 24h post
 * dedupe ledger (x_post_dedupe). Takes any pg-compatible `query` function, so
 * the app can pass its own Pool.
 */
import { TokenCipher } from './crypto.js';
import { XConnectionTakenError } from './errors.js';
import { X_MIGRATION_0002_SQL, X_MIGRATION_SQL } from './migration.js';

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface StoredTokens {
  launchId: string;
  xUserId: string;
  xHandle: string;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date;
  scopes: string[];
  /**
   * The launcher wallet that started the OAuth flow (signed, sealed in the flow
   * cookie). A connection counts only for a launch created by this wallet.
   * null/absent = unbound, which is never treated as connected.
   */
  wallet?: string | null;
}

/** What callers may see about a connection: never tokens. */
export interface XConnection {
  launchId: string;
  xUserId: string;
  xHandle: string;
  scopes: string[];
  /** The launcher wallet this connection is bound to. */
  wallet: string | null;
}

export interface TokenStore {
  get(launchId: string): Promise<StoredTokens | null>;
  /**
   * Insert, or replace the launch's row only when it is bound to the same wallet (or to
   * none). A row bound to another wallet is never overwritten: XConnectionTakenError (AG-036).
   */
  put(tokens: StoredTokens): Promise<void>;
  delete(launchId: string): Promise<void>;
}

export type DedupeReservation = { ok: true } | { ok: false; postId: string | null; postedAt: Date };

export interface PostLedger {
  /** Atomically reserve `textSha256` for this launch unless reserved within the window. */
  reserve(launchId: string, textSha256: string, kind: 'post' | 'reply', now: Date, windowMs: number): Promise<DedupeReservation>;
  markPublished(launchId: string, textSha256: string, postId: string): Promise<void>;
  /** Drop a pending reservation after a call that definitely did not publish. */
  release(launchId: string, textSha256: string): Promise<void>;
}

export async function migrate(db: Queryable): Promise<void> {
  await db.query(X_MIGRATION_SQL);
  await db.query(X_MIGRATION_0002_SQL);
}

function aadFor(launchId: string, xUserId: string): string {
  return `carbon/x_tokens/v1|${launchId}|${xUserId}`;
}

export class PgTokenStore implements TokenStore {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: TokenCipher,
  ) {}

  async get(launchId: string): Promise<StoredTokens | null> {
    const { rows } = await this.db.query(
      'SELECT launch_id, x_user_id, x_handle, token_ciphertext, scopes, access_expires_at, wallet FROM x_tokens WHERE launch_id = $1',
      [launchId],
    );
    const r = rows[0];
    if (!r) return null;
    const sealed = r.token_ciphertext instanceof Uint8Array ? r.token_ciphertext : Uint8Array.from(r.token_ciphertext);
    const secret = JSON.parse(this.cipher.open(sealed, aadFor(r.launch_id, r.x_user_id))) as {
      accessToken: string;
      refreshToken: string | null;
    };
    return {
      launchId: r.launch_id,
      xUserId: r.x_user_id,
      xHandle: r.x_handle,
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
      accessExpiresAt: new Date(r.access_expires_at),
      scopes: r.scopes,
      wallet: r.wallet ?? null,
    };
  }

  async put(t: StoredTokens): Promise<void> {
    const sealed = this.cipher.seal(
      JSON.stringify({ accessToken: t.accessToken, refreshToken: t.refreshToken }),
      aadFor(t.launchId, t.xUserId),
    );
    // A connection is replaced only by the wallet that started it (AG-036): an unbound row
    // (never counted as connected) may be replaced; a row bound to another wallet may not.
    const { rows } = await this.db.query(
      `INSERT INTO x_tokens (launch_id, x_user_id, x_handle, token_ciphertext, scopes, access_expires_at, wallet)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (launch_id) DO UPDATE SET
         x_user_id = EXCLUDED.x_user_id, x_handle = EXCLUDED.x_handle,
         token_ciphertext = EXCLUDED.token_ciphertext, scopes = EXCLUDED.scopes,
         access_expires_at = EXCLUDED.access_expires_at, wallet = EXCLUDED.wallet, updated_at = now()
       WHERE x_tokens.wallet IS NULL OR x_tokens.wallet = EXCLUDED.wallet
       RETURNING launch_id`,
      [t.launchId, t.xUserId, t.xHandle, Buffer.from(sealed), t.scopes, t.accessExpiresAt, t.wallet ?? null],
    );
    if (rows.length === 0) throw new XConnectionTakenError(t.launchId);
  }

  async delete(launchId: string): Promise<void> {
    await this.db.query('DELETE FROM x_tokens WHERE launch_id = $1', [launchId]);
  }
}

export class PgPostLedger implements PostLedger {
  constructor(private readonly db: Queryable) {}

  async reserve(launchId: string, textSha256: string, kind: 'post' | 'reply', now: Date, windowMs: number): Promise<DedupeReservation> {
    const cutoff = new Date(now.getTime() - windowMs);
    const ins = await this.db.query(
      `INSERT INTO x_post_dedupe (launch_id, text_sha256, kind, status, post_id, created_at)
       VALUES ($1, $2, $3, 'pending', NULL, $4)
       ON CONFLICT (launch_id, text_sha256) DO UPDATE SET
         kind = EXCLUDED.kind, status = 'pending', post_id = NULL, created_at = EXCLUDED.created_at
       WHERE x_post_dedupe.created_at < $5
       RETURNING launch_id`,
      [launchId, textSha256, kind, now, cutoff],
    );
    if (ins.rows.length > 0) return { ok: true };
    const { rows } = await this.db.query(
      'SELECT post_id, created_at FROM x_post_dedupe WHERE launch_id = $1 AND text_sha256 = $2',
      [launchId, textSha256],
    );
    const r = rows[0];
    return { ok: false, postId: r?.post_id ?? null, postedAt: r ? new Date(r.created_at) : now };
  }

  async markPublished(launchId: string, textSha256: string, postId: string): Promise<void> {
    await this.db.query(
      `UPDATE x_post_dedupe SET status = 'published', post_id = $3 WHERE launch_id = $1 AND text_sha256 = $2`,
      [launchId, textSha256, postId],
    );
  }

  async release(launchId: string, textSha256: string): Promise<void> {
    await this.db.query(
      `DELETE FROM x_post_dedupe WHERE launch_id = $1 AND text_sha256 = $2 AND status = 'pending'`,
      [launchId, textSha256],
    );
  }
}
