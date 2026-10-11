/**
 * The web app's one connection to the Carbon event log (server only).
 * createCore() reads DATABASE_URL, REDIS_URL and CARBON_AGENT_KEY_SEED.
 * Migrations run at build time (scripts/migrate-on-build.mjs) and at worker
 * boot. Until the tables exist, getCore() rejects with LogNotConfiguredError (a
 * schema message) and pages show the same honest empty states as a deployment with no log.
 */
import { createCore, type Core } from '@carbon/core';
import { logConfigured } from './log-config';
export { logConfigured };

const g = globalThis as typeof globalThis & { __carbonCore?: Promise<Core>; __carbonConn?: Promise<Core>; __carbonSchemaAt?: number };

/** How often a deployment without tables re-checks for them (ms). */
const SCHEMA_RECHECK_MS = 10_000;

export function getCore(): Promise<Core> {
  if (g.__carbonCore) return g.__carbonCore;
  if (!logConfigured()) {
    return Promise.reject(new LogNotConfiguredError('This deployment has no event log connected yet (DATABASE_URL / CARBON_AGENT_KEY_SEED unset), so launching and approvals are unavailable.'));
  }
  // one connection per process; the schema check is repeated (rate-limited) until the tables exist
  if (!g.__carbonConn) {
    g.__carbonConn = createCore().catch((err: unknown) => {
      g.__carbonConn = undefined;
      throw err;
    });
  }
  const now = Date.now();
  if (g.__carbonSchemaAt && now - g.__carbonSchemaAt < SCHEMA_RECHECK_MS) return Promise.reject(schemaError());
  return g.__carbonConn.then(async (core) => {
    const r = await core.bus.pool.query<{ t: string | null }>("SELECT to_regclass('events')::text AS t");
    if (!r.rows[0]?.t) {
      g.__carbonSchemaAt = Date.now();
      throw schemaError();
    }
    g.__carbonSchemaAt = undefined;
    g.__carbonCore = Promise.resolve(core);
    return core;
  });
}

function schemaError(): LogNotConfiguredError {
  return new LogNotConfiguredError('The event log is connected but its tables have not been created yet (migrations run at build and at worker boot), so launching and approvals are unavailable.');
}

/** Thrown by getCore() when there is no event log; route handlers answer 503 with this message. */
export class LogNotConfiguredError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'LogNotConfiguredError';
  }
}
