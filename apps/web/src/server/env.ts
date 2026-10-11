/** Public configuration read from env (server only). Nothing here is secret. */
import type { Network } from '@/lib/types';
import { isWalletAddress } from '@/lib/signing';

/** Devnet unless the owner sets BOTH CARBON_NETWORK=mainnet-beta and CARBON_MAINNET_ENABLED=true. */
export function network(env: NodeJS.ProcessEnv = process.env): Network {
  return env.CARBON_NETWORK === 'mainnet-beta' && env.CARBON_MAINNET_ENABLED === 'true' ? 'mainnet-beta' : 'devnet';
}

/** Carbon's two public wallets (fee-share recipients). null when not configured: shown as "--.--". */
export function carbonWallets(env: NodeJS.ProcessEnv = process.env): { buyback: string | null; treasury: string | null } {
  const ok = (v: string | undefined) => (v && isWalletAddress(v.trim()) ? v.trim() : null);
  return { buyback: ok(env.CARBON_BUYBACK_WALLET), treasury: ok(env.CARBON_TREASURY_WALLET) };
}

/** Absolute site origin for OG / player meta. */
export function siteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.NEXT_PUBLIC_SITE_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');
  return v.replace(/\/+$/, '');
}

export function xConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.X_CLIENT_ID && env.X_REDIRECT_URI && env.CARBON_TOKEN_KEY);
}
