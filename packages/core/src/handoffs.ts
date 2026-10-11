/**
 * Handoffs: the only sanctioned way to append a `handoff`. Enforces the launch's
 * shape topology and valence (via the same pure function the UI displays with),
 * queueing visibly (`handoff.queued`) until the hand-off fits.
 */
import type pg from 'pg';
import { SHAPES, VALENCE, pairKey, type AgentId, type Bond, type CarbonEvent } from './contracts.js';
import type { EventBus, Handoffs } from './ports.js';
import { analyzeBonds, computeBonds, handoffFits } from './bonds.js';
import { getLaunchCreated } from './launch.js';

export class TopologyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TopologyError';
  }
}
export class HandoffTimeoutError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'HandoffTimeoutError';
  }
}

export interface HandoffsOptions {
  bus: EventBus;
  /** When given, check+append is serialized across processes with a Postgres advisory lock per launch. */
  pool?: pg.Pool;
  now?: () => number;
  /** Re-check interval while queued, ms. Default 1000. */
  pollMs?: number;
  /** Give up waiting after this long, ms. Default 15 min. */
  maxWaitMs?: number;
}

export class EventBusHandoffs implements Handoffs {
  private readonly bus: EventBus;
  private readonly pool: pg.Pool | undefined;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  private readonly local = new Map<string, Promise<unknown>>();

  constructor(opts: HandoffsOptions) {
    this.bus = opts.bus;
    this.pool = opts.pool;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 1000;
    this.maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;
  }

  async bonds(launchId: string, at?: number): Promise<Bond[]> {
    return computeBonds(await this.bus.list(launchId), at ?? this.now());
  }

  async send(
    launchId: string,
    from: AgentId,
    to: AgentId,
    topic: string,
    summary: string,
    refEventId?: string,
  ): Promise<CarbonEvent<'handoff'>> {
    if (from === to) throw new TopologyError('an agent cannot hand off to itself');
    const created = await getLaunchCreated(this.bus, launchId);
    const shape = SHAPES[created.payload.shape];
    const pair = pairKey(from, to);
    if (!shape.topology.includes(pair)) {
      throw new TopologyError(`${from}→${to} is not a bond in the ${shape.id} shape`);
    }
    const payload = { from, to, topic, summary, ...(refEventId !== undefined ? { refEventId } : {}) };
    const started = Date.now(); // real elapsed time for the wait limit
    let queued = false;
    let wake: (() => void) | null = null;
    const unsubscribe = this.bus.subscribe(launchId, () => wake?.());
    try {
      for (;;) {
        const result = await this.withLock(launchId, async () => {
          const events = await this.bus.list(launchId);
          const fit = handoffFits(events, from, to, this.now());
          if (!fit.fits) {
            if (!queued) {
              await this.bus.append({ launchId, kind: 'handoff.queued', actor: from, payload: { ...payload, reason: fit.reason } });
              queued = true;
            }
            return null;
          }
          const e = await this.bus.append({ launchId, kind: 'handoff', actor: from, payload });
          // Post-check: the log is the truth. If something bypassed Handoffs and raced us,
          // the appended hand-off may not count; never report a hand-off the UI won't show.
          const after = analyzeBonds(await this.bus.list(launchId), e.ts);
          if (!after.acceptedHandoffIds.includes(e.id)) {
            throw new Error(`hand-off ${e.id.slice(0, 8)} was not accepted by the bond calculator`);
          }
          return e;
        });
        if (result) return result;
        if (Date.now() - started >= this.maxWaitMs) {
          throw new HandoffTimeoutError(`hand-off ${from}→${to} still exceeds valence ${VALENCE} after ${this.maxWaitMs} ms`);
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.pollMs);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
      }
    } finally {
      unsubscribe();
    }
  }

  private async withLock<T>(launchId: string, fn: () => Promise<T>): Promise<T> {
    // In-process serialization per launch…
    const prev = this.local.get(launchId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.local.set(launchId, chained);
    await prev;
    try {
      if (!this.pool) return await fn();
      // …and across processes.
      const client = await this.pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtext('carbon:handoff:' || $1))", [launchId]);
        try {
          return await fn();
        } finally {
          await client.query("SELECT pg_advisory_unlock(hashtext('carbon:handoff:' || $1))", [launchId]);
        }
      } finally {
        client.release();
      }
    } finally {
      release();
      if (this.local.get(launchId) === chained) this.local.delete(launchId);
    }
  }
}
