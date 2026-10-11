/**
 * The web app's one connection to the Carbon event log (server only).
 * createCore() reads DATABASE_URL, REDIS_URL and CARBON_AGENT_KEY_SEED.
 * The worker runs migrations; the web app never does.
 */
import { createCore, type Core } from '@carbon/core';
import { logConfigured } from './log-config';
export { logConfigured };

const g = globalThis as typeof globalThis & { __carbonCore?: Promise<Core> };

export function getCore(): Promise<Core> {
  if (g.__carbonCore) return g.__carbonCore;
  if (!logConfigured()) {
    return Promise.reject(new LogNotConfiguredError('This deployment has no event log connected yet (DATABASE_URL / CARBON_AGENT_KEY_SEED unset), so launching and approvals are unavailable.'));
  }
  if (!g.__carbonCore) {
    g.__carbonCore = createCore().catch((err: unknown) => {
      g.__carbonCore = undefined;
      throw err;
    });
  }
  return g.__carbonCore;
}


/** Thrown by getCore() when there is no event log; route handlers answer 503 with this message. */
export class LogNotConfiguredError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'LogNotConfiguredError';
  }
}
