/**
 * The worker's launch supervisor.
 *
 * - Subscribes to launch.created and runs a MoleculeRunner per launch (claimed in
 *   carbon_worker_launches so only one worker runs it).
 * - After deploy: emits wallet.created (once) and decay.started (unstable isotopes,
 *   once), then runs the launch's schedule (RING loop every loopMinutes, otherwise
 *   the Treasurer fee-claim schedule) and, for Ar-41/Ar-39, the decay watcher.
 * - Restarts: every schedule's next run is computed from the log (the last loop
 *   hand-off / fee claim / deploy event), decay state lives in sol_decay, and a
 *   pre-deploy flow that was running when the worker stopped is marked
 *   interrupted with a public `error` event (the agents' flow is not resumable
 *   mid-way; re-running it would duplicate Scout/Forge work and approvals).
 */
import { MoleculeRunner, type AgentContext, type AssetStore, type LaunchUser, type RunnerOptions } from '@argon/agents';
import {
  ISOTOPES,
  configFromCreated,
  type ArgonEvent,
  type Core,
  type DecayRule,
  type EventKind,
  type EventPayloads,
  type LaunchConfig,
  type LlmProvider,
  type XClient,
} from '@argon/core';
import { DecayWatcher, type ArgonChainClient } from '@argon/solana';
import type pg from 'pg';
import type { WorkerChain } from './chain.js';
import { WebLaunchUser } from './launch-user.js';

export const CLAIM_EVERY_MINUTES = 60;
export const DECAY_POLL_MS = 30_000;
/** A launch created while the worker was offline is still started if it is this fresh. */
export const START_GRACE_MS = 30 * 60_000;

type Runner = Pick<MoleculeRunner, 'run' | 'tick'>;

export interface SupervisorDeps {
  core: Pick<Core, 'bus' | 'handoffs' | 'approvals' | 'budgets'>;
  pool: pg.Pool;
  llm: LlmProvider;
  x: XClient;
  chain: WorkerChain;
  assets: AssetStore;
  workerId: string;
  feeMode?: 'native' | 'wallet';
  now?: () => number;
  log?: (msg: string) => void;
  makeRunner?: (ctx: AgentContext, user: LaunchUser, opts: RunnerOptions) => Runner;
  makeUser?: (launchId: string, launcherWallet: string) => LaunchUser;
  decayPollMs?: number;
}

