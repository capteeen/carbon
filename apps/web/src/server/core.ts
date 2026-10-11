/**
 * The web app's one connection to the Carbon event log (server only).
 * createCore() reads DATABASE_URL, REDIS_URL and CARBON_AGENT_KEY_SEED.
 * The worker runs migrations; the web app never does.
 */
import { createCore, type Core } from '@carbon/core';

const g = globalThis as typeof globalThis & { __carbonCore?: Promise<Core> };

export function getCore(): Promise<Core> {
  if (!g.__carbonCore) {
    g.__carbonCore = createCore().catch((err: unknown) => {
      g.__carbonCore = undefined;
      throw err;
    });
  }
  return g.__carbonCore;
}
