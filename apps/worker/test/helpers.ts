/** Test-only helpers (real Postgres carbon_test in a throwaway schema, real Redis). Never imported from src/. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createCore, type Core } from '@argon/core';
import { migrateAll } from '../src/migrate.js';

export const TEST_DB = process.env.ARGON_TEST_DATABASE_URL ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';
export const TEST_REDIS = process.env.ARGON_TEST_REDIS_URL ?? 'redis://localhost:6379';

export interface Env {
  core: Core;
  schema: string;
  applied: string[];
  cleanup(): Promise<void>;
}

export async function testEnv(): Promise<Env> {
  const schema = `worker_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: TEST_DB });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const core = await createCore({ databaseUrl: TEST_DB, redisUrl: TEST_REDIS, seed: randomBytes(32).toString('hex'), schema, pollMs: 200 });
  const applied = await migrateAll(core.bus.pool);
  return {
    core,
    schema,
    applied,
    async cleanup() {
      await core.close();
      const a = new pg.Pool({ connectionString: TEST_DB });
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}

export const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
