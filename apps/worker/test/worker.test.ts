import { randomUUID } from 'node:crypto';
import type { AgentContext, LaunchUser, RunnerOptions } from '@carbon/agents';
import type { CarbonEvent, LlmProvider } from '@carbon/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAssetStore } from '../src/assets.js';
import { createChainClient, launchAllowedCheck } from '../src/chain.js';
import { WebLaunchUser } from '../src/launch-user.js';
import { Supervisor } from '../src/supervisor.js';
import { ApprovalAlreadyUsedError, ApprovalNotConsumedError, ApprovedTextMismatchError, consumedApprovalCheck, createWorkerX } from '../src/x.js';
import { textHash } from '@carbon/x';
import { WALLET, testEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await testEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const created = (launchId: string, extra: Partial<CarbonEvent<'launch.created'>['payload']> = {}) =>
  env.core.bus.append({
    launchId,
    kind: 'launch.created',
    actor: 'user',
    payload: { line: 'a line', isotope: 'C-12', shape: 'chain', heavyAgent: null, launcherWallet: WALLET, xConnected: false, ...extra },
  });

describe('migrations', () => {
  it('core, x, worker and solana schemas are applied, idempotently', async () => {
    expect(env.applied).toContain('worker/001_worker.sql');
    expect(env.applied).toContain('worker/002_single_use.sql');
    expect(env.applied).toContain('solana/schema');
    const t = await env.core.bus.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [env.schema]);
    const names = t.rows.map((r: { table_name: string }) => r.table_name);
    for (const n of ['events', 'approvals', 'x_tokens', 'carbon_user_inputs', 'carbon_tx_requests', 'carbon_assets', 'sol_launches']) expect(names).toContain(n);
    const { migrateAll } = await import('../src/migrate.js');
    const again = await migrateAll(env.core.bus.pool);
    expect(again.filter((a) => a.startsWith('worker/'))).toEqual([]);
  });
});

describe('AssetStore', () => {
  it('stores bytes under a content-hash name with a public, immutable URI', async () => {
    const store = new PgAssetStore(env.core.bus.pool, 'https://carbon.test/');
    const bytes = new TextEncoder().encode('<html>hi</html>');
    const a = await store.put('L1', 'site-x.html', bytes, 'text/html; charset=utf-8');
    const b = await store.put('L1', 'site-x.html', bytes, 'text/html; charset=utf-8');
    expect(a.uri).toBe(b.uri);
    expect(a.uri).toMatch(/^https:\/\/carbon\.test\/api\/assets\/L1\/[0-9a-f]{16}-site-x\.html$/);
    const r = await env.core.bus.pool.query('SELECT bytes FROM carbon_assets WHERE launch_id = $1', ['L1']);
    expect(Buffer.from(r.rows[0].bytes).toString()).toBe('<html>hi</html>');
    await expect(store.put('L1', 'x', new Uint8Array(), 'image/png')).rejects.toThrow();
  });
});

