/**
 * Single-use signed requests (AG-016). The sha256 of the exact signed text is the
 * nonce: it is recorded once in carbon_signed_nonces (worker migration
 * 002_single_use.sql, PRIMARY KEY digest). A captured signature replayed within its
 * freshness window is refused; outside the window isFresh() already refuses it.
 * Call only AFTER the signature verified, so nobody can burn another wallet's nonce.
 */
import { createHash } from 'node:crypto';
import type { SingleUseScope } from '@/lib/signing';
import { getCore } from './core';
import { HttpError } from './http';

export function nonceDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function consumeSignedNonce(scope: SingleUseScope, launchId: string, wallet: string, signedText: string, now: number = Date.now()): Promise<void> {
  const { bus } = await getCore();
  const r = await bus.pool.query(
    `INSERT INTO carbon_signed_nonces (digest, launch_id, scope, wallet, used_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (digest) DO NOTHING`,
    [nonceDigest(signedText), launchId, scope, wallet, now],
  );
  if (r.rowCount !== 1) throw new HttpError(409, 'this signed request was already used; sign again');
}
