import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchConfig } from '../src/contracts.js';
import { BudgetExceededError, LAMPORTS_PER_SOL, PgBudgets } from '../src/budgets.js';
import { createLaunch, testEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await testEnv();
});
afterEach(async () => {
  await env.cleanup();
});

const budgets = () => new PgBudgets({ bus: env.bus, pool: env.bus.pool, now: env.clock.now });

describe('Budgets', () => {
  it('llm capacity per agent per rolling hour, and budget.exceeded is emitted', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const cap = launchConfig('Ar-36', 'chain').capacity.scout.llmCallsPerHour;
    const b = budgets();
    for (let i = 0; i < cap; i++) await b.spend(l, 'scout', 'llm');
    await expect(b.spend(l, 'scout', 'llm')).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(b.spend(l, 'forge', 'llm')).resolves.toBeUndefined(); // per agent
    const ex = await env.bus.list(l, { kinds: ['budget.exceeded'] });
    expect(ex.map((e) => e.payload)).toEqual([{ agent: 'scout', budget: 'llm', limit: cap }]);
    env.clock.advance(60 * 60_000 + 1);
    await expect(b.spend(l, 'scout', 'llm')).resolves.toBeUndefined();
  });

  it('budgets survive a restart (new process, same database)', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const posts = launchConfig('Ar-36', 'chain').postsPerHour;
    for (let i = 0; i < posts; i++) await budgets().spend(l, 'herald', 'post');
    // "Restart": a brand-new bus connection and a brand-new Budgets instance.
    const bus2 = await env.open();
    const b2 = new PgBudgets({ bus: bus2, pool: bus2.pool, now: env.clock.now });
    await expect(b2.spend(l, 'herald', 'post')).rejects.toThrow(BudgetExceededError);
    expect(await b2.used(l, 'herald', 'post')).toBe(posts);
  });

  it('Ar-40 heavy Herald gets 2x posts; everyone else is unchanged', async () => {
    const l = await createLaunch(env.bus, 'ring', 'Ar-40', 'herald');
    const base = launchConfig('Ar-36', 'ring');
    const b = budgets();
    for (let i = 0; i < base.postsPerHour * 2; i++) await b.spend(l, 'herald', 'post');
    await expect(b.spend(l, 'herald', 'post')).rejects.toThrow(BudgetExceededError);
    for (let i = 0; i < base.repliesPerHour; i++) await b.spend(l, 'keeper', 'reply');
    await expect(b.spend(l, 'keeper', 'reply')).rejects.toThrow(BudgetExceededError);
  });

  it('dev buy is capped at devBuySol over the launch lifetime', async () => {
    const l = await createLaunch(env.bus, 'chain', 'Ar-41');
    const cap = Math.round(launchConfig('Ar-41', 'chain').devBuySol * LAMPORTS_PER_SOL);
    const b = budgets();
    await expect(b.spend(l, 'treasurer', 'devbuy-lamports', cap + 1)).rejects.toThrow(BudgetExceededError);
    await b.spend(l, 'treasurer', 'devbuy-lamports', cap);
    env.clock.advance(10 * 24 * 60 * 60_000);
    await expect(b.spend(l, 'treasurer', 'devbuy-lamports', 1)).rejects.toThrow(BudgetExceededError);
  });

  it('buyback is capped per tick (ring loop period); chain allows no buyback', async () => {
    const l = await createLaunch(env.bus, 'ring');
    const cfg = launchConfig('Ar-36', 'ring');
    const cap = Math.round(cfg.buybackSolPerTick * LAMPORTS_PER_SOL);
    const b = budgets();
    await b.spend(l, 'treasurer', 'buyback-lamports', cap);
    await expect(b.spend(l, 'treasurer', 'buyback-lamports', 1)).rejects.toThrow(BudgetExceededError);
    env.clock.advance(cfg.loopMinutes! * 60_000 + 1);
    await expect(b.spend(l, 'treasurer', 'buyback-lamports', cap)).resolves.toBeUndefined();
    const c = await createLaunch(env.bus, 'chain');
    await expect(b.spend(c, 'treasurer', 'buyback-lamports', 1)).rejects.toThrow(BudgetExceededError);
  });

  it('concurrent spends cannot overshoot', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const cap = launchConfig('Ar-36', 'chain').capacity.forge.llmCallsPerHour;
    const b = budgets();
    const r = await Promise.allSettled(Array.from({ length: cap + 10 }, () => b.spend(l, 'forge', 'llm')));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(cap);
  });

  it('rejects non-positive or fractional amounts', async () => {
    const l = await createLaunch(env.bus, 'chain');
    await expect(budgets().spend(l, 'scout', 'llm', 0)).rejects.toThrow(RangeError);
    await expect(budgets().spend(l, 'scout', 'llm', 1.5)).rejects.toThrow(RangeError);
  });
});
