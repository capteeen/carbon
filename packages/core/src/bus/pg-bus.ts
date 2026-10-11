/**
 * EventBus over Postgres (append-only `events`, the source of truth) with Redis
 * pub/sub fan-out (a fast path only; Postgres always wins).
 *
 * Ordering guarantee: appends are serialized by a transaction-scoped advisory lock,
 * so commit order == seq order and each published message carries `prevSeq` (the seq
 * of the event committed immediately before it). A subscriber delivers a Redis
 * message directly only when its prevSeq equals the last seq it has seen; on any
 * mismatch (dropped message, reconnect, out-of-order delivery) it backfills from
 * Postgres by seq. Result: live events in seq order with no gaps and no duplicates.
 */
import pg from 'pg';
import { Redis } from 'ioredis';
import type { CarbonEvent, EventKind } from '../contracts.js';
import type { AppendInput, EventBus } from '../ports.js';
import { KeyRing, canonicalJson, eventId } from '../crypto.js';

const APPEND_LOCK_KEY = 0x0ca4b0e; // pg_advisory_xact_lock key for appends (one global writer at a time)

export interface SubscribeOptions {
  /** Deliver every matching event with seq > afterSeq first (from Postgres), then live. */
  afterSeq?: number;
}

/** An EventBus whose subscribe() can resume from a seq (used by sseStream). */
export interface ResumableEventBus extends EventBus {
  subscribe(launchId: string | '*', cb: (e: CarbonEvent) => void, opts?: SubscribeOptions): () => void;
}

export interface PgEventBusOptions {
  pool: pg.Pool;
  /** Publisher connection. */
  redis: Redis;
  /** Dedicated subscriber connection; defaults to redis.duplicate(). */
  redisSubscriber?: Redis;
  keys: KeyRing;
  /** Redis channel; default 'carbon:events'. */
  channel?: string;
  /** Clock (ms). Injected in tests. */
  now?: () => number;
  /** Safety-net catch-up poll against Postgres, ms. Default 2000. 0 disables. */
  pollMs?: number;
  /** Called when a subscriber callback throws. */
  onSubscriberError?: (err: unknown) => void;
  /** Close pool and redis connections in close(). */
  ownsConnections?: boolean;
}

interface Row {
  seq: string;
  id: string;
  launch_id: string;
  ts: string;
  kind: string;
  actor: string;
  payload: unknown;
  signer: string;
  sig: string;
}

interface WireMessage {
  prevSeq: number;
  e: CarbonEvent;
}

interface Sub {
  launchId: string | '*';
  cb: (e: CarbonEvent) => void;
  last: number | null;
  chain: Promise<void>;
  closed: boolean;
}

function rowToEvent(r: Row): CarbonEvent {
  return {
    id: r.id,
    seq: Number(r.seq),
    launchId: r.launch_id,
    ts: Number(r.ts),
    kind: r.kind as EventKind,
    actor: r.actor as CarbonEvent['actor'],
    payload: r.payload as CarbonEvent['payload'],
    signer: r.signer,
    sig: r.sig,
  };
}

const COLS = 'seq, id, launch_id, ts, kind, actor, payload, signer, sig';

export class PgEventBus implements ResumableEventBus {
  readonly pool: pg.Pool;
  readonly keys: KeyRing;
  readonly channel: string;
  readonly now: () => number;
  private readonly redis: Redis;
  private readonly sub: Redis;
  private readonly subs = new Set<Sub>();
  private subscribed: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly pollMs: number;
  private readonly onSubscriberError: (err: unknown) => void;
  private readonly ownsConnections: boolean;
  private closed = false;

  constructor(opts: PgEventBusOptions) {
    this.pool = opts.pool;
    this.redis = opts.redis;
    this.sub = opts.redisSubscriber ?? opts.redis.duplicate();
    this.keys = opts.keys;
    this.channel = opts.channel ?? 'carbon:events';
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 2000;
    this.onSubscriberError = opts.onSubscriberError ?? (() => {});
    this.ownsConnections = opts.ownsConnections ?? false;
    this.sub.on('message', (channel: string, message: string) => {
      if (channel !== this.channel) return;
      let msg: WireMessage;
      try {
        msg = JSON.parse(message) as WireMessage;
      } catch {
        return;
      }
      for (const s of this.subs) this.enqueue(s, () => this.onMessage(s, msg));
    });
    // After a Redis reconnect, messages may have been missed: catch up from Postgres.
    this.sub.on('ready', () => this.catchUpAll());
  }