describe('approval hooks never consume (the X hook records the one post an approval allows)', () => {
  it('x hook: one post per consumed approval of that launch + action, with the approved text only', async () => {
    const launchId = randomUUID();
    await created(launchId);
    const { approvals, bus } = env.core;
    const { approvalId } = await approvals.open(launchId, 'post', { title: 't', text: 'gm carbon' }, 'herald');
    const check = consumedApprovalCheck(bus.pool);
    const h = textHash('gm carbon');
    await expect(check(launchId, approvalId, 'post', h)).rejects.toThrow(ApprovalNotConsumedError);
    await approvals.decide(approvalId, true, WALLET);
    await expect(check(launchId, approvalId, 'post', h)).rejects.toThrow(ApprovalNotConsumedError); // granted but not consumed
    await approvals.consume(launchId, approvalId, 'post');
    await expect(check(launchId, approvalId, 'reply', h)).rejects.toThrow();
    await expect(check(randomUUID(), approvalId, 'post', h)).rejects.toThrow();
    await expect(check(launchId, approvalId, 'post', textHash('text nobody approved'))).rejects.toThrow(ApprovedTextMismatchError);
    await check(launchId, approvalId, 'post', h);
    await expect(check(launchId, approvalId, 'post', h)).rejects.toThrow(ApprovalAlreadyUsedError); // one approval, one post
    const uses = await bus.pool.query('SELECT text_sha256 FROM carbon_x_approval_uses WHERE approval_id = $1', [approvalId]);
    expect(uses.rows).toEqual([{ text_sha256: h }]);
  });

  it('x hook: concurrent posts under one approval → exactly one passes', async () => {
    const launchId = randomUUID();
    await created(launchId);
    const { approvals, bus } = env.core;
    const { approvalId } = await approvals.open(launchId, 'reply', { title: 't', text: 'thanks' }, 'keeper');
    await approvals.decide(approvalId, true, WALLET);
    await approvals.consume(launchId, approvalId, 'reply');
    const check = consumedApprovalCheck(bus.pool);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => check(launchId, approvalId, 'reply', textHash('thanks'))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('chain hook: needs a consumed launch approval AND a passing latest Sentinel score', async () => {
    const launchId = randomUUID();
    await created(launchId);
    const { approvals, bus } = env.core;
    const { approvalId } = await approvals.open(launchId, 'launch', { title: 'launch' }, 'treasurer');
    await approvals.decide(approvalId, true, WALLET);
    await approvals.consume(launchId, approvalId, 'launch');
    const check = launchAllowedCheck(bus.pool, bus);
    await expect(check(launchId, approvalId)).rejects.toThrow(/Sentinel/);
    const draft = { name: 'Frost', ticker: 'FRST', lore: 'cold', logoUri: 'u', logoHash: '0'.repeat(16), bannerUri: 'u', siteUri: 'u', metadataUri: 'u' };
    await bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: draft });
    await bus.append({ launchId, kind: 'sentinel.score', actor: 'sentinel', payload: { score: 90, threshold: 60, inputs: [], hardFail: false, passed: true, run: 1 } });
    await check(launchId, approvalId);
    // Re-appending the SAME content after the score is fine; a revised draft is not (AG-001).
    await bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: draft });
    await check(launchId, approvalId);
    await bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: { ...draft, name: 'Renamed', ticker: 'RNMD' } });
    await expect(check(launchId, approvalId)).rejects.toThrow(/Draft changed/);
    await bus.append({ launchId, kind: 'sentinel.score', actor: 'sentinel', payload: { score: 10, threshold: 60, inputs: [], hardFail: false, passed: false, run: 2 } });
    await expect(check(launchId, approvalId)).rejects.toThrow(/Sentinel/);
  });

  it('chain hook: a score computed against a lower threshold than the config row → refused', async () => {
    const launchId = randomUUID();
    await created(launchId, { shape: 'diamond' });
    const { approvals, bus } = env.core;
    const { approvalId } = await approvals.open(launchId, 'launch', { title: 'launch' }, 'treasurer');
    await approvals.decide(approvalId, true, WALLET);
    await approvals.consume(launchId, approvalId, 'launch');
    await bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: { name: 'F', ticker: 'F', lore: 'l', logoUri: 'u', logoHash: '0'.repeat(16), bannerUri: 'u', siteUri: 'u', metadataUri: 'u' } });
    await bus.append({ launchId, kind: 'sentinel.score', actor: 'sentinel', payload: { score: 70, threshold: 60, inputs: [], hardFail: false, passed: true, run: 1 } });
    await expect(launchAllowedCheck(bus.pool, bus)(launchId, approvalId)).rejects.toThrow(/lower threshold/);
  });

  it('without chain/X config the clients refuse honestly (no data)', async () => {
    const chain = createChainClient({ pool: env.core.bus.pool, bus: env.core.bus, env: {} });
    expect(chain.kind).toBe('unavailable');
    await expect(chain.client.searchCoins('x')).rejects.toThrow(/chain unavailable|ChainUnavailable|not set|CARBON_/);
    const x = createWorkerX(env.core.bus.pool, {});
    await expect(x.searchRecent('x')).rejects.toThrow(/X is not configured/);
    expect(await x.isConnected('L')).toBe(false);
  });
});

