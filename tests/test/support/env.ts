/**
 * Agent G test support. Real Postgres (carbon_test, one throwaway schema per
 * env) and real Redis (one channel per schema). Test-only; nothing here is
 * imported by product code.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { createCore, type AgentId, type Core, type IsotopeId, type ShapeId } from '@carbon/core';
import { migrateAll } from '../../../apps/worker/src/migrate.js';

export const TEST_DB = process.env.CARBON_TEST_DATABASE_URL ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';
export const TEST_REDIS = process.env.CARBON_TEST_REDIS_URL ?? 'redis://localhost:6379';

export class Clock {
  constructor(public t = 1_900_000_000_000) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Env {
  core: Core;
  schema: string;
  seed: string;
  clock: Clock;
  /** DATABASE_URL that lands in this env's schema (for code that builds its own pool from env). */
  dbUrl: string;
  /** Another Core on the same schema: a second process. */
  another(): Promise<Core>;
  cleanup(): Promise<void>;
}

export async function makeEnv(opts: { clock?: Clock; pollMs?: number } = {}): Promise<Env> {
  const schema = `g_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: TEST_DB });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const seed = randomBytes(32).toString('hex');
  const clock = opts.clock ?? new Clock();
  const cores: Core[] = [];
  const open = async () => {
    const c = await createCore({ databaseUrl: TEST_DB, redisUrl: TEST_REDIS, seed, schema, now: clock.now, pollMs: opts.pollMs ?? 100 });
    cores.push(c);
    return c;
  };
  const core = await open();
  await migrateAll(core.bus.pool);
  return {
    core,
    schema,
    seed,
    clock,
    dbUrl: `${TEST_DB}?options=${encodeURIComponent(`-c search_path=${schema}`)}`,
    another: open,
    async cleanup() {
      for (const c of cores) await c.close().catch(() => undefined);
      const a = new pg.Pool({ connectionString: TEST_DB });
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}

/** A throwaway Solana-style wallet (ed25519) that can sign launcher messages. Test-only. */
export function wallet() {
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  return {
    address: bs58.encode(pk),
    sign: (text: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(text), sk)),
  };
}

export async function createLaunch(
  core: Core,
  shape: ShapeId,
  isotope: IsotopeId = 'C-12',
  heavyAgent: AgentId | null = null,
  launcherWallet = wallet().address,
  launchId: string = randomUUID(),
): Promise<string> {
  await core.bus.append({
    launchId,
    kind: 'launch.created',
    actor: 'user',
    payload: { line: 'agent g probe', isotope, shape, heavyAgent, launcherWallet, xConnected: false },
  });
  return launchId;
}
