import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from '../src/contracts.js';
import { KeyRing, MissingSeedError, canonicalJson, eventId, resolveSeed, verifyEvent } from '../src/crypto.js';
import { createEventBus } from '../src/bus/pg-bus.js';
import { LogBuilder, TEST_DB_URL, TEST_SEED } from './helpers.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
  it('is insensitive to key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
  it('refuses values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson({ d: new Date() })).toThrow();
  });
  it('event id is sha256 of the canonical body', () => {
    const body = { launchId: 'l', ts: 1, kind: 'error' as const, actor: 'system' as const, payload: { message: 'm' } };
    expect(eventId(body)).toMatch(/^[0-9a-f]{64}$/);
    expect(eventId(body)).toBe(eventId({ payload: { message: 'm' }, actor: 'system', kind: 'error', ts: 1, launchId: 'l' }));
    expect(eventId({ ...body, ts: 2 })).not.toBe(eventId(body));
  });
});

describe('keys', () => {
  it('derives a distinct, deterministic key per agent and for the system', () => {
    const a = new KeyRing(Buffer.from(TEST_SEED, 'hex')).publicKeys();
    const b = new KeyRing(Buffer.from(TEST_SEED, 'hex')).publicKeys();
    expect(a).toEqual(b);
    expect(new Set(Object.values(a)).size).toBe(AGENT_IDS.length + 1);
    const other = new KeyRing(randomBytes(32)).publicKeys();
    expect(other.scout).not.toBe(a.scout);
  });
  it('never exposes secret material through JSON or inspection', () => {
    const k = new KeyRing(Buffer.from(TEST_SEED, 'hex'));
    const dumped = JSON.stringify(k) + String(Object.keys(k));
    expect(dumped).not.toContain(TEST_SEED);
    expect(Object.keys(k)).toEqual([]);
  });
  it('seed rules: explicit seed only under NODE_ENV=test; env otherwise; throw when missing', () => {
    expect(() => resolveSeed(TEST_SEED, { NODE_ENV: 'production' })).toThrow(/only accepted when NODE_ENV=test/);
    expect(() => resolveSeed(undefined, { NODE_ENV: 'production' })).toThrow(MissingSeedError);
    expect(() => resolveSeed(undefined, { NODE_ENV: 'production', CARBON_AGENT_KEY_SEED: 'abcd' })).toThrow(/at least 32 bytes/);
    expect(resolveSeed(undefined, { NODE_ENV: 'production', CARBON_AGENT_KEY_SEED: TEST_SEED })).toHaveLength(32);
    expect(resolveSeed(TEST_SEED, { NODE_ENV: 'test' })).toHaveLength(32);
  });
  it('bus construction throws without a seed in production', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSeed = process.env.CARBON_AGENT_KEY_SEED;
    process.env.NODE_ENV = 'production';
    delete process.env.CARBON_AGENT_KEY_SEED;
    try {
      expect(() => createEventBus({ databaseUrl: TEST_DB_URL })).toThrow(MissingSeedError);
      expect(() => createEventBus({ databaseUrl: TEST_DB_URL, seed: TEST_SEED })).toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevSeed !== undefined) process.env.CARBON_AGENT_KEY_SEED = prevSeed;
    }
  });
});

describe('signature tamper detection', () => {
  const keys = new KeyRing(Buffer.from(TEST_SEED, 'hex'));
  const log = new LogBuilder();
  const e = log.handoff(1000, 'scout', 'forge');

  it('accepts an untouched event', () => {
    expect(keys.verify(e)).toBe(true);
    expect(verifyEvent(e)).toBe(true);
  });
  it('detects a changed payload', () => {
    expect(keys.verify({ ...e, payload: { ...e.payload, summary: 'forged' } })).toBe(false);
  });
  it('detects a changed ts / actor / kind', () => {
    expect(keys.verify({ ...e, ts: e.ts + 1 })).toBe(false);
    expect(keys.verify({ ...e, actor: 'forge' })).toBe(false);
  });
  it('detects a recomputed id with the old signature', () => {
    const payload = { ...e.payload, summary: 'forged' };
    const id = eventId({ ...e, payload });
    expect(keys.verify({ ...e, payload, id })).toBe(false);
  });
  it('detects a re-signature by a different agent key', () => {
    const resigned = keys.signId('forge', e.id); // valid ed25519 sig, wrong signer for actor scout
    expect(verifyEvent({ ...e, ...resigned })).toBe(true); // structurally valid…
    expect(keys.verify({ ...e, ...resigned })).toBe(false); // …but not the actor's key
  });
  it('detects a flipped signature bit', () => {
    const bad = (parseInt(e.sig[0]!, 16) ^ 1).toString(16) + e.sig.slice(1);
    expect(keys.verify({ ...e, sig: bad })).toBe(false);
  });
});
