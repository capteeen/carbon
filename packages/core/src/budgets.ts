/**
 * Budgets, enforced from a Postgres ledger (so restarts cannot reset counts).
 *
 *   llm               per agent, rolling hour  ≤ capacity[agent].llmCallsPerHour
 *   post              per launch, rolling hour ≤ postsPerHour   (Herald's budget; heavy Herald 2x)
 *   reply             per launch, rolling hour ≤ repliesPerHour (Keeper's budget; heavy Keeper 2x)
 *   devbuy-lamports   per launch, lifetime     ≤ devBuySol × 1e9
 *   buyback-lamports  per launch, per tick     ≤ buybackSolPerTick × 1e9, where a tick is the
 *                     shape's loop period (loopMinutes, or 10 min when the shape has no loop)
 *
 * Over budget: nothing is recorded, a `budget.exceeded` event is appended, and
 * BudgetExceededError is thrown. Check+record is atomic per (launch, kind, agent).
 */
import type pg from 'pg';
import type { AgentId, LaunchConfig } from './contracts.js';
import type { Budgets, EventBus } from './ports.js';
import { getLaunchConfig } from './launch.js';

export type BudgetKind = Parameters<Budgets['spend']>[2];

export class BudgetExceededError extends Error {
  constructor(
    readonly agent: AgentId,
    readonly budget: BudgetKind,
    readonly limit: number,
    readonly used: number,
    readonly requested: number,
  ) {
    super(`${agent} is over its ${budget} budget (${used} + ${requested} > ${limit})`);
    this.name = 'BudgetExceededError';
  }
}

const HOUR_MS = 60 * 60_000;
export const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_TICK_MIN = 10;

export interface BudgetRule {
  limit: number;
  /** Rolling window in ms; null = lifetime of the launch. */
  windowMs: number | null;
  /** Count across all agents of the launch (true) or only this agent (false). */
  launchWide: boolean;
}

/** The rule for a budget kind under a launch config. Pure. */
export function budgetRule(cfg: LaunchConfig, agent: AgentId, kind: BudgetKind): BudgetRule {
  switch (kind) {
    case 'llm':
      return { limit: cfg.capacity[agent].llmCallsPerHour, windowMs: HOUR_MS, launchWide: false };
    case 'post':
      return { limit: cfg.postsPerHour, windowMs: HOUR_MS, launchWide: true };
    case 'reply':
      return { limit: cfg.repliesPerHour, windowMs: HOUR_MS, launchWide: true };
    case 'devbuy-lamports':
      return { limit: Math.round(cfg.devBuySol * LAMPORTS_PER_SOL), windowMs: null, launchWide: true };
    case 'buyback-lamports':
      return {
        limit: Math.round(cfg.buybackSolPerTick * LAMPORTS_PER_SOL),
        windowMs: (cfg.loopMinutes ?? DEFAULT_TICK_MIN) * 60_000,
        launchWide: true,
      };
  }
}

export interface BudgetsOptions {
  bus: EventBus;
  pool: pg.Pool;
  now?: () => number;
}

export class PgBudgets implements Budgets {
  private readonly bus: EventBus;
  private readonly pool: pg.Pool;
  private readonly now: () => number;
  private readonly configs = new Map<string, LaunchConfig>();

  constructor(opts: BudgetsOptions) {
    this.bus = opts.bus;
    this.pool = opts.pool;
    this.now = opts.now ?? Date.now;
  }

  private async config(launchId: string): Promise<LaunchConfig> {
    let c = this.configs.get(launchId);
    if (!c) {
      c = await getLaunchConfig(this.bus, launchId); // launch.created is immutable, so caching is safe
      this.configs.set(launchId, c);
    }
    return c;
  }

  /** Amount used in the rule's current window. */
  async used(launchId: string, agent: AgentId, kind: BudgetKind): Promise<number> {
    const rule = budgetRule(await this.config(launchId), agent, kind);
    return this.sum(this.pool, launchId, agent, kind, rule, this.now());
  }

  async spend(launchId: string, agent: AgentId, kind: BudgetKind, amount = 1): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError('budget amount must be a positive integer');
    const rule = budgetRule(await this.config(launchId), agent, kind);
    const client = await this.pool.connect();
    let over: { used: number } | null = null;
    try {
      await client.query('BEGIN');
      try {
        const lockKey = `carbon:budget:${launchId}:${kind}:${rule.launchWide ? '*' : agent}`;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
        const t = this.now();
        const used = await this.sum(client, launchId, agent, kind, rule, t);
        if (used + amount > rule.limit) {
          over = { used };
          await client.query('ROLLBACK');
        } else {
          await client.query('INSERT INTO budget_ledger (launch_id, agent, kind, amount, ts) VALUES ($1, $2, $3, $4, $5)', [
            launchId,
            agent,
            kind,
            amount,
            t,
          ]);
          await client.query('COMMIT');
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
    if (over) {
      await this.bus.append({ launchId, kind: 'budget.exceeded', actor: agent, payload: { agent, budget: kind, limit: rule.limit } });
      throw new BudgetExceededError(agent, kind, rule.limit, over.used, amount);
    }
  }

  private async sum(
    q: pg.Pool | pg.PoolClient,
    launchId: string,
    agent: AgentId,
    kind: BudgetKind,
    rule: BudgetRule,
    t: number,
  ): Promise<number> {
    const params: unknown[] = [launchId, kind];
    let sql = 'SELECT COALESCE(SUM(amount), 0)::text AS s FROM budget_ledger WHERE launch_id = $1 AND kind = $2';
    if (!rule.launchWide) {
      params.push(agent);
      sql += ` AND agent = $${params.length}`;
    }
    if (rule.windowMs !== null) {
      params.push(t - rule.windowMs);
      sql += ` AND ts > $${params.length}`;
    }
    const res = await q.query<{ s: string }>(sql, params);
    return Number(res.rows[0]?.s ?? 0);
  }
}
