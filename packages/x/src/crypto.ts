/**
 * AES-256-GCM sealing for OAuth tokens (and the PKCE flow cookie), via
 * @noble/ciphers. Key: ARGON_TOKEN_KEY, 32 bytes as 64 hex chars or base64.
 * Layout of a sealed value: version(1) || nonce(12) || ciphertext+tag.
 * Associated data binds a ciphertext to its row so rows cannot be swapped.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from 'node:crypto';
import { XConfigError } from './errors.js';

const VERSION = 1;
const NONCE_LEN = 12;

export function parseTokenKey(raw: string | undefined): Uint8Array {
  if (!raw) throw new XConfigError('ARGON_TOKEN_KEY is not set');
  const s = raw.trim();
  let key: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Uint8Array.from(Buffer.from(s, 'hex'));
  else key = Uint8Array.from(Buffer.from(s, 'base64'));
  if (key.length !== 32) throw new XConfigError('ARGON_TOKEN_KEY must decode to exactly 32 bytes (hex or base64)');
  return key;
}

export class TokenCipher {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new XConfigError('TokenCipher needs a 32-byte key');
    this.#key = Uint8Array.from(key);
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): TokenCipher {
    return new TokenCipher(parseTokenKey(env.ARGON_TOKEN_KEY));
  }

  seal(plaintext: string, aad: string): Uint8Array {
    const nonce = Uint8Array.from(randomBytes(NONCE_LEN));
    const ct = gcm(this.#key, nonce, utf8(aad)).encrypt(utf8(plaintext));
    const out = new Uint8Array(1 + NONCE_LEN + ct.length);
    out[0] = VERSION;
    out.set(nonce, 1);
    out.set(ct, 1 + NONCE_LEN);
    return out;
  }

  /** Throws on tamper, wrong key or wrong aad. */
  open(sealed: Uint8Array, aad: string): string {
    if (sealed.length < 1 + NONCE_LEN + 16 || sealed[0] !== VERSION) throw new Error('Unrecognised sealed value');
    const nonce = sealed.subarray(1, 1 + NONCE_LEN);
    const ct = sealed.subarray(1 + NONCE_LEN);
    const pt = gcm(this.#key, nonce, utf8(aad)).decrypt(ct);
    return new TextDecoder().decode(pt);
  }

  /** Never serialise the key. */
  toJSON(): string {
    return '[TokenCipher]';
  }
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
