import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../src/errors.js';
import { RateLimiter } from '../src/ratelimit.js';
import { connectedTokens, json, makeClient, MemoryTokenStore } from './helpers.js';
import { createPost, searchRecent, tooManyRequests } from './fixtures/fixtures.js';

const T0 = Date.parse('2026-10-11T12:00:00Z');
const sec = (ms: number) => String(Math.floor(ms / 1000));

describe('rate limiting', () => {
  it('blocks locally when x-rate-limit-remaining hits 0, until x-rate-limit-reset', async () => {
    let now = T0;
    const reset = T0 + 300_000;
    const ctx = makeClient({
      now: () => now,
      responders: [
        () => json(searchRecent, 200, { 'x-rate-limit-limit': '450', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': sec(reset) }),
        () => json(searchRecent),
      ],
    });
    await ctx.client.searchRecent('carbon');
    const err = await ctx.client.searchRecent('carbon').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).resetAt.getTime()).toBe(reset);
    expect((err as RateLimitedError).source).toBe('headers');
    expect(ctx.calls).toHaveLength(1);
    now = reset + 1;
    await expect(ctx.client.searchRecent('carbon')).resolves.toHaveLength(2);
  });

  it('throws RateLimitedError with resetAt on a 429 for posts (never auto-retried)', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens());
    const reset = T0 + 900_000;
    const ctx = makeClient({
      tokens,
      now: () => T0,
      assertApproval: async () => {},
      responders: [() => json(tooManyRequests, 429, { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': sec(reset) })],
    });
    const err = await ctx.client.post('launch-1', 'gm', 'a').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).resetAt.getTime()).toBe(reset);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.ledger.rows.size).toBe(0); // 429 = not created → dedupe slot freed
  });

  it('retries a GET once after a short 429 reset', async () => {
    let now = T0;
    const slept: number[] = [];
    const ctx = makeClient({
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
      responders: [
        () => json(tooManyRequests, 429, { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': sec(T0 + 1000) }),
        () => json(searchRecent, 200, { 'x-rate-limit-remaining': '449', 'x-rate-limit-reset': sec(T0 + 900_000) }),
      ],
    });
    await expect(ctx.client.searchRecent('carbon')).resolves.toHaveLength(2);
    expect(slept).toEqual([1000]);
    expect(ctx.calls).toHaveLength(2);
  });

  it('backs off exponentially when a 429 has no reset header', () => {
    let now = T0;
    const rl = new RateLimiter({ now: () => now, backoffBaseMs: 1000 });
    const h = new Headers();
    rl.acquire('GET /2/tweets/search/recent', { kind: 'app' });
    expect(rl.observe('GET /2/tweets/search/recent', { kind: 'app' }, 429, h)).toBe(T0 + 1000);
    now = T0 + 1000;
    rl.acquire('GET /2/tweets/search/recent', { kind: 'app' });
    expect(rl.observe('GET /2/tweets/search/recent', { kind: 'app' }, 429, h)).toBe(now + 2000);
    expect(() => rl.acquire('GET /2/tweets/search/recent', { kind: 'app' })).toThrow(RateLimitedError);
  });

  it('local token bucket enforces documented limits per endpoint and principal', () => {
    let now = T0;
    const rl = new RateLimiter({ now: () => now });
    const u = { kind: 'user', id: '1' } as const;
    for (let i = 0; i < 75; i++) rl.acquire('GET /2/users/me', u);
    const err = (() => {
      try {
        rl.acquire('GET /2/users/me', u);
      } catch (e) {
        return e as RateLimitedError;
      }
    })();
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err!.source).toBe('local');
    expect(err!.resetAt.getTime()).toBe(T0 + 12_000); // 75 per 15 min → one token per 12s
    rl.acquire('GET /2/users/me', { kind: 'user', id: '2' }); // other principal unaffected
    rl.acquire('GET /2/tweets/search/recent', u); // other endpoint unaffected
    now += 12_000;
    rl.acquire('GET /2/users/me', u);
  });

  it('honours the 24-hour app-wide post cap header across users', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens('launch-1'));
    await tokens.put(connectedTokens('launch-2', { xUserId: '2', xHandle: 'other' }));
    const reset = T0 + 3_600_000;
    const ctx = makeClient({
      tokens,
      now: () => T0,
      assertApproval: async () => {},
      responders: [() => json(createPost('1', 'a'), 201, { 'x-app-limit-24hour-remaining': '0', 'x-app-limit-24hour-reset': sec(reset) })],
    });
    await ctx.client.post('launch-1', 'a', 'x1');
    const err = await ctx.client.post('launch-2', 'b', 'x2').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).resetAt.getTime()).toBe(reset);
    expect(ctx.calls).toHaveLength(1);
  });
});
