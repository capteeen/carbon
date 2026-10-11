/**
 * SPEC §1/§3/§7: "Launch below threshold or with a hard fail: blocked."
 * "Post or launch without approval: impossible." (launch half; posts are in approvals.test.ts)
 *
 * The production wiring is exercised: the worker's launchAllowedCheck (the hook
 * apps/worker/src/chain.ts passes to @carbon/solana) inside a real CarbonChainClient
 * on a test-double chain, real core approvals in Postgres, and @carbon/agents'
 * Treasurer.deploy.
 */
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalError,
  foldMolecule,
  getLaunchConfig,
  launchConfig,
  type CarbonEvent,
  type SentinelReport,
} from '@carbon/core';
import { CarbonChainClient, loadSolanaConfig } from '@carbon/solana';
import { Treasurer, assertLaunchCleared, type AgentContext } from '@carbon/agents';
import { launchAllowedCheck } from '../../apps/worker/src/chain.js';
import { FakeChain } from '../../packages/solana/test/helpers/fakeChain.js';
import { encodeAccount } from '../../packages/solana/test/helpers/events.js';
import { fixtureGlobal } from '../../packages/solana/test/fixtures/pump.js';
import { PUMP_PROGRAM_ID } from '../../packages/solana/src/programs.js';
import { pumpSdk } from '../../packages/solana/src/sdk.js';
import { createLaunch, makeEnv, wallet, type Env } from './support/env.js';

const URI = 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

function solEnv() {
  const k = { buyback: Keypair.generate(), treasury: Keypair.generate(), crank: Keypair.generate() };
  return {
    CARBON_FEE_MODE: 'wallet', // fits one packet without a lookup table on the test-double chain
    CARBON_VAULT_KEY: randomBytes(32).toString('hex'),
    CARBON_BUYBACK_WALLET: k.buyback.publicKey.toBase58(),
    CARBON_TREASURY_WALLET: k.treasury.publicKey.toBase58(),
  } as Record<string, string>;
}

function report(score: number, threshold: number, hardFail = false, run = 1): SentinelReport {
  return {
    score,
    threshold,
    hardFail,
    passed: score >= threshold && !hardFail,
    run,
    inputs: [{ key: 'content', points: hardFail ? 0 : 20, max: 20, reason: hardFail ? 'real_person: test' : 'clean', hardFail }],
  };
}

