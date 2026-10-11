/**
 * TEST HELPERS ONLY: throwaway keys generated per run, a per-run Postgres
 * schema in carbon_test, and a client wired to a FakeChain.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { LaunchConfig } from '@carbon/core';
import { launchConfig } from '@carbon/core';
import { CarbonChainClient } from '../../src/client.js';
import { loadSolanaConfig, type EnvLike } from '../../src/config.js';
import { ensureSchema, type Db } from '../../src/db.js';
import type { RpcLike } from '../../src/rpc.js';

export const TEST_DB_URL = process.env['CARBON_TEST_DATABASE_URL'] ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';

export interface TestKeys {
  crank: Keypair;
  buyback: Keypair;
  treasury: Keypair;
  carbonMint: Keypair;
}

export function testKeys(): TestKeys {
  return { crank: Keypair.generate(), buyback: Keypair.generate(), treasury: Keypair.generate(), carbonMint: Keypair.generate() };
}

export function testEnv(k: TestKeys, extra: EnvLike = {}): EnvLike {
  return {
    CARBON_VAULT_KEY: randomBytes(32).toString('hex'),
    CARBON_BUYBACK_WALLET: k.buyback.publicKey.toBase58(),
    CARBON_TREASURY_WALLET: k.treasury.publicKey.toBase58(),
    CARBON_CRANK_KEY: bs58.encode(k.crank.secretKey),
    CARBON_BUYBACK_KEY: bs58.encode(k.buyback.secretKey),
    CARBON_MINT: k.carbonMint.publicKey.toBase58(),
    PINATA_JWT: 'test-jwt-not-a-secret',
    ...extra,
  };
}

/** A pool whose connections all use a fresh schema; dropped by `close`. */
export async function testDb(): Promise<{ db: Db; schema: string; close: () => Promise<void> }> {
  const schema = `sol_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DB_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: TEST_DB_URL, options: `-c search_path=${schema}`, max: 6 });
  await ensureSchema(pool);
  return {
    db: pool,
    schema,
    close: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}

export const FAST_POLL = { pollMs: 0, maxPolls: 4, rebroadcastEvery: 1 };

export function makeClient(opts: {
  env: EnvLike;
  rpc: RpcLike;
  db: Db;
  config?: LaunchConfig;
  assertLaunchAllowed?: (launchId: string, approvalId: string) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): CarbonChainClient {
  const cfg = opts.config ?? launchConfig('C-12', 'ring');
  return new CarbonChainClient({
    config: loadSolanaConfig(opts.env),
    rpc: opts.rpc,
    db: opts.db,
    env: opts.env,
    poll: FAST_POLL,
    launchConfig: async () => cfg,
    ...(opts.assertLaunchAllowed ? { assertLaunchAllowed: opts.assertLaunchAllowed } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}