describe('WebLaunchUser', () => {
  it('waits for the signed choice and ignores answers from other wallets', async () => {
    const launchId = randomUUID();
    await created(launchId);
    const proposals = (await env.core.bus.append({
      launchId,
      kind: 'scout.proposals',
      actor: 'scout',
      payload: { narratives: [{ title: 'n', names: [{ name: 'A', ticker: 'A' }, { name: 'B', ticker: 'B' }], why: 'w', sources: [] }] },
    })) as CarbonEvent<'scout.proposals'>;
    const user = new WebLaunchUser({ pool: env.core.bus.pool, bus: env.core.bus, launchId, launcherWallet: WALLET, pollMs: 20, choiceTimeoutMs: 400 });
    const pool = env.core.bus.pool;
    const p = user.chooseNarrative(proposals);
    await pool.query(`INSERT INTO carbon_user_inputs (launch_id, kind, ref, payload, wallet, signature, created_at) VALUES ($1,'narrative',$2,$3,$4,'s',0)`, [
      launchId,
      proposals.id,
      JSON.stringify({ narrative: 0, name: 1 }),
      'SomeoneElse1111111111111111111111111111111',
    ]);
    await expect(p).rejects.toThrow(/timed out/);
    await pool.query(`UPDATE carbon_user_inputs SET wallet = $1 WHERE launch_id = $2`, [WALLET, launchId]);
    expect(await user.chooseNarrative(proposals)).toEqual({ narrative: 0, name: 1 });
  });

  it('relays the launch tx: request row out, signed tx back', async () => {
    const launchId = randomUUID();
    await created(launchId);
    const pool = env.core.bus.pool;
    const user = new WebLaunchUser({ pool, bus: env.core.bus, launchId, launcherWallet: WALLET, pollMs: 20, txTimeoutMs: 5000 });
    const p = user.signLaunchTx({ txBase64: 'dW5zaWduZWQ=', mint: 'Mint111' });
    let req: { request_id: string; payer: string } | undefined;
    for (let i = 0; i < 50 && !req; i++) {
      req = (await pool.query('SELECT request_id, payer FROM carbon_tx_requests WHERE launch_id = $1', [launchId])).rows[0];
      if (!req) await new Promise((r) => setTimeout(r, 20));
    }
    expect(req?.payer).toBe(WALLET);
    await pool.query(`INSERT INTO carbon_user_inputs (launch_id, kind, ref, payload, wallet, signature, created_at) VALUES ($1,'signed_tx',$2,$3,$4,'tx',0)`, [
      launchId,
      req!.request_id,
      JSON.stringify({ signedTx: 'c2lnbmVk' }),
      WALLET,
    ]);
    expect(await p).toBe('c2lnbmVk');
  });
});