describe('launch gate at the chain seam (worker launchAllowedCheck + CarbonChainClient.buildLaunchTx)', () => {
  let env: Env;
  let chain: FakeChain;
  let client: CarbonChainClient;
  beforeAll(async () => {
    env = await makeEnv();
    chain = new FakeChain();
    chain.accounts.set(pumpSdk.GLOBAL_PDA.toBase58(), { data: await encodeAccount('pump', 'global', fixtureGlobal() as never), owner: PUMP_PROGRAM_ID, lamports: 1, executable: false });
    const e = solEnv();
    client = new CarbonChainClient({
      config: loadSolanaConfig(e),
      rpc: chain.rpc(),
      db: env.core.bus.pool,
      env: e,
      poll: { pollMs: 0, maxPolls: 2, rebroadcastEvery: 1 },
      assertLaunchAllowed: launchAllowedCheck(env.core.bus.pool, env.core.bus),
      launchConfig: (id) => getLaunchConfig(env.core.bus, id),
    });
  });
  afterAll(async () => env.cleanup());

  async function setup(opts: { score?: SentinelReport | null; approve?: 'consumed' | 'granted' | 'none'; action?: 'launch' | 'post' } = {}) {
    const w = wallet();
    const launchId = await createLaunch(env.core, 'ring', 'C-12', null, w.address);
    await client.createLaunchWallet(launchId);
    await env.core.bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: { name: 'Frost Lattice', ticker: 'FRST', lore: 'cold', logoUri: 'u', logoHash: '0'.repeat(16), bannerUri: 'u', siteUri: 'u', metadataUri: URI } });
    if (opts.score !== null) await env.core.bus.append({ launchId, kind: 'sentinel.score', actor: 'sentinel', payload: opts.score ?? report(80, 70) });
    let approvalId = 'no-approval';
    if ((opts.approve ?? 'consumed') !== 'none') {
      const action = opts.action ?? 'launch';
      ({ approvalId } = await env.core.approvals.open(launchId, action, { title: 'launch' }, 'treasurer'));
      await env.core.approvals.decide(approvalId, true, w.address);
      if ((opts.approve ?? 'consumed') === 'consumed') await env.core.approvals.consume(launchId, approvalId, action);
    }
    const payer = Keypair.generate().publicKey.toBase58();
    const args = { launchId, payer, name: 'Frost Lattice', symbol: 'FRST', metadataUri: URI, devBuySol: launchConfig('C-12', 'ring').devBuySol, approvalId };
    return { launchId, approvalId, args, w };
  }

  it('baseline: consumed launch approval + passing score builds the tx', async () => {
    const { args } = await setup();
    await expect(client.buildLaunchTx(args)).resolves.toMatchObject({ mint: expect.any(String) });
  });

  it('no Sentinel score yet → blocked', async () => {
    const { args } = await setup({ score: null });
    await expect(client.buildLaunchTx(args)).rejects.toThrow(/Sentinel/);
  });

  it('score below the shape threshold → blocked', async () => {
    const { args } = await setup({ score: report(69, 70) });
    await expect(client.buildLaunchTx(args)).rejects.toThrow(/did not pass/);
  });

  it('hard fail with a high score → blocked', async () => {
    const { args } = await setup({ score: { ...report(99, 70, true), passed: false } });
    await expect(client.buildLaunchTx(args)).rejects.toThrow(/did not pass/);
  });

  it('a later failing re-run supersedes an earlier pass → blocked', async () => {
    const { launchId, args } = await setup();
    await env.core.bus.append({ launchId, kind: 'sentinel.score', actor: 'sentinel', payload: report(40, 70, false, 2) });
    await expect(client.buildLaunchTx(args)).rejects.toThrow(/did not pass/);
  });

  it('no approval / granted-but-not-consumed / approval for another action → blocked', async () => {
    await expect(client.buildLaunchTx((await setup({ approve: 'none' })).args)).rejects.toThrow(/not consumed/);
    await expect(client.buildLaunchTx((await setup({ approve: 'granted' })).args)).rejects.toThrow(/not consumed/);
    await expect(client.buildLaunchTx((await setup({ action: 'post' })).args)).rejects.toThrow(/not consumed/);
  });

  it('an approval consumed for ANOTHER launch → blocked', async () => {
    const a = await setup();
    const b = await setup({ approve: 'none' });
    await expect(client.buildLaunchTx({ ...b.args, approvalId: a.approvalId })).rejects.toThrow(/not consumed/);
  });

  it('a dev buy different from the config row → blocked', async () => {
    const { args } = await setup();
    await expect(client.buildLaunchTx({ ...args, devBuySol: 5 })).rejects.toThrow(/differs from the config/);
  });

  // The chain-level check reads only "latest sentinel.score passed". A forge.draft
  // appended AFTER that score (a revision) leaves the old pass in place, and
  // buildLaunchTx does not compare name/symbol/metadata with what was scored.
  it('[AG-001] a draft changed after the passing score (stale score) → blocked at the chain seam', async () => {
    const { launchId, args } = await setup();
    await env.core.bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: { name: 'Elon Frost', ticker: 'ELON', lore: 'renamed after the check', logoUri: 'u', logoHash: 'f'.repeat(16), bannerUri: 'u', siteUri: 'u', metadataUri: URI } });
    await expect(client.buildLaunchTx({ ...args, name: 'Elon Frost', symbol: 'ELON' })).rejects.toThrow();
  });

  // assertLaunchAllowed only CHECKS that the approval is consumed; it never binds the
  // approval to one build. A consumed approval therefore authorises any number of
  // rebuilds, with any name/symbol/uri, until the tx is submitted.
  it.fails('[AG-002] a consumed launch approval cannot be reused to build a second, different launch tx', async () => {
    const { args } = await setup();
    await client.buildLaunchTx(args);
    await expect(client.buildLaunchTx({ ...args, name: 'Something Else', symbol: 'ELSE', metadataUri: URI + '?v=2' })).rejects.toThrow();
  });
});

