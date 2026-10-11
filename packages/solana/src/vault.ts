/**
 * Secrets at rest: AES-256-GCM (@noble/ciphers) under CARBON_VAULT_KEY.
 *
 *   nonce = 12 random bytes
 *   AAD   = utf8(label)        a blob cannot be moved to another launch or purpose
 *   blob  = "v1:" + base64(nonce ‖ ciphertext ‖ tag)
 *
 * Decrypt failures say only "authentication failed". Nothing here logs.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { Keypair } from '@solana/web3.js';
import { KeyVaultError } from './errors.js';

const NONCE = 12;
const PREFIX = 'v1:';

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new KeyVaultError('vault key must be 32 bytes');
}

export function sealBytes(key: Uint8Array, plaintext: Uint8Array, label: string): string {
  assertKey(key);
  if (!label) throw new KeyVaultError('label must be non-empty');
  const nonce = randomBytes(NONCE);
  const ct = gcm(key, nonce, new TextEncoder().encode(label)).encrypt(plaintext);
  const out = new Uint8Array(NONCE + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE);
  return PREFIX + Buffer.from(out).toString('base64');
}

export function openBytes(key: Uint8Array, blob: string, label: string): Uint8Array {
  assertKey(key);
  if (typeof blob !== 'string' || !blob.startsWith(PREFIX)) throw new KeyVaultError('unsupported blob format');
  const raw = Uint8Array.from(Buffer.from(blob.slice(PREFIX.length), 'base64'));
  if (raw.length <= NONCE + 16) throw new KeyVaultError('blob too short');
  try {
    return gcm(key, raw.subarray(0, NONCE), new TextEncoder().encode(label)).decrypt(raw.subarray(NONCE));
  } catch {
    throw new KeyVaultError('authentication failed: wrong key, wrong label or tampered blob');
  }
}

export function sealKeypair(key: Uint8Array, kp: Keypair, label: string): string {
  return sealBytes(key, kp.secretKey, label);
}

export function openKeypair(key: Uint8Array, blob: string, label: string): Keypair {
  const sk = openBytes(key, blob, label);
  try {
    if (sk.length !== 64) throw new KeyVaultError('decrypted secret is not a 64-byte ed25519 secret key');
    // web3.js keeps a reference to the array it is given: hand it a copy and wipe ours.
    return Keypair.fromSecretKey(Uint8Array.from(sk));
  } finally {
    sk.fill(0);
  }
}

/** Labels bind a blob to one launch and one purpose. */
export const keyLabel = {
  mint: (launchId: string) => `carbon/launch/${launchId}/mint`,
  creator: (launchId: string) => `carbon/launch/${launchId}/creator`,
};
