import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalRequiredError,
  DuplicatePostError,
  EmptyPostError,
  PostTooLongError,
  XApiError,
  XNotConnectedError,
} from '../src/errors.js';
import { connectedTokens, json, makeClient, MemoryTokenStore } from './helpers.js';
import { createPost } from './fixtures/fixtures.js';
import { textHash } from '../src/client.js';

async function connected() {
  const tokens = new MemoryTokenStore();
  await tokens.put(connectedTokens('launch-1', { accessExpiresAt: new Date('2100-01-01T00:00:00Z') }));
  return tokens;
}

describe('post / reply approval gate', () => {
  it('refuses without an approval hook and makes no network call', async () => {
    const ctx = makeClient({ tokens: await connected(), responders: [() => json(createPost('1', 'x'), 201)] });
    await expect(ctx.client.post('launch-1', 'gm', 'appr-1')).rejects.toThrow(ApprovalRequiredError);
    await expect(ctx.client.reply('launch-1', '123', 'gm', 'appr-1')).rejects.toThrow(ApprovalRequiredError);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.ledger.rows.size).toBe(0);
  });

  it('refuses when the hook throws, makes no network call and frees the dedupe slot', async () => {
    const assertApproval = vi.fn(async () => {
      throw new Error('approval not granted');
    });
    const ctx = makeClient({ tokens: await connected(), assertApproval, responders: [() => json(createPost('1', 'x'), 201)] });
    const err = await ctx.client.post('launch-1', 'gm', 'appr-1').catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect((err as ApprovalRequiredError).cause).toBeInstanceOf(Error);
    expect(assertApproval).toHaveBeenCalledWith('launch-1', 'appr-1', 'post', textHash('gm'));
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.ledger.rows.size).toBe(0);
  });

  it('calls the hook before the network, then posts and returns the status URL', async () => {
    const order: string[] = [];
    const assertApproval = vi.fn(async () => void order.push('approval'));
    const ctx = makeClient({
      tokens: await connected(),
      assertApproval,
      responders: [
        (c) => {
          order.push('network');
          expect(JSON.parse(c.body!)).toEqual({ text: 'gm carbon' });
          expect(c.headers.authorization).toBe('Bearer FIXTURE-ACCESS-TOKEN-stored');
          return json(createPost('1900000000000000001', 'gm carbon'), 201);
        },
      ],
    });
    await expect(ctx.client.post('launch-1', 'gm carbon', 'appr-1')).resolves.toEqual({
      id: '1900000000000000001',
      url: 'https://x.com/fixture_project/status/1900000000000000001',
    });
    expect(order).toEqual(['approval', 'network']);
    expect(ctx.calls[0]!.url).toBe('https://api.x.com/2/tweets');
    expect(ctx.calls[0]!.method).toBe('POST');
  });

  it('reply sends reply.in_reply_to_tweet_id and checks the reply action', async () => {
    const assertApproval = vi.fn(async () => {});
    const ctx = makeClient({
      tokens: await connected(),
      assertApproval,
      responders: [(c) => {
        expect(JSON.parse(c.body!)).toEqual({ text: 'thanks!', reply: { in_reply_to_tweet_id: '1800000000000000010' } });
        return json(createPost('1900000000000000002', 'thanks!'), 201);
      }],
    });
    await ctx.client.reply('launch-1', '1800000000000000010', 'thanks!', 'appr-2');
    expect(assertApproval).toHaveBeenCalledWith('launch-1', 'appr-2', 'reply', textHash('thanks!'));
  });

  it('validates text before consuming the approval', async () => {
    const assertApproval = vi.fn(async () => {});
    const ctx = makeClient({ tokens: await connected(), assertApproval });
    await expect(ctx.client.post('launch-1', 'a'.repeat(281), 'appr')).rejects.toThrow(PostTooLongError);
    await expect(ctx.client.post('launch-1', '   ', 'appr')).rejects.toThrow(EmptyPostError);
    await expect(ctx.client.post('launch-2', 'gm', 'appr')).rejects.toThrow(XNotConnectedError);
    expect(assertApproval).not.toHaveBeenCalled();
    expect(ctx.calls).toHaveLength(0);
  });

  it('dedupes identical text within 24h, allows it after', async () => {
    let now = Date.parse('2026-10-11T00:00:00Z');
    const assertApproval = vi.fn(async () => {});
    const ctx = makeClient({
      tokens: await connected(),
      assertApproval,
      now: () => now,
      responders: [() => json(createPost('101', 'gm'), 201), () => json(createPost('102', 'gm'), 201)],
    });
    await ctx.client.post('launch-1', 'gm', 'a1');
    now += 23 * 3_600_000;
    const dup = await ctx.client.post('launch-1', ' gm'.trim(), 'a2').catch((e) => e);
    expect(dup).toBeInstanceOf(DuplicatePostError);
    expect((dup as DuplicatePostError).existingPostId).toBe('101');
    expect(assertApproval).toHaveBeenCalledTimes(1); // the duplicate never consumed a2
    now += 2 * 3_600_000;
    await expect(ctx.client.post('launch-1', 'gm', 'a3')).resolves.toMatchObject({ id: '102' });
  });

  it('frees the dedupe slot on a definite 4xx rejection but keeps it on 5xx', async () => {
    const ctx = makeClient({
      tokens: await connected(),
      assertApproval: async () => {},
      responders: [
        () => json({ title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.', status: 403 }, 403),
        () => json({ title: 'Service Unavailable', status: 503 }, 503),
      ],
    });
    await expect(ctx.client.post('launch-1', 'one', 'a1')).rejects.toThrow(XApiError);
    expect(ctx.ledger.rows.size).toBe(0);
    await expect(ctx.client.post('launch-1', 'two', 'a2')).rejects.toThrow(XApiError);
    expect(ctx.ledger.rows.size).toBe(1);
  });
});
