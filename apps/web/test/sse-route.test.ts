/** SSE route against real Postgres (carbon_test, throwaway schema) and Redis. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createEventBus, migrate, type PgEventBus } from '@carbon/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB = process.env.CARBON_TEST_DATABASE_URL ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';
const REDIS = process.env.CARBON_TEST_REDIS_URL ?? 'redis://localhost:6379';
const schema = `web_t_${randomBytes(6).toString('hex')}`;
let bus: PgEventBus;

vi.mock('@/server/core', () => ({ getCore: async () => ({ bus }) }));
const { GET } = await import('@/app/api/events/[launchId]/route');

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: DB });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  bus = createEventBus({ databaseUrl: DB, redisUrl: REDIS, seed: randomBytes(32).toString('hex'), schema, pollMs: 200 });
  await migrate(bus.pool);
});

afterAll(async () => {
  await bus.close();
  const admin = new pg.Pool({ connectionString: DB });
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

/** Reads SSE frames until `n` events arrived (or timeout); returns their seqs. */
async function readSeqs(res: Response, n: number, ac: AbortController): Promise<number[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const seqs: number[] = [];
  const deadline = Date.now() + 8000;
  while (seqs.length < n && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 500))]);
    if (!r) continue;
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const id = /^id: (\d+)$/m.exec(frame);
      if (id) seqs.push(Number(id[1]));
    }
  }
  ac.abort();
  await reader.cancel().catch(() => undefined);
  return seqs;
}

describe('GET /api/events/[launchId]', () => {
  it('resumes after Last-Event-ID with no gaps and no duplicates', async () => {
    const a = await bus.append({ launchId: 'L1', kind: 'error', actor: 'system', payload: { message: 'one' } });
    const b = await bus.append({ launchId: 'L1', kind: 'error', actor: 'system', payload: { message: 'two' } });
    await bus.append({ launchId: 'L2', kind: 'error', actor: 'system', payload: { message: 'other launch' } });
    const c = await bus.append({ launchId: 'L1', kind: 'error', actor: 'system', payload: { message: 'three' } });
    const ac = new AbortController();
    const res = await GET(new Request('http://t/api/events/L1', { headers: { 'last-event-id': String(a.seq) }, signal: ac.signal }), {
      params: Promise.resolve({ launchId: 'L1' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await readSeqs(res, 2, ac)).toEqual([b.seq, c.seq]);
  });

  it('?after= resumes the first connection; Last-Event-ID wins over it', async () => {
    const before = await bus.append({ launchId: 'L3', kind: 'error', actor: 'system', payload: { message: 'x' } });
    const after = await bus.append({ launchId: 'L3', kind: 'error', actor: 'system', payload: { message: 'y' } });
    const ac = new AbortController();
    const res = await GET(new Request(`http://t/api/events/L3?after=0`, { headers: { 'last-event-id': String(before.seq) }, signal: ac.signal }), {
      params: Promise.resolve({ launchId: 'L3' }),
    });
    expect(await readSeqs(res, 1, ac)).toEqual([after.seq]);
  });

  it("'*' streams every launch, then live events", async () => {
    const start = await bus.append({ launchId: 'L4', kind: 'error', actor: 'system', payload: { message: 'p' } });
    const ac = new AbortController();
    const res = await GET(new Request(`http://t/api/events/*?after=${start.seq}`, { signal: ac.signal }), { params: Promise.resolve({ launchId: '*' }) });
    const p = readSeqs(res, 2, ac);
    await new Promise((r) => setTimeout(r, 300));
    const x = await bus.append({ launchId: 'L5', kind: 'error', actor: 'system', payload: { message: 'q' } });
    const y = await bus.append({ launchId: 'L6', kind: 'error', actor: 'system', payload: { message: 'r' } });
    expect(await p).toEqual([x.seq, y.seq]);
  });

  it('rejects malformed launch ids', async () => {
    const res = await GET(new Request('http://t/api/events/bad id'), { params: Promise.resolve({ launchId: 'bad id' }) });
    expect(res.status).toBe(400);
  });
});
