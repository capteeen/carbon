import { XConfigError } from './errors.js';

/** Only what Herald/Keeper/Scout need. offline.access yields a refresh token. */
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] as const;

export const X_API_BASE = 'https://api.x.com';
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

export interface XConfig {
  clientId: string;
  /** Present for a confidential client (Basic auth on token/revoke); absent for a public client. */
  clientSecret?: string;
  redirectUri: string;
  /** App-only bearer token for search/trends. Optional. */
  bearerToken?: string;
  scopes: readonly string[];
  apiBase: string;
  authorizeUrl: string;
}

export function readXConfig(env: Record<string, string | undefined> = process.env): XConfig {
  const clientId = env.X_CLIENT_ID?.trim();
  const redirectUri = env.X_REDIRECT_URI?.trim();
  if (!clientId) throw new XConfigError('X_CLIENT_ID is not set');
  if (!redirectUri) throw new XConfigError('X_REDIRECT_URI is not set');
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new XConfigError('X_REDIRECT_URI is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new XConfigError('X_REDIRECT_URI must be https (http allowed only for localhost)');
  }
  const clientSecret = env.X_CLIENT_SECRET?.trim() || undefined;
  const bearerToken = env.X_BEARER_TOKEN?.trim() || undefined;
  return {
    clientId,
    redirectUri,
    scopes: X_SCOPES,
    apiBase: X_API_BASE,
    authorizeUrl: X_AUTHORIZE_URL,
    ...(clientSecret ? { clientSecret } : {}),
    ...(bearerToken ? { bearerToken } : {}),
  };
}
