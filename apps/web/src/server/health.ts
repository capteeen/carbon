/**
 * Deployment health: which required settings are missing and whether Postgres,
 * the migrated schema and Redis are reachable. Reports names and states only,
 * never a value, URL, host or error text that could carry one.
 */
import pg from 'pg';
import Redis from 'ioredis';

export type CheckState = 'ok' | 'missing' | 'invalid' | 'unreachable' | 'not_migrated' | 'skipped';
export interface Health {
  ok: boolean;
  checks: { name: string; state: CheckState; fix: string }[];
}

const TIMEOUT_MS = 4000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
}

export async function checkHealth(env: NodeJS.ProcessEnv = process.env): Promise<Health> {
  const checks: Health['checks'] = [];
  const seed = env.CARBON_AGENT_KEY_SEED?.trim();
  checks.push({
    name: 'CARBON_AGENT_KEY_SEED',
    state: !seed ? 'missing' : /^[0-9a-fA-F]{64,}$/.test(seed) ? 'ok' : 'invalid',
    fix: 'Set it in Vercel to the same hex value (at least 32 bytes) the worker uses.',
  });

  const dbUrl = env.DATABASE_URL?.trim();
  if (!dbUrl) {
    checks.push({ name: 'DATABASE_URL', state: 'missing', fix: 'Set it in Vercel to a Postgres reachable from the internet (the same one the worker uses).' });
    checks.push({ name: 'schema', state: 'skipped', fix: 'Needs DATABASE_URL first.' });
  } else {
    const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: TIMEOUT_MS });
    try {
      await withTimeout(client.connect());
      checks.push({ name: 'DATABASE_URL', state: 'ok', fix: '' });
      const r = await withTimeout(client.query<{ t: string | null }>("select to_regclass('events')::text as t"));
      checks.push({
        name: 'schema',
        state: r.rows[0]?.t ? 'ok' : 'not_migrated',
        fix: 'Redeploy on Vercel (the build creates the tables when DATABASE_URL is set), or start the worker once (it migrates at boot).',
      });
    } catch {
      checks.push({ name: 'DATABASE_URL', state: 'unreachable', fix: 'Check the URL, that the database accepts outside connections, and SSL (add ?sslmode=require for hosted Postgres).' });
      checks.push({ name: 'schema', state: 'skipped', fix: 'Needs a reachable database first.' });
    } finally {
      client.end().catch(() => {});
    }
  }

  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) {
    checks.push({ name: 'REDIS_URL', state: 'missing', fix: 'Set it in Vercel to a Redis reachable from the internet (the same one the worker uses).' });
  } else {
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: TIMEOUT_MS, retryStrategy: () => null });
    redis.on('error', () => {});
    try {
      await withTimeout(redis.connect());
      await withTimeout(redis.ping());
      checks.push({ name: 'REDIS_URL', state: 'ok', fix: '' });
    } catch {
      checks.push({ name: 'REDIS_URL', state: 'unreachable', fix: 'Check the URL and that Redis accepts outside connections (use rediss:// for TLS).' });
    } finally {
      redis.disconnect();
    }
  }
  return { ok: checks.every((c) => c.state === 'ok'), checks };
}
