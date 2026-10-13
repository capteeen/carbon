/**
 * Runs against the local Postgres test database (carbon_test) in a throwaway
 * schema. Set ARGON_TEST_DATABASE_URL to override.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenCipher, parseTokenKey } from '../src/crypto.js';
import { X_MIGRATION_0002_SQL, X_MIGRATION_SQL } from '../src/migration.js';
import { migrate, PgPostLedger, PgTokenStore } from '../src/store.js';
import { XConnectionTakenError } from '../src/errors.js';
import { connectedTokens } from './helpers.js';

const url = process.env.ARGON_TEST_DATABASE_URL ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';
const schema = `x_test_${process.pid}_${randomBytes(3).toString('hex')}`;
const pool = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
const cipher = new TokenCipher(Uint8Array.from(randomBytes(32)));

beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await migrate(pool); // idempotent
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

describe('migration', () => {
  it('migrations/0001_x_tokens.sql matches the shipped constant', () => {
    expect(readFileSync(new URL('../migrations/0001_x_tokens.sql', import.meta.url), 'utf8')).toBe(X_MIGRATION_SQL);
  });
  it('migrations/0002_x_tokens_wallet.sql matches the shipped constant', () => {
    expect(readFileSync(new URL('../migrations/0002_x_tokens_wallet.sql', import.meta.url), 'utf8')).toBe(X_MIGRATION_0002_SQL);
  });
});

describe('PgTokenStore', () => {
  it('round-trips tokens through AES-256-GCM', async () => {
    const store = new PgTokenStore(pool, cipher);
    const t = connectedTokens('launch-rt');
    await store.put(t);
    expect(await store.get('launch-rt')).toEqual(t);
    expect(await store.get('missing')).toBeNull();
  });

  it('stores the bound launcher wallet (null when unbound)', async () => {
    const store = new PgTokenStore(pool, cipher);
    await store.put(connectedTokens('launch-w', { wallet: 'WalletW' }));
    expect((await store.get('launch-w'))?.wallet).toBe('WalletW');
    await store.put(connectedTokens('launch-u', { wallet: null }));
    expect((await store.get('launch-u'))?.wallet).toBeNull();
  });

  it('[AG-036] a row bound to a wallet is replaced only by that wallet; an unbound row may be bound', async () => {
    const store = new PgTokenStore(pool, cipher);
    await store.put(connectedTokens('launch-taken', { wallet: 'WalletA', xHandle: 'a_acct' }));
    await expect(store.put(connectedTokens('launch-taken', { wallet: 'WalletB', xHandle: 'b_acct' }))).rejects.toBeInstanceOf(XConnectionTakenError);
    await expect(store.put(connectedTokens('launch-taken', { wallet: null, xHandle: 'nobody' }))).rejects.toBeInstanceOf(XConnectionTakenError);
    expect(await store.get('launch-taken')).toMatchObject({ wallet: 'WalletA', xHandle: 'a_acct' });
    await store.put(connectedTokens('launch-taken', { wallet: 'WalletA', xHandle: 'a_acct2' }));
    expect((await store.get('launch-taken'))?.xHandle).toBe('a_acct2');
    await store.put(connectedTokens('launch-unbound', { wallet: null }));
    await store.put(connectedTokens('launch-unbound', { wallet: 'WalletC' }));
    expect((await store.get('launch-unbound'))?.wallet).toBe('WalletC');
  });

  it('stores no plaintext token in any column', async () => {
    const store = new PgTokenStore(pool, cipher);
    const t = connectedTokens('launch-plain', { accessToken: 'PLAINTEXT-ACCESS-SENTINEL-123', refreshToken: 'PLAINTEXT-REFRESH-SENTINEL-456' });
    await store.put(t);
    const { rows } = await pool.query(`SELECT *, token_ciphertext::text AS ct_hex, row_to_json(x_tokens)::text AS whole FROM x_tokens WHERE launch_id = $1`, ['launch-plain']);
    const row = rows[0];
    const raw = Buffer.from(row.token_ciphertext);
    for (const secret of [t.accessToken, t.refreshToken!]) {
      expect(row.whole).not.toContain(secret);
      expect(raw.includes(Buffer.from(secret))).toBe(false);
      expect(row.ct_hex).not.toContain(Buffer.from(secret).toString('hex'));
    }
    expect(row.x_handle).toBe('fixture_project');
    expect(raw[0]).toBe(1); // version byte
  });

  it('refuses a ciphertext moved to another row (AAD binds launch and user)', async () => {
    const store = new PgTokenStore(pool, cipher);
    await store.put(connectedTokens('launch-a'));
    await store.put(connectedTokens('launch-b'));
    await pool.query(`UPDATE x_tokens SET token_ciphertext = (SELECT token_ciphertext FROM x_tokens WHERE launch_id = 'launch-a') WHERE launch_id = 'launch-b'`);
    await expect(store.get('launch-b')).rejects.toThrow();
    await expect(store.get('launch-a')).resolves.not.toBeNull();
  });

  it('cannot be read with a different key', async () => {
    await new PgTokenStore(pool, cipher).put(connectedTokens('launch-k'));
    await expect(new PgTokenStore(pool, new TokenCipher(Uint8Array.from(randomBytes(32)))).get('launch-k')).rejects.toThrow();
  });

  it('delete removes the row', async () => {
    const store = new PgTokenStore(pool, cipher);
    await store.put(connectedTokens('launch-d'));
    await store.delete('launch-d');
    expect(await store.get('launch-d')).toBeNull();
  });
});

describe('PgPostLedger', () => {
  it('reserves atomically, blocks duplicates for the window, releases pending only', async () => {
    const ledger = new PgPostLedger(pool);
    const now = new Date('2026-10-11T00:00:00Z');
    const day = 24 * 3_600_000;
    const results = await Promise.all([1, 2, 3, 4].map(() => ledger.reserve('L', 'h1', 'post', now, day)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    await ledger.markPublished('L', 'h1', '555');
    await ledger.release('L', 'h1'); // published rows are not released
    const dup = await ledger.reserve('L', 'h1', 'post', new Date(now.getTime() + day - 1), day);
    expect(dup).toEqual({ ok: false, postId: '555', postedAt: now });
    expect((await ledger.reserve('L', 'h1', 'post', new Date(now.getTime() + day + 1), day)).ok).toBe(true);
    expect((await ledger.reserve('L2', 'h1', 'post', now, day)).ok).toBe(true); // per launch
    await ledger.release('L2', 'h1');
    expect((await ledger.reserve('L2', 'h1', 'post', now, day)).ok).toBe(true);
  });
});

describe('ARGON_TOKEN_KEY parsing', () => {
  it('accepts 32-byte hex or base64 and rejects anything else', () => {
    const k = randomBytes(32);
    expect(parseTokenKey(k.toString('hex'))).toEqual(Uint8Array.from(k));
    expect(parseTokenKey(k.toString('base64'))).toEqual(Uint8Array.from(k));
    expect(() => parseTokenKey(undefined)).toThrow(/not set/);
    expect(() => parseTokenKey(randomBytes(16).toString('hex'))).toThrow(/32 bytes/);
  });
});
