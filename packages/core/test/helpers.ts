/** Test-only helpers. Never imported from src/. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createEventBus, type PgEventBus } from '../src/bus/pg-bus.js';
import { migrate } from '../src/bus/migrate.js';
import type { AgentId, ArgonEvent, EventKind, EventPayloads, IsotopeId, ShapeId } from '../src/contracts.js';
import { KeyRing, eventId } from '../src/crypto.js';

export const TEST_DB_URL = process.env.ARGON_TEST_DATABASE_URL ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';
export const TEST_REDIS_URL = process.env.ARGON_TEST_REDIS_URL ?? 'redis://localhost:6379';

/** A fresh random seed per test run (test-only; never a real key). */
export const TEST_SEED = randomBytes(32).toString('hex');

export class Clock {
  constructor(public t = 1_800_000_000_000) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface TestEnv {
  bus: PgEventBus;
  schema: string;
  clock: Clock;
  /** A second bus on the same schema (another process). */
  open(opts?: { pollMs?: number }): Promise<PgEventBus>;
  cleanup(): Promise<void>;
}

/** Real Postgres (carbon_test) + real Redis, isolated in a throwaway schema and channel. */
export async function testEnv(opts: { pollMs?: number; clock?: Clock } = {}): Promise<TestEnv> {
  const schema = `core_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: TEST_DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const clock = opts.clock ?? new Clock();
  const buses: PgEventBus[] = [];
  const open = async (o: { pollMs?: number } = {}) => {
    const b = createEventBus({
      databaseUrl: TEST_DB_URL,
      redisUrl: TEST_REDIS_URL,
      seed: TEST_SEED,
      schema,
      now: clock.now,
      pollMs: o.pollMs ?? opts.pollMs ?? 0,
    });
    buses.push(b);
    return b;
  };
  const bus = await open();
  await migrate(bus.pool);
  return {
    bus,
    schema,
    clock,
    open,
    async cleanup() {
      for (const b of buses) await b.close();
      const a = new pg.Pool({ connectionString: TEST_DB_URL });
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}

export const WALLET = 'LauncherWa11et1111111111111111111111111111111';

export async function createLaunch(
  bus: PgEventBus,
  shape: ShapeId,
  isotope: IsotopeId = 'Ar-36',
  heavyAgent: AgentId | null = null,
): Promise<string> {
  const launchId = `l_${randomBytes(4).toString('hex')}`;
  await bus.append({
    launchId,
    kind: 'launch.created',
    actor: 'user',
    payload: { line: 'test line', isotope, shape, heavyAgent, launcherWallet: WALLET, xConnected: false },
  });
  return launchId;
}

/** In-memory signed events for pure tests. */
export class LogBuilder {
  readonly events: ArgonEvent[] = [];
  private seq = 0;
  private readonly keys = new KeyRing(Buffer.from(TEST_SEED, 'hex'));
  constructor(readonly launchId = 'pure-launch') {}
  add<K extends EventKind>(ts: number, kind: K, actor: ArgonEvent['actor'], payload: EventPayloads[K]): ArgonEvent<K> {
    const body = { launchId: this.launchId, ts, kind, actor, payload };
    const id = eventId(body);
    const { signer, sig } = this.keys.signId(actor, id);
    const e = { ...body, id, seq: ++this.seq, signer, sig } as ArgonEvent<K>;
    this.events.push(e as ArgonEvent);
    return e;
  }
  created(shape: ShapeId, ts = 0, isotope: IsotopeId = 'Ar-36', heavyAgent: AgentId | null = null) {
    return this.add(ts, 'launch.created', 'user', { line: 'x', isotope, shape, heavyAgent, launcherWallet: WALLET, xConnected: false });
  }
  handoff(ts: number, from: AgentId, to: AgentId, topic = 't') {
    return this.add(ts, 'handoff', from, { from, to, topic, summary: `${from}→${to}` });
  }
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
