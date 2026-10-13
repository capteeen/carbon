/**
 * X (OAuth 2.0 PKCE) on the web side: connect and callback only. The web app
 * never posts: it builds the client WITHOUT an assertApproval hook, so post()
 * and reply() refuse here by construction. The worker posts, after approvals.
 */
import { createXClient, type ArgonXClient } from '@argon/x';
import { getCore } from './core';
import { xConfigured } from './env';

const g = globalThis as typeof globalThis & { __argonX?: Promise<ArgonXClient> };

export function getX(): Promise<ArgonXClient> {
  if (!g.__argonX) {
    g.__argonX = getCore()
      .then(({ bus }) => createXClient({ db: bus.pool }))
      .catch((err: unknown) => {
        g.__argonX = undefined;
        throw err;
      });
  }
  return g.__argonX;
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
