/**
 * Per-endpoint, per-principal rate limiting.
 *
 * Two layers, both must allow a request:
 *  1. A local token bucket seeded from X's documented limits (README), so we
 *     do not burn requests we know will 429.
 *  2. Server state from x-rate-limit-{limit,remaining,reset} (and the 24-hour
 *     x-user-limit-24hour-* / x-app-limit-24hour-* headers on POST /2/tweets).
 *     When remaining hits 0 we block until reset; a 429 blocks until reset, or
 *     with exponential backoff when X sends no reset header.
 */
import { RateLimitedError } from './errors.js';

export type Endpoint =
  | 'POST /2/tweets'
  | 'GET /2/tweets/search/recent'
  | 'GET /2/users/:id/mentions'
  | 'GET /2/users/me'
  | 'GET /2/trends/by/woeid/:id'
  | 'POST /2/oauth2/token'
  | 'POST /2/oauth2/revoke';

export type Principal = { kind: 'app' } | { kind: 'user'; id: string };

interface Limit {
  limit: number;
  windowMs: number;
}

const MIN15 = 15 * 60_000;
const DAY = 24 * 60 * 60_000;

/** Documented limits, docs.x.com/x-api/fundamentals/rate-limits (read 2026-10-11). */
export const DOCUMENTED_LIMITS: Partial<Record<Endpoint, { user?: Limit[]; app?: Limit[] }>> = {
  'POST /2/tweets': { user: [{ limit: 100, windowMs: MIN15 }], app: [{ limit: 10_000, windowMs: DAY }] },
  'GET /2/tweets/search/recent': { user: [{ limit: 300, windowMs: MIN15 }], app: [{ limit: 450, windowMs: MIN15 }] },
  'GET /2/users/:id/mentions': { user: [{ limit: 300, windowMs: MIN15 }], app: [{ limit: 450, windowMs: MIN15 }] },
  'GET /2/users/me': { user: [{ limit: 75, windowMs: MIN15 }] },
  'GET /2/trends/by/woeid/:id': { app: [{ limit: 75, windowMs: MIN15 }] },
};

interface Bucket {
  capacity: number;
  tokens: number;
  refillPerMs: number;
  updatedAt: number;
}

interface ServerState {
  remaining: number | null;
  resetAt: number | null;
  blockedUntil: number | null;
  consecutive429: number;
}

export interface RateLimiterOptions {
  now?: () => number;
  limits?: typeof DOCUMENTED_LIMITS;
  /** Backoff when a 429 carries no reset header: base * 2^(n-1), capped. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export class RateLimiter {
  private readonly now: () => number;
  private readonly limits: typeof DOCUMENTED_LIMITS;
  private readonly buckets = new Map<string, Bucket[]>();
  private readonly server = new Map<string, ServerState>();
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(opts: RateLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.limits = opts.limits ?? DOCUMENTED_LIMITS;
    this.backoffBaseMs = opts.backoffBaseMs ?? 15_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? MIN15;
  }

  static key(endpoint: Endpoint, p: Principal): string {
    return p.kind === 'app' ? `${endpoint}|app` : `${endpoint}|user:${p.id}`;
  }

  /** Keys a request counts against: its own, plus the app-wide 24h post cap for user posts. */
  private keysFor(endpoint: Endpoint, p: Principal): Array<{ key: string; limits: Limit[] }> {
    const conf = this.limits[endpoint];
    const out: Array<{ key: string; limits: Limit[] }> = [];
    out.push({ key: RateLimiter.key(endpoint, p), limits: (p.kind === 'app' ? conf?.app : conf?.user) ?? [] });
    if (endpoint === 'POST /2/tweets' && p.kind === 'user' && conf?.app) {
      out.push({ key: `${endpoint}|app-total`, limits: conf.app });
    }
    return out;
  }

  /** Throws RateLimitedError if either layer says no; otherwise consumes one token. */
  acquire(endpoint: Endpoint, p: Principal): void {
    const t = this.now();
    const keys = this.keysFor(endpoint, p);
    for (const { key } of keys) {
      const s = this.server.get(key);
      if (!s) continue;
      if (s.blockedUntil !== null && t < s.blockedUntil) {
        throw new RateLimitedError(endpoint, new Date(s.blockedUntil), 'headers');
      }
      if (s.remaining !== null && s.remaining <= 0 && s.resetAt !== null && t < s.resetAt) {
        throw new RateLimitedError(endpoint, new Date(s.resetAt), 'headers');
      }
    }
    const all: Bucket[] = [];
    for (const { key, limits } of keys) all.push(...this.bucketsFor(key, limits, t));
    for (const b of all) {
      if (b.tokens < 1) {
        const waitMs = Math.ceil((1 - b.tokens) / b.refillPerMs);
        throw new RateLimitedError(endpoint, new Date(t + waitMs), 'local');
      }
    }
    for (const b of all) b.tokens -= 1;
    for (const { key } of keys) {
      const s = this.server.get(key);
      if (s && s.remaining !== null) s.remaining -= 1;
    }
  }

  /** Feed response headers/status back in. Returns the block-until time on 429. */
  observe(endpoint: Endpoint, p: Principal, status: number, headers: Headers): number | null {
    const t = this.now();
    const own = RateLimiter.key(endpoint, p);
    const s = this.state(own);
    const remaining = num(headers.get('x-rate-limit-remaining'));
    const reset = num(headers.get('x-rate-limit-reset'));
    if (remaining !== null) s.remaining = remaining;
    if (reset !== null) s.resetAt = reset * 1000;

    const resets: number[] = [];
    if (s.remaining !== null && s.remaining <= 0 && s.resetAt !== null) resets.push(s.resetAt);

    // 24-hour caps on POST /2/tweets (per user, and app-wide across all users).
    for (const prefix of ['x-user-limit-24hour', 'x-app-limit-24hour'] as const) {
      const rem = num(headers.get(`${prefix}-remaining`));
      const rst = num(headers.get(`${prefix}-reset`));
      if (rem === null || rem > 0 || rst === null) continue;
      const until = rst * 1000;
      resets.push(until);
      const target = prefix === 'x-app-limit-24hour' ? this.state(`${endpoint}|app-total`) : s;
      target.blockedUntil = Math.max(target.blockedUntil ?? 0, until);
    }

    if (status !== 429) {
      s.consecutive429 = 0;
      return null;
    }
    s.consecutive429 += 1;
    const future = resets.filter((r) => r > t);
    const until = future.length
      ? Math.max(...future)
      : s.resetAt !== null && s.resetAt > t
        ? s.resetAt
        : t + Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (s.consecutive429 - 1));
    s.blockedUntil = until;
    s.remaining = 0;
    return until;
  }

  private state(key: string): ServerState {
    let s = this.server.get(key);
    if (!s) {
      s = { remaining: null, resetAt: null, blockedUntil: null, consecutive429: 0 };
      this.server.set(key, s);
    }
    return s;
  }

  private bucketsFor(key: string, limits: Limit[], t: number): Bucket[] {
    let bs = this.buckets.get(key);
    if (!bs) {
      bs = limits.map((l) => ({ capacity: l.limit, tokens: l.limit, refillPerMs: l.limit / l.windowMs, updatedAt: t }));
      this.buckets.set(key, bs);
    }
    for (const b of bs) {
      b.tokens = Math.min(b.capacity, b.tokens + (t - b.updatedAt) * b.refillPerMs);
      b.updatedAt = t;
    }
    return bs;
  }
}

function num(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
