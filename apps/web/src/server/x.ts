/**
 * X (OAuth 2.0 PKCE) on the web side: connect and callback only. The web app
 * never posts: it builds the client WITHOUT an assertApproval hook, so post()
 * and reply() refuse here by construction. The worker posts, after approvals.
 */
import { createXClient, type CarbonXClient } from '@carbon/x';
import { getCore } from './core';
import { xConfigured } from './env';

const g = globalThis as typeof globalThis & { __carbonX?: Promise<CarbonXClient> };

export function getX(): Promise<CarbonXClient> {
  if (!g.__carbonX) {
    g.__carbonX = getCore()
      .then(({ bus }) => createXClient({ db: bus.pool }))
      .catch((err: unknown) => {
        g.__carbonX = undefined;
        throw err;
      });
  }
  return g.__carbonX;
}

/**
 * At launch creation: whether this launch id has an X connection started by `launcherWallet`.
 * A connection bound to any other wallet (or none) is deleted (AG-004, X account fixation).
 * false when X is not configured at all.
 */
export async function xConnectedFor(launchId: string, launcherWallet: string): Promise<boolean> {
  if (!xConfigured()) return false;
  return (await getX()).claimConnection(launchId, launcherWallet);
}
