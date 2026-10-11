import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CarbonEvent } from '../src/contracts.js';
import { sseStream } from '../src/bus/sse.js';
import { createLaunch, testEnv, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await testEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe('PgEventBus', () => {
  it('append → list round-trips and every stored event verifies', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const e = await env.bus.append({ launchId: l, kind: 'handoff', actor: 'scout', payload: { from: 'scout', to: 'forge', topic: 'narratives', summary: 'three narratives' } });
    expect(e.id).toMatch(/^[0-9a-f]{64}$/);
    expect(e.signer).toBe(env.bus.publicKeys().scout);
    const listed = await env.bus.list(l);
    expect(listed.map((x) => x.kind)).toEqual(['launch.created', 'handoff']);
    expect(listed[1]).toEqual(e);
    for (const x of listed) expect(env.bus.verify(x)).toBe(true);
    // user events are signed by the system key
    expect(listed[0]!.signer).toBe(env.bus.publicKeys().system);
  });

  it('signature tamper detected on a stored event', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const [e] = await env.bus.list(l);
    expect(env.bus.verify({ ...e!, payload: { ...(e!.payload as object), line: 'tampered' } } as CarbonEvent)).toBe(false);
  });

  it('the events table is append-only', async () => {
    const l = await createLaunch(env.bus, 'chain');
    await expect(env.bus.pool.query('UPDATE events SET actor = $1 WHERE launch_id = $2', ['scout', l])).rejects.toThrow(/append-only/);
    await expect(env.bus.pool.query('DELETE FROM events')).rejects.toThrow(/append-only/);
    await expect(env.bus.pool.query('TRUNCATE events')).rejects.toThrow(/append-only/);
  });

  it('identical bodies in the same ms get distinct ids, and ts never decreases with seq', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const p = { launchId: l, kind: 'error' as const, actor: 'system' as const, payload: { message: 'same' } };
    const a = await env.bus.append(p);
    const b = await env.bus.append(p);
    expect(a.id).not.toBe(b.id);
    expect(b.ts).toBe(a.ts + 1);
    env.clock.advance(-10_000); // a clock going backwards cannot reorder the log
    const c = await env.bus.append({ ...p, payload: { message: 'later' } });
    expect(c.ts).toBeGreaterThanOrEqual(b.ts);
  });

  it('list filters by kinds, afterSeq and limit', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const other = await createLaunch(env.bus, 'ring');
    await env.bus.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: '1' } });
    await env.bus.append({ launchId: other, kind: 'error', actor: 'system', payload: { message: 'x' } });
    const e2 = await env.bus.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: '2' } });
    expect((await env.bus.list(l, { kinds: ['error'] })).map((e) => (e.payload as { message: string }).message)).toEqual(['1', '2']);
    expect((await env.bus.list(l, { afterSeq: e2.seq - 1 })).map((e) => e.id)).toEqual([e2.id]);
    expect(await env.bus.list('*', { limit: 2 })).toHaveLength(2);
  });

  it('subscribe: live, in seq order, no gaps, across concurrent writers in two processes', async () => {
    const l = await createLaunch(env.bus, 'diamond');
    const other = await env.open();
    const got: number[] = [];
    const unsub = env.bus.subscribe(l, (e) => got.push(e.seq));
    await env.bus.ready();
    const writes: Promise<CarbonEvent>[] = [];
    for (let i = 0; i < 40; i++) {
      const b = i % 2 ? env.bus : other;
      writes.push(b.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: String(i) } }));
    }
    await Promise.all(writes);
    const expected = (await env.bus.list(l)).map((e) => e.seq).slice(1);
    await waitFor(() => got.length >= expected.length);
    expect(got).toEqual(expected);
    unsub();
  });

  it('a dropped Redis message is backfilled from Postgres (no gaps)', async () => {
    const l = await createLaunch(env.bus, 'chain');
    // A writer whose publishes go to another channel: its messages never reach our subscriber.
    const silent = await env.open();
    (silent as unknown as { channel: string }).channel = 'carbon:events:void';
    const got: string[] = [];
    env.bus.subscribe(l, (e) => got.push((e.payload as { message: string }).message));
    await env.bus.ready();
    await silent.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: 'lost-1' } });
    await silent.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: 'lost-2' } });
    await env.bus.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: 'seen' } });
    await waitFor(() => got.length === 3);
    expect(got).toEqual(['lost-1', 'lost-2', 'seen']);
  });

  it('the poll safety net delivers even when no further message arrives', async () => {
    const polling = await env.open({ pollMs: 50 });
    const l = await createLaunch(env.bus, 'chain');
    const silent = await env.open();
    (silent as unknown as { channel: string }).channel = 'carbon:events:void';
    const got: string[] = [];
    polling.subscribe(l, (e) => got.push(e.kind));
    await polling.ready();
    await silent.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: 'quiet' } });
    await waitFor(() => got.length === 1);
    expect(got).toEqual(['error']);
  });

  it('subscribe with afterSeq replays history then continues live', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const a = await env.bus.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: 'a' } });
    await env.bus.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: 'b' } });
    const got: string[] = [];
    env.bus.subscribe(l, (e) => got.push((e.payload as { message: string }).message), { afterSeq: a.seq });
    await env.bus.ready();
    await env.bus.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: 'c' } });
    await waitFor(() => got.length === 2);
    expect(got).toEqual(['b', 'c']);
  });
});

async function readSse(stream: ReadableStream<Uint8Array>, until: (frames: { id: string; event: string; data: CarbonEvent }[]) => boolean) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames: { id: string; event: string; data: CarbonEvent }[] = [];
  const deadline = Date.now() + 5000;
  while (!until(frames)) {
    if (Date.now() > deadline) throw new Error('SSE read timed out');
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f: Record<string, string> = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const k = line.slice(0, line.indexOf(':'));
        f[k] = line.slice(line.indexOf(':') + 1).trimStart();
      }
      if (f.data) frames.push({ id: f.id!, event: f.event!, data: JSON.parse(f.data) as CarbonEvent });
    }
  }
  await reader.cancel();
  return frames;
}

describe('sseStream', () => {
  it('resumes with Last-Event-ID with no gaps and no duplicates', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const msg = (m: string) => env.bus.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: m } });
    await msg('1');
    // First connection, from the beginning ("0"), reads two frames then drops.
    const first = await readSse(sseStream(env.bus, l, '0'), (f) => f.length >= 2);
    expect(first.map((f) => f.event)).toEqual(['launch.created', 'error']);
    const lastId = first[first.length - 1]!.id;
    // Events happen while the client is disconnected.
    await msg('2');
    await msg('3');
    const second = sseStream(env.bus, l, lastId);
    const pending = readSse(second, (f) => f.length >= 3);
    await new Promise((r) => setTimeout(r, 50));
    await msg('4'); // live after reconnect
    const frames = await pending;
    expect(frames.map((f) => (f.data.payload as { message: string }).message)).toEqual(['2', '3', '4']);
    const all = await env.bus.list(l);
    expect([...first, ...frames].map((f) => Number(f.id))).toEqual(all.map((e) => e.seq));
    for (const f of frames) {
      expect(f.id).toBe(String(f.data.seq));
      expect(env.bus.verify(f.data)).toBe(true);
    }
  });

  it('without Last-Event-ID starts live (no history)', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const s = sseStream(env.bus, l, null);
    const pending = readSse(s, (f) => f.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    await env.bus.append({ launchId: l, kind: 'error', actor: 'system', payload: { message: 'live' } });
    const frames = await pending;
    expect(frames.map((f) => f.event)).toEqual(['error']);
  });
});
