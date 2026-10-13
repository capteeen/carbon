/**
 * Canonical JSON, event ids and ed25519 signing.
 *
 * - Event id = sha256 hex of canonicalJson({launchId, ts, kind, actor, payload}).
 * - sig = ed25519 signature over the 32 raw bytes of that hash, by the actor's key
 *   (agents sign with their own key; 'user' and 'system' events are signed by the
 *   system key, since the server appends them on the user's behalf).
 * - Keys are derived with HKDF-SHA256 from ARGON_AGENT_KEY_SEED (hex, >= 32 bytes).
 *   Private keys never leave this module's closures; only public keys are exported.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { AGENT_IDS, type AgentId, type ArgonEvent, type EventKind, type EventPayloads } from './contracts.js';

// ───────────────────────────── canonical JSON ─────────────────────────────

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit order, no whitespace,
 * `undefined` object members omitted (as JSON.stringify does). Throws on values JSON
 * cannot represent faithfully (bigint, non-finite numbers, functions, symbols,
 * undefined inside arrays) so that a hash can never silently depend on a lossy encoding.
 */
export function canonicalJson(value: unknown): string {
  return enc(value, 'value');
}

function enc(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    case 'object': {
      if (Array.isArray(v)) {
        return `[${v
          .map((x, i) => {
            if (x === undefined) throw new TypeError(`canonicalJson: undefined in array at ${path}[${i}]`);
            return enc(x, `${path}[${i}]`);
          })
          .join(',')}]`;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: unsupported object type at ${path}`);
      }
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${enc(o[k], `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

export interface EventBody<K extends EventKind = EventKind> {
  launchId: string;
  ts: number;
  kind: K;
  actor: ArgonEvent['actor'];
  payload: EventPayloads[K];
}

/** Event id: sha256 hex of canonicalJson({launchId, ts, kind, actor, payload}). */
export function eventId(body: EventBody): string {
  const { launchId, ts, kind, actor, payload } = body;
  return sha256Hex(canonicalJson({ launchId, ts, kind, actor, payload }));
}

// ───────────────────────────── keys ─────────────────────────────

export type SignerId = AgentId | 'system';
export const SIGNER_IDS: readonly SignerId[] = [...AGENT_IDS, 'system'];

// Key-derivation domains keep the pre-rename 'carbon' prefix: changing them would change every agent key.
const HKDF_SALT = utf8ToBytes('carbon/agent-keys/v1');

/** Which key signs an event by this actor. */
export function signerFor(actor: ArgonEvent['actor']): SignerId {
  return actor === 'user' || actor === 'system' ? 'system' : actor;
}

export class MissingSeedError extends Error {
  constructor() {
    super('ARGON_AGENT_KEY_SEED is not set (hex, at least 32 bytes). The event bus cannot sign without it.');
    this.name = 'MissingSeedError';
  }
}

function parseSeed(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0 || clean.length < 64) {
    // Never echo the value.
    throw new Error('ARGON_AGENT_KEY_SEED must be hex encoding at least 32 bytes');
  }
  return hexToBytes(clean);
}

/**
 * Resolves the seed. Production and dev read ONLY the env var. An explicit seed
 * parameter is accepted only when NODE_ENV === 'test'.
 */
export function resolveSeed(explicitSeedHex?: string, env: NodeJS.ProcessEnv = process.env): Uint8Array {
  if (explicitSeedHex !== undefined) {
    if (env.NODE_ENV !== 'test') throw new Error('An explicit key seed is only accepted when NODE_ENV=test');
    return parseSeed(explicitSeedHex);
  }
  const fromEnv = env.ARGON_AGENT_KEY_SEED;
  if (!fromEnv) throw new MissingSeedError();
  return parseSeed(fromEnv);
}

/** Holds the derived keys. Secret keys are private fields and never exposed. */
export class KeyRing {
  readonly #secrets: Map<SignerId, Uint8Array>;
  readonly #publics: Map<SignerId, string>;
  readonly #bySigner: Map<string, SignerId>;

  constructor(seed: Uint8Array) {
    if (seed.length < 32) throw new Error('key seed must be at least 32 bytes');
    this.#secrets = new Map();
    this.#publics = new Map();
    this.#bySigner = new Map();
    for (const id of SIGNER_IDS) {
      const info = utf8ToBytes(id === 'system' ? 'carbon:system' : `carbon:agent:${id}`);
      const sk = hkdf(sha256, seed, HKDF_SALT, info, 32);
      const pk = bytesToHex(ed25519.getPublicKey(sk));
      this.#secrets.set(id, sk);
      this.#publics.set(id, pk);
      this.#bySigner.set(pk, id);
    }
  }

  static fromEnv(explicitSeedHex?: string, env: NodeJS.ProcessEnv = process.env): KeyRing {
    return new KeyRing(resolveSeed(explicitSeedHex, env));
  }

  publicKey(id: SignerId): string {
    return this.#publics.get(id)!;
  }

  /** Every signer's PUBLIC key (hex), for /how. */
  publicKeys(): Record<SignerId, string> {
    return Object.fromEntries(SIGNER_IDS.map((id) => [id, this.#publics.get(id)!])) as Record<SignerId, string>;
  }

  /** Signs an event id (hex sha256) with the actor's key. */
  signId(actor: ArgonEvent['actor'], id: string): { signer: string; sig: string } {
    const who = signerFor(actor);
    const sk = this.#secrets.get(who)!;
    return { signer: this.#publics.get(who)!, sig: bytesToHex(ed25519.sign(hexToBytes(id), sk)) };
  }

  /** Full check: id matches the body, signer is the actor's key, signature valid. */
  verify(e: ArgonEvent): boolean {
    return verifyEvent(e, this.#publics.get(signerFor(e.actor)));
  }

  toJSON(): unknown {
    return { publicKeys: this.publicKeys() };
  }
}

/**
 * Verifies an event's hash and signature. With `expectedSigner`, also requires the
 * signer to be that key (otherwise anyone could re-sign a forged body with their own key).
 */
export function verifyEvent(e: ArgonEvent, expectedSigner?: string): boolean {
  try {
    if (typeof e.id !== 'string' || !/^[0-9a-f]{64}$/.test(e.id)) return false;
    if (eventId(e) !== e.id) return false;
    if (expectedSigner !== undefined && e.signer !== expectedSigner) return false;
    return ed25519.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.signer));
  } catch {
    return false;
  }
}
