/** PKCE (RFC 7636) helpers: S256 only. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** 32 random bytes → 43-char base64url verifier (RFC 7636 §4.1, within 43..128). */
export function createCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** code_challenge = BASE64URL(SHA256(ASCII(code_verifier))) (RFC 7636 §4.2). */
export function codeChallengeS256(verifier: string): string {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
    throw new Error('PKCE code_verifier must be 43-128 unreserved characters');
  }
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** CSRF state for the authorize request. X allows up to 500 chars. */
export function createState(): string {
  return base64url(randomBytes(24));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