  /** Public keys of every signer, for /how. */
  publicKeys(): Record<string, string> {
    return this.keys.publicKeys();
  }

  async append<K extends EventKind>(input: AppendInput<K>): Promise<CarbonEvent<K>> {
    if (this.closed) throw new Error('event bus is closed');
    if (!input.launchId) throw new Error('launchId required');
    // Fail before touching the DB if the payload is not canonically encodable.
    canonicalJson(input.payload);
    const client = await this.pool.connect();
    let event: CarbonEvent<K>;
    let prevSeq: number;
    try {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_KEY]);
        const last = await client.query<{ seq: string; ts: string }>('SELECT seq, ts FROM events ORDER BY seq DESC LIMIT 1');
        prevSeq = last.rows[0] ? Number(last.rows[0].seq) : 0;
        // ts never goes backwards in seq order, so windows over ts agree with seq order.
        let ts = Math.max(this.now(), last.rows[0] ? Number(last.rows[0].ts) : 0);
        let id: string;
        for (;;) {
          id = eventId({ launchId: input.launchId, ts, kind: input.kind, actor: input.actor, payload: input.payload });
          const dup = await client.query('SELECT 1 FROM events WHERE id = $1', [id]);
          if (dup.rowCount === 0) break;
          ts += 1; // identical body in the same ms: the next ms keeps ids unique
        }
        const { signer, sig } = this.keys.signId(input.actor, id);
        const ins = await client.query<{ seq: string }>(
          `INSERT INTO events (id, launch_id, ts, kind, actor, payload, signer, sig)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING seq`,
          [id, input.launchId, ts, input.kind, input.actor, JSON.stringify(input.payload), signer, sig],
        );
        await client.query('COMMIT');
        event = {
          id,
          seq: Number(ins.rows[0]!.seq),
          launchId: input.launchId,
          ts,
          kind: input.kind,
          actor: input.actor,
          payload: input.payload,
          signer,
          sig,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
    const wire: WireMessage = { prevSeq, e: event as CarbonEvent };
    // Publish failures are not fatal: subscribers backfill from Postgres.
    await this.redis.publish(this.channel, JSON.stringify(wire)).catch(() => 0);
    return event;
  }