describe('launch gate in the agents and core', () => {
  let env: Env;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => env.cleanup());

  function ctx(launchId: string): AgentContext {
    const { bus, handoffs, approvals, budgets } = env.core;
    const chainCalls: string[] = [];
    return {
      bus,
      handoffs,
      approvals,
      budgets,
      llm: {} as never,
      x: {} as never,
      chain: new Proxy({ network: 'devnet' } as Record<string, unknown>, {
        get: (t, k) => (k in t ? t[k as string] : (..._a: unknown[]) => (chainCalls.push(String(k)), Promise.reject(new Error(`chain.${String(k)} must not be reached`)))),
      }) as never,
      config: launchConfig('C-12', 'ring'),
      launchId,
      now: env.clock.now,
      assets: { put: async () => ({ uri: 'u' }) },
    };
  }

  it('Treasurer.deploy refuses before any chain call: below threshold, hard fail, stale draft, threshold lower than the row', async () => {
    const cases: [string, (l: string) => Promise<unknown>][] = [
      ['below', (l) => env.core.bus.append({ launchId: l, kind: 'sentinel.score', actor: 'sentinel', payload: report(10, 70) })],
      ['hardfail', (l) => env.core.bus.append({ launchId: l, kind: 'sentinel.score', actor: 'sentinel', payload: { ...report(99, 70, true), passed: false } })],
      ['lower-threshold', (l) => env.core.bus.append({ launchId: l, kind: 'sentinel.score', actor: 'sentinel', payload: report(20, 10) })],
      [
        'stale',
        async (l) => {
          await env.core.bus.append({ launchId: l, kind: 'sentinel.score', actor: 'sentinel', payload: report(90, 70) });
          await env.core.bus.append({ launchId: l, kind: 'forge.draft', actor: 'forge', payload: { name: 'Changed', ticker: 'CHG', lore: 'x', logoUri: 'u', logoHash: '1'.repeat(16), bannerUri: 'u', siteUri: 'u', metadataUri: URI } });
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      const launchId = await createLaunch(env.core, 'ring');
      await env.core.bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: { name: 'Frost', ticker: 'FRST', lore: 'x', logoUri: 'u', logoHash: '0'.repeat(16), bannerUri: 'u', siteUri: 'u', metadataUri: URI } });
      await arrange(launchId);
      const c = ctx(launchId);
      await expect(new Treasurer(c).deploy({ launcherWallet: 'w', sign: async () => 'never' }), name).rejects.toThrow();
      await expect(assertLaunchCleared(c), name).rejects.toThrow();
      const reqs = await env.core.bus.list(launchId, { kinds: ['approval.requested'] });
      expect(reqs, `${name}: no approval card for a blocked launch`).toHaveLength(0);
    }
  });

  it('launches can never be autopiloted: not a class, not auto-granted with every class on, not consumable even if forced into the table', async () => {
    const w = wallet();
    const launchId = await createLaunch(env.core, 'ring', 'C-12', null, w.address);
    await expect(env.core.approvals.setAutopilot(launchId, 'launch' as never, true, w.address)).rejects.toBeInstanceOf(ApprovalError);
    for (const cls of ['posts', 'replies', 'buybacks'] as const) await env.core.approvals.setAutopilot(launchId, cls, true, w.address);
    const { approvalId, autoGranted } = await env.core.approvals.open(launchId, 'launch', {}, 'treasurer');
    expect(autoGranted).toBe(false);
    await expect(env.core.approvals.consume(launchId, approvalId, 'launch')).rejects.toThrow(/pending/);
    // Force an autopilot grant into the table: the DB constraint refuses it.
    await expect(env.core.bus.pool.query("UPDATE approvals SET status='granted', via_autopilot=TRUE WHERE id=$1", [approvalId])).rejects.toThrow(/approvals_launch_never_autopilot/);
    // A non-launcher wallet cannot approve it.
    await expect(env.core.approvals.decide(approvalId, true, wallet().address)).rejects.toThrow(/only the launcher/);
  });

  // The molecule state (shown on /launch and /l/[ca]) trusts the threshold carried in the
  // sentinel.score payload instead of the launch's config row.
  it.fails('[AG-015] the molecule fold does not show "awaiting_approval" for a score computed against a lower threshold than the row', async () => {
    const launchId = await createLaunch(env.core, 'diamond');
    await env.core.bus.append({ launchId, kind: 'scout.proposals', actor: 'scout', payload: { narratives: [] } });
    await env.core.bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: { name: 'F', ticker: 'F', lore: 'x', logoUri: 'u', logoHash: '0'.repeat(16), bannerUri: 'u', siteUri: 'u' } });
    await env.core.bus.append({ launchId, kind: 'sentinel.score', actor: 'sentinel', payload: report(61, 60) }); // diamond needs 85
    const m = foldMolecule((await env.core.bus.list(launchId)) as CarbonEvent[]);
    expect(m.state).not.toBe('awaiting_approval');
  });
});
