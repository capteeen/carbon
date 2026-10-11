import { describe, expect, it } from 'vitest';
import { XConfigError, XNotConnectedError } from '../src/errors.js';
import { connectedTokens, json, makeClient, MemoryTokenStore, testConfig } from './helpers.js';
import { forbiddenProblem, mentions, searchRecent, trends, usersMe } from './fixtures/fixtures.js';

describe('searchRecent', () => {
  it('uses the app bearer token, clamps max_results and maps posts', async () => {
    const ctx = makeClient({ responders: [() => json(searchRecent)] });
    const posts = await ctx.client.searchRecent('carbon -is:retweet', { max: 500 });
    const u = new URL(ctx.calls[0]!.url);
    expect(u.pathname).toBe('/2/tweets/search/recent');
    expect(u.searchParams.get('query')).toBe('carbon -is:retweet');
    expect(u.searchParams.get('max_results')).toBe('100');
    expect(u.searchParams.get('tweet.fields')).toBe('created_at,author_id,public_metrics');
    expect(ctx.calls[0]!.headers.authorization).toBe('Bearer FIXTURE-APP-BEARER');
    expect(posts[0]).toEqual({
      id: '1800000000000000001',
      text: 'fixture post one',
      authorId: '1600000000000000001',
      createdAt: '2026-10-11T10:00:00.000Z',
      metrics: { likes: 12, reposts: 3, replies: 1, quotes: 0, impressions: 400 },
    });
    expect(posts[1]!.metrics).toBeUndefined();
  });

  it('uses the launch user token when launchId is given, errors without any token', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens());
    const ctx = makeClient({ tokens, config: { ...testConfig(), bearerToken: undefined } as never, responders: [() => json({ meta: { result_count: 0 } })] });
    await expect(ctx.client.searchRecent('carbon', { launchId: 'launch-1' })).resolves.toEqual([]);
    expect(ctx.calls[0]!.headers.authorization).toBe('Bearer FIXTURE-ACCESS-TOKEN-stored');
    await expect(ctx.client.searchRecent('carbon')).rejects.toThrow(XConfigError);
  });
});

describe('mentions', () => {
  it('reads /2/users/:id/mentions with since_id', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens());
    const ctx = makeClient({ tokens, responders: [() => json(mentions)] });
    const out = await ctx.client.mentions('launch-1', '1800000000000000009');
    const u = new URL(ctx.calls[0]!.url);
    expect(u.pathname).toBe(`/2/users/${usersMe.data.id}/mentions`);
    expect(u.searchParams.get('since_id')).toBe('1800000000000000009');
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toEqual({ likes: 1, reposts: 0, replies: 0, quotes: 0 });
    await expect(ctx.client.mentions('nope')).rejects.toThrow(XNotConnectedError);
  });
});

describe('trends', () => {
  it('maps trends and records availability', async () => {
    const ctx = makeClient({ responders: [() => json(trends)] });
    expect(ctx.client.trendsAvailability().status).toBe('unknown');
    await expect(ctx.client.trends(23424977)).resolves.toEqual([{ name: '#FixtureTrendA', volume: 12000 }, { name: 'FixtureTrendB' }]);
    expect(new URL(ctx.calls[0]!.url).pathname).toBe('/2/trends/by/woeid/23424977');
    expect(ctx.client.trendsAvailability().status).toBe('available');
  });

  it('returns [] with a reason when the tier/account is not allowed', async () => {
    const ctx = makeClient({ responders: [() => json(forbiddenProblem, 403)] });
    await expect(ctx.client.trends()).resolves.toEqual([]);
    const a = ctx.client.trendsAvailability();
    expect(a.status).toBe('unavailable');
    expect(a.reason).toMatch(/403 Client Forbidden/);
  });

  it('returns [] with a reason when no app bearer token is configured', async () => {
    const ctx = makeClient({ config: { ...testConfig(), bearerToken: undefined } as never });
    await expect(ctx.client.trends()).resolves.toEqual([]);
    expect(ctx.client.trendsAvailability().reason).toMatch(/X_BEARER_TOKEN/);
    expect(ctx.calls).toHaveLength(0);
  });
});