describe('Supervisor', () => {
  const llm: LlmProvider = { id: 'none', model: 'none', generate: () => Promise.reject(new Error('no llm in this test')) };

  function supervisor(runs: string[], ticks: string[], outcome: 'deployed' | 'blocked' = 'blocked') {
    const { core } = env;
    const chain = createChainClient({ pool: core.bus.pool, bus: core.bus, env: {} });
    return new Supervisor({
      core,
      pool: core.bus.pool,
      llm,
      x: createWorkerX(core.bus.pool, {}),
      chain,
      assets: new PgAssetStore(core.bus.pool, 'https://carbon.test'),
      workerId: 'test',
      log: () => undefined,
      makeUser: () => ({}) as LaunchUser,
      makeRunner: (ctx: AgentContext, _u: LaunchUser, _o: RunnerOptions) => ({
        run: async () => {
          runs.push(ctx.launchId);
          if (outcome === 'deployed') {
            const deployed = (await core.bus.append({
              launchId: ctx.launchId,
              kind: 'launch.deployed',
              actor: 'treasurer',
              payload: { ca: 'Ca1111111111111111111111111111111111111111', txSig: 'sig', creatorWallet: 'Fee11111111111111111111111111111111111111', devBuySol: 0.1, network: 'devnet' },
            })) as CarbonEvent<'launch.deployed'>;
            return { status: 'deployed' as const, deployed, announcement: null };
          }
          return { status: 'not-approved' as const };
        },
        tick: async () => {
          ticks.push(ctx.launchId);
          return { claimed: false, buyback: null, posts: [], replies: [] };
        },
      }),
    });
  }

  it('runs each new launch exactly once, even with two supervisors', async () => {
    const runs: string[] = [];
    const a = supervisor(runs, []);
    const b = supervisor(runs, []);
    await a.start();
    await b.start();
    const launchId = randomUUID();
    await created(launchId);
    await new Promise((r) => setTimeout(r, 1500));
    await a.idle();
    await b.idle();
    await a.stop();
    await b.stop();
    expect(runs.filter((r) => r === launchId)).toEqual([launchId]);
    const row = await env.core.bus.pool.query('SELECT status, outcome FROM carbon_worker_launches WHERE launch_id = $1', [launchId]);
    expect(row.rows[0]).toEqual({ status: 'finished', outcome: 'not-approved' });
  });

  it('after deploy: wallet.created + decay.started once, and the schedule is computed from the log', async () => {
    const runs: string[] = [];
    const s = supervisor(runs, [], 'deployed');
    const launchId = randomUUID();
    const c = (await created(launchId, { isotope: 'C-14', shape: 'ring' })) as CarbonEvent<'launch.created'>;
    await s.claimAndRun(c);
    const evs = await env.core.bus.list(launchId, { kinds: ['wallet.created', 'decay.started', 'launch.deployed'] });
    const dep = evs.find((e) => e.kind === 'launch.deployed')!;
    expect(evs.filter((e) => e.kind === 'wallet.created')).toHaveLength(1);
    const ds = evs.find((e) => e.kind === 'decay.started') as CarbonEvent<'decay.started'>;
    expect(ds.payload).toEqual({ rule: 'clock', collapseAt: dep.ts + 7 * 24 * 3600 * 1000 });
    expect(await s.nextTickAt(c)).toBe(dep.ts + 10 * 60_000); // RING loop: 10 min after the last logged tick
    expect(s.jobs()).toContain(`tick:${launchId}`);
    await s.stop();

    // Restart: the new supervisor recovers the schedule from the log and emits nothing twice.
    const s2 = supervisor([], []);
    await s2.start();
    expect(s2.jobs()).toContain(`tick:${launchId}`);
    await s2.stop();
    const again = await env.core.bus.list(launchId, { kinds: ['wallet.created', 'decay.started'] });
    expect(again).toHaveLength(2);
  });

  it('a pre-deploy flow interrupted by a restart is marked and explained in the log', async () => {
    const launchId = randomUUID();
    await created(launchId);
    await env.core.bus.pool.query(`INSERT INTO carbon_worker_launches (launch_id, status, worker_id, claimed_at) VALUES ($1, 'running', 'old', 0)`, [launchId]);
    const runs: string[] = [];
    const s = supervisor(runs, []);
    await s.start();
    await s.stop();
    expect(runs).not.toContain(launchId);
    const errs = await env.core.bus.list(launchId, { kinds: ['error'] });
    expect(errs).toHaveLength(1);
    const row = await env.core.bus.pool.query('SELECT status FROM carbon_worker_launches WHERE launch_id = $1', [launchId]);
    expect(row.rows[0].status).toBe('interrupted');
  });
});