  async list(
    launchId: string | '*',
    opts: { afterSeq?: number; kinds?: EventKind[]; limit?: number; upToSeq?: number } = {},
  ): Promise<CarbonEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (launchId !== '*') {
      params.push(launchId);
      where.push(`launch_id = $${params.length}`);
    }
    if (opts.afterSeq !== undefined) {
      params.push(opts.afterSeq);
      where.push(`seq > $${params.length}`);
    }
    if (opts.upToSeq !== undefined) {
      params.push(opts.upToSeq);
      where.push(`seq <= $${params.length}`);
    }
    if (opts.kinds && opts.kinds.length) {
      params.push(opts.kinds);
      where.push(`kind = ANY($${params.length}::text[])`);
    }
    let sql = `SELECT ${COLS} FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC`;
    if (opts.limit !== undefined) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const res = await this.pool.query<Row>(sql, params);
    return res.rows.map(rowToEvent);
  }

  async get(id: string): Promise<CarbonEvent | null> {
    const res = await this.pool.query<Row>(`SELECT ${COLS} FROM events WHERE id = $1`, [id]);
    return res.rows[0] ? rowToEvent(res.rows[0]) : null;
  }

  async maxSeq(): Promise<number> {
    const res = await this.pool.query<{ m: string | null }>('SELECT max(seq) AS m FROM events');
    return res.rows[0]?.m ? Number(res.rows[0].m) : 0;
  }

  verify(e: CarbonEvent): boolean {
    return this.keys.verify(e);
  }

  subscribe(launchId: string | '*', cb: (e: CarbonEvent) => void, opts: SubscribeOptions = {}): () => void {
    if (this.closed) throw new Error('event bus is closed');
    const s: Sub = { launchId, cb, last: null, chain: Promise.resolve(), closed: false };
    this.subs.add(s);
    this.ensureSubscribed();
    this.enqueue(s, async () => {
      if (opts.afterSeq !== undefined) {
        s.last = opts.afterSeq;
        await this.catchUp(s);
      } else {
        s.last = await this.maxSeq();
      }
    });
    return () => {
      s.closed = true;
      this.subs.delete(s);
    };
  }

  /** Resolves once the Redis subscription is active and every current subscriber is initialised. */
  async ready(): Promise<void> {
    this.ensureSubscribed();
    await this.subscribed;
    await Promise.all([...this.subs].map((s) => s.chain));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const s of this.subs) s.closed = true;
    this.subs.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.sub.quit().catch(() => {});
    if (this.ownsConnections) {
      await this.redis.quit().catch(() => {});
      await this.pool.end().catch(() => {});
    }
  }

  // ───────────── internals ─────────────

  private ensureSubscribed(): void {
    if (!this.subscribed) {
      this.subscribed = this.sub.subscribe(this.channel).then(() => undefined);
      this.subscribed.catch(() => {
        this.subscribed = null;
      });
    }
    if (!this.pollTimer && this.pollMs > 0) {
      this.pollTimer = setInterval(() => this.catchUpAll(), this.pollMs);
      this.pollTimer.unref();
    }
  }

  private enqueue(s: Sub, task: () => Promise<void>): void {
    s.chain = s.chain.then(async () => {
      if (s.closed) return;
      try {
        await task();
      } catch (err) {
        this.onSubscriberError(err);
      }
    });
  }

  private catchUpAll(): void {
    if (this.closed) return;
    for (const s of this.subs) this.enqueue(s, () => this.catchUp(s));
  }

  private deliver(s: Sub, e: CarbonEvent): void {
    if (s.closed) return;
    if (s.launchId !== '*' && e.launchId !== s.launchId) return;
    try {
      s.cb(e);
    } catch (err) {
      this.onSubscriberError(err);
    }
  }

  private async onMessage(s: Sub, msg: WireMessage): Promise<void> {
    if (s.last === null) return; // not initialised (init task runs first in the chain, so unreachable)
    const e = msg.e;
    if (!e || typeof e.seq !== 'number' || e.seq <= s.last) return;
    if (msg.prevSeq === s.last && this.keys.verify(e)) {
      this.deliver(s, e);
      s.last = e.seq;
      return;
    }
    await this.catchUp(s, e.seq);
  }

  /** Delivers committed events with seq in (last, upTo] from Postgres. */
  private async catchUp(s: Sub, upTo?: number): Promise<void> {
    if (s.last === null || s.closed) return;
    const target = upTo ?? (await this.maxSeq());
    if (target <= s.last) return;
    const rows = await this.list(s.launchId, { afterSeq: s.last, upToSeq: target });
    for (const e of rows) this.deliver(s, e);
    s.last = target;
  }
}

export interface CreateEventBusOptions {
  databaseUrl?: string;
  redisUrl?: string;
  /** Only honoured when NODE_ENV=test; production reads CARBON_AGENT_KEY_SEED. */
  seed?: string;
  /** Postgres schema (search_path) — tests use a throwaway schema. */
  schema?: string;
  channel?: string;
  now?: () => number;
  pollMs?: number;
}

/**
 * Builds a PgEventBus from env (DATABASE_URL, REDIS_URL, CARBON_AGENT_KEY_SEED).
 * Throws immediately if the key seed is missing.
 */
export function createEventBus(opts: CreateEventBusOptions = {}): PgEventBus {
  const keys = KeyRing.fromEnv(opts.seed); // throws without a seed, before any connection is opened
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  if (opts.schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error('invalid schema name');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  return new PgEventBus({
    pool,
    redis,
    keys,
    channel: opts.channel ?? (opts.schema ? `carbon:events:${opts.schema}` : 'carbon:events'),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    ownsConnections: true,
  });
}
