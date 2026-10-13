/** Public configuration read from env (server only). Nothing here is secret. */
import '@argon/core/env-compat';
import type { Network } from '@/lib/types';
import { isWalletAddress } from '@/lib/signing';

/** Devnet unless the owner sets BOTH ARGON_NETWORK=mainnet-beta and ARGON_MAINNET_ENABLED=true. */
export function network(env: NodeJS.ProcessEnv = process.env): Network {
  return env.ARGON_NETWORK === 'mainnet-beta' && env.ARGON_MAINNET_ENABLED === 'true' ? 'mainnet-beta' : 'devnet';
}

/** Argon's two public wallets (fee-share recipients). null when not configured: shown as "--.--". */
export function argonWallets(env: NodeJS.ProcessEnv = process.env): { buyback: string | null; treasury: string | null } {
  const ok = (v: string | undefined) => (v && isWalletAddress(v.trim()) ? v.trim() : null);
  return { buyback: ok(env.ARGON_BUYBACK_WALLET), treasury: ok(env.ARGON_TREASURY_WALLET) };
}

/** Absolute site origin for OG / player meta. */
export function siteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.NEXT_PUBLIC_SITE_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');
  return v.replace(/\/+$/, '');
}

export function xConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.X_CLIENT_ID && env.X_REDIRECT_URI && env.ARGON_TOKEN_KEY);
}