export class Supervisor {
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly runners = new Map<string, Runner>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly decay: DecayWatcher | null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly d: SupervisorDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.log(`[argon/worker] ${m}`));
    this.decay = d.chain.kind === 'solana' ? new DecayWatcher({ client: d.chain.client as ArgonChainClient, db: d.pool, now: this.now }) : null;
  }

  private get bus() {
    return this.d.core.bus;
  }

  private ctx(launchId: string, config: LaunchConfig): AgentContext {
    const { bus, handoffs, approvals, budgets } = this.d.core;
    return { bus, handoffs, approvals, budgets, llm: this.d.llm, x: this.d.x, chain: this.d.chain.client, config, launchId, now: this.now, assets: this.d.assets };
  }

  private runner(launchId: string, created: ArgonEvent<'launch.created'>): Runner {
    let r = this.runners.get(launchId);
    if (!r) {
      const user = this.d.makeUser
        ? this.d.makeUser(launchId, created.payload.launcherWallet)
        : new WebLaunchUser({ pool: this.d.pool, bus: this.bus, launchId, launcherWallet: created.payload.launcherWallet });
      const ctx = this.ctx(launchId, configFromCreated(created.payload));
      const opts: RunnerOptions = { claimEveryMinutes: CLAIM_EVERY_MINUTES };
      r = this.d.makeRunner ? this.d.makeRunner(ctx, user, opts) : new MoleculeRunner(ctx, user, opts);
      this.runners.set(launchId, r);
    }
    return r;
  }

  private async events(launchId: string, kinds?: EventKind[]): Promise<ArgonEvent[]> {
    return this.bus.list(launchId, kinds ? { kinds } : {});
  }

  /** Boot: recover state from the log, then follow new launches. */
  async start(): Promise<void> {
    const from = await this.maxSeq();
    const created = (await this.bus.list('*', { kinds: ['launch.created'] })) as ArgonEvent<'launch.created'>[];
    const seen = new Set<string>();
    for (const c of created) {
      if (seen.has(c.launchId)) continue;
      seen.add(c.launchId);
      await this.recover(c).catch((e: unknown) => this.log(`recover ${c.launchId} failed: ${errName(e)}`));
    }
    this.unsubscribe = this.bus.subscribe(
      '*',
      (e) => {
        if (e.kind === 'launch.created' && !this.stopped) void this.claimAndRun(e as ArgonEvent<'launch.created'>);
      },
      { afterSeq: from },
    );
  }

  private async maxSeq(): Promise<number> {
    const r = await this.d.pool.query<{ m: string | null }>('SELECT max(seq) AS m FROM events');
    return r.rows[0]?.m ? Number(r.rows[0].m) : 0;
  }

  private async recover(created: ArgonEvent<'launch.created'>): Promise<void> {
    const launchId = created.launchId;
    const deployed = (await this.events(launchId, ['launch.deployed']))[0] as ArgonEvent<'launch.deployed'> | undefined;
    if (deployed) {
      await this.afterDeploy(created, deployed);
      return;
    }
    const claim = await this.d.pool.query<{ status: string }>('SELECT status FROM carbon_worker_launches WHERE launch_id = $1', [launchId]);
    const status = claim.rows[0]?.status;
    if (status === 'running') {
      await this.d.pool.query(
        "UPDATE carbon_worker_launches SET status = 'interrupted', finished_at = $2, outcome = 'worker restarted' WHERE launch_id = $1 AND status = 'running'",
        [launchId, this.now()],
      );
      await this.bus.append({
        launchId,
        kind: 'error',
        actor: 'system',
        payload: { message: 'The worker restarted while this launch was in progress, so its flow stopped before deploy. Start a new launch.' },
      });
      return;
    }
    if (!status && this.now() - created.ts <= START_GRACE_MS) await this.claimAndRun(created);
  }

  /** Claims the launch (one worker only) and runs its flow. */
  async claimAndRun(created: ArgonEvent<'launch.created'>): Promise<void> {
    const launchId = created.launchId;
    const first = (await this.events(launchId, ['launch.created']))[0];
    if (!first || first.id !== created.id) return; // only the launch's first launch.created counts
    const r = await this.d.pool.query(
      `INSERT INTO carbon_worker_launches (launch_id, status, worker_id, claimed_at) VALUES ($1, 'running', $2, $3) ON CONFLICT (launch_id) DO NOTHING`,
      [launchId, this.d.workerId, this.now()],
    );
    if (r.rowCount !== 1) return;
    const p = this.runFlow(created).finally(() => this.running.delete(launchId));
    this.running.set(launchId, p);
    await p;
  }

  private async runFlow(created: ArgonEvent<'launch.created'>): Promise<void> {
    const launchId = created.launchId;
    let outcome: string;
    try {
      const res = await this.runner(launchId, created).run();
      outcome = res.status;
      if (res.status === 'deployed') await this.afterDeploy(created, res.deployed);
    } catch (e) {
      outcome = `failed: ${errName(e)}`;
      const message = e instanceof Error ? e.message.slice(0, 500) : 'launch flow failed';
      await this.bus.append({ launchId, kind: 'error', actor: 'system', payload: { message } }).catch(() => undefined);
    }
    await this.d.pool.query("UPDATE carbon_worker_launches SET status = 'finished', finished_at = $2, outcome = $3 WHERE launch_id = $1", [launchId, this.now(), outcome]);
  }

  /** Once deployed: public wallet + decay events (once each), then the schedules. */
  private async afterDeploy(created: ArgonEvent<'launch.created'>, deployed: ArgonEvent<'launch.deployed'>): Promise<void> {
    const launchId = created.launchId;
    const log = await this.events(launchId, ['wallet.created', 'decay.started']);
    if (!log.some((e) => e.kind === 'wallet.created')) {
      await this.bus.append({ launchId, kind: 'wallet.created', actor: 'treasurer', payload: { address: deployed.payload.creatorWallet, mode: this.d.feeMode ?? 'native' } });
    }
    const rule: DecayRule = ISOTOPES[created.payload.isotope].decay;
    if (rule.kind !== 'none' && !log.some((e) => e.kind === 'decay.started')) {
      await this.bus.append({
        launchId,
        kind: 'decay.started',
        actor: 'system',
        payload: { rule: rule.kind, collapseAt: rule.kind === 'clock' ? deployed.ts + rule.clockSec * 1000 : null },
      });
    }
    await this.scheduleTick(created);
    if (rule.kind !== 'none') this.scheduleDecay(created, deployed, 0);
  }

  /** Next tick = last logged tick (loop hand-off, fee claim or deploy) + period. */
  async nextTickAt(created: ArgonEvent<'launch.created'>): Promise<number> {
    const cfg = configFromCreated(created.payload);
    const periodMs = (cfg.loopMinutes ?? CLAIM_EVERY_MINUTES) * 60_000;
    const evs = await this.events(created.launchId, ['handoff', 'fee.claimed', 'launch.deployed']);
    let last = 0;
    for (const e of evs) {
      if (e.kind === 'handoff' && (e.payload as EventPayloads['handoff']).topic !== 'loop') continue;
      last = Math.max(last, e.ts);
    }
    return last + periodMs;
  }

  private async scheduleTick(created: ArgonEvent<'launch.created'>): Promise<void> {
    if (this.stopped) return;
    const key = `tick:${created.launchId}`;
    const at = await this.nextTickAt(created);
    const delay = Math.max(1000, at - this.now());
    this.setTimer(key, delay, async () => {
      try {
        await this.runner(created.launchId, created).tick();
      } catch (e) {
        this.log(`tick ${created.launchId} failed: ${errName(e)}`);
      }
      // A tick with no fees and no loop leaves no event: schedule from now.
      const cfg = configFromCreated(created.payload);
      const periodMs = (cfg.loopMinutes ?? CLAIM_EVERY_MINUTES) * 60_000;
      if (!this.stopped) this.setTimer(key, periodMs, () => this.scheduleTick(created));
    });
  }

  private scheduleDecay(created: ArgonEvent<'launch.created'>, deployed: ArgonEvent<'launch.deployed'>, delay: number): void {
    if (this.stopped) return;
    const key = `decay:${created.launchId}`;
    if (!this.decay) {
      this.log(`decay watcher for ${created.launchId} idle: chain unavailable`);
      return;
    }
    this.setTimer(key, delay, async () => {
      const done = await this.decayTick(created, deployed).catch((e: unknown) => {
        this.log(`decay ${created.launchId} failed: ${errName(e)}`);
        return false;
      });
      if (!done) this.scheduleDecay(created, deployed, this.d.decayPollMs ?? DECAY_POLL_MS);
    });
  }

  /** One decay step; appends the watcher's events in order and acks each. Returns true when finished. */
  async decayTick(created: ArgonEvent<'launch.created'>, deployed: ArgonEvent<'launch.deployed'>): Promise<boolean> {
    if (!this.decay) return false;
    const launchId = created.launchId;
    const drafts = (await this.events(launchId, ['forge.draft'])) as ArgonEvent<'forge.draft'>[];
    const draft = drafts[drafts.length - 1];
    if (!draft) return false;
    const cfg = configFromCreated(created.payload);
    const res = await this.decay.tick({
      launchId,
      ca: deployed.payload.ca,
      rule: cfg.decay,
      bornAtMs: deployed.ts,
      name: draft.payload.name,
      symbol: draft.payload.ticker,
      description: draft.payload.lore,
      imageUri: draft.payload.logoUri,
      launcherWallet: created.payload.launcherWallet,
      generation: 1,
      devBuySol: cfg.devBuySol,
    });
    for (const ev of res.events) {
      const e = await this.bus.append({ launchId, kind: ev.kind, actor: 'treasurer', payload: ev.payload } as Parameters<typeof this.bus.append>[0]);
      if (ev.kind === 'holders.snapshot') await this.decay.ackSnapshot(launchId, e.id);
      else if (ev.kind === 'decay.collapsed') await this.decay.ack(launchId, 'collapsed', e.id);
      else if (ev.kind === 'daughter.launched') await this.decay.ack(launchId, 'daughter', e.id);
      else if (ev.kind === 'airdrop.sent') await this.decay.ack(launchId, `airdrop:${(ev.payload as EventPayloads['airdrop.sent']).wallet}`, e.id);
    }
    if (res.error) this.log(`decay ${launchId}: ${res.error.slice(0, 200)}`);
    return res.state === 'done' && res.events.length === 0;
  }

  private setTimer(key: string, ms: number, fn: () => Promise<void> | void): void {
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.timers.delete(key);
      void fn();
    }, ms);
    t.unref?.();
    this.timers.set(key, t);
  }

  /** Scheduled job keys (for health and tests). */
  jobs(): string[] {
    return [...this.timers.keys()].sort();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Resolves when every launch flow started so far has finished (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }
}

function errName(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : 'error';
}
