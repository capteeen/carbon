/** Test doubles. Live only under test/; never exported from src/. */
import { randomBytes } from 'node:crypto';
import { CarbonXClient, type XClientDeps } from '../src/client.js';
import type { XConfig } from '../src/config.js';
import { X_API_BASE, X_AUTHORIZE_URL, X_SCOPES } from '../src/config.js';
import { TokenCipher } from '../src/crypto.js';
import type { DedupeReservation, PostLedger, StoredTokens, TokenStore } from '../src/store.js';
import { usersMe } from './fixtures/fixtures.js';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Responder = (call: Call) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch that records calls and answers from a queue of responders. */
export function fakeFetch(...queue: Responder[]) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: init?.body as string | undefined };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    return next(call);
  }) as typeof fetch;
  return { fetch: fn, calls, queue };
}

export class MemoryTokenStore implements TokenStore {
  rows = new Map<string, StoredTokens>();
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r, scopes: [...r.scopes] } : null;
  }
  async put(t: StoredTokens) {
    this.rows.set(t.launchId, { ...t });
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

export class MemoryLedger implements PostLedger {
  rows = new Map<string, { status: 'pending' | 'published'; postId: string | null; at: Date }>();
  async reserve(l: string, h: string, _k: 'post' | 'reply', now: Date, windowMs: number): Promise<DedupeReservation> {
    const r = this.rows.get(`${l}|${h}`);
    if (r && r.at.getTime() >= now.getTime() - windowMs) return { ok: false, postId: r.postId, postedAt: r.at };
    this.rows.set(`${l}|${h}`, { status: 'pending', postId: null, at: now });
    return { ok: true };
  }
  async markPublished(l: string, h: string, id: string) {
    const r = this.rows.get(`${l}|${h}`);
    if (r) Object.assign(r, { status: 'published', postId: id });
  }
  async release(l: string, h: string) {
    const r = this.rows.get(`${l}|${h}`);
    if (r?.status === 'pending') this.rows.delete(`${l}|${h}`);
  }
}

export const testConfig = (over: Partial<XConfig> = {}): XConfig => ({
  clientId: 'fixture-client-id',
  clientSecret: 'fixture-client-secret',
  redirectUri: 'https://carbon.example/api/x/callback',
  bearerToken: 'FIXTURE-APP-BEARER',
  scopes: X_SCOPES,
  apiBase: X_API_BASE,
  authorizeUrl: X_AUTHORIZE_URL,
  ...over,
});

export const testCipher = () => new TokenCipher(Uint8Array.from(randomBytes(32)));

/** The launcher wallet test connections are bound to. */
export const FIXTURE_WALLET = 'FixtureLauncherWallet1111111111111111111111';

export function connectedTokens(launchId = 'launch-1', over: Partial<StoredTokens> = {}): StoredTokens {
  return {
    launchId,
    xUserId: usersMe.data.id,
    xHandle: usersMe.data.username,
    accessToken: 'FIXTURE-ACCESS-TOKEN-stored',
    refreshToken: 'FIXTURE-REFRESH-TOKEN-stored',
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    scopes: [...X_SCOPES],
    wallet: FIXTURE_WALLET,
    ...over,
  };
}

export function makeClient(over: Partial<XClientDeps> & { responders?: Responder[] } = {}) {
  const ff = fakeFetch(...(over.responders ?? []));
  const tokens = (over.tokens as MemoryTokenStore | undefined) ?? new MemoryTokenStore();
  const ledger = (over.ledger as MemoryLedger | undefined) ?? new MemoryLedger();
  const { responders: _r, ...rest } = over;
  const client = new CarbonXClient({
    config: testConfig(),
    tokens,
    ledger,
    cipher: testCipher(),
    fetch: ff.fetch,
    sleep: async () => {},
    ...rest,
  });
  return { client, calls: ff.calls, queue: ff.queue, tokens, ledger };
}
