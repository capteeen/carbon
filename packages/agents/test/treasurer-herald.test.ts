import { type LaunchConfig, launchConfig } from '@carbon/core';
import { describe, expect, it } from 'vitest';
import { Forge } from '../src/forge/index.js';
import { Herald } from '../src/herald/index.js';
import { Keeper } from '../src/keeper/index.js';
import { MoleculeRunner } from '../src/molecule-runner.js';
import { Scout } from '../src/scout/index.js';
import { Sentinel, SentinelBlockError } from '../src/sentinel/index.js';
import { Treasurer } from '../src/treasurer/index.js';
import { created, expectReasoningForEveryAction, makeHarness, user } from './script.js';

async function scored(cfg: LaunchConfig, o: Parameters<typeof makeHarness>[1] = {}) {
  const h = makeHarness(cfg, o);
  const c = await created(h, cfg);
  const p = await new Scout(h.ctx).propose(c.payload.line);
  const narrative = p.payload.narratives[0]!;
  const forge = new Forge(h.ctx);
  const draft = await forge.draft(narrative, narrative.names[0]!);
  const score = await new Sentinel(h.ctx).score({ draft, narrative, launcherWallet: c.payload.launcherWallet });
  return { h, c, forge, draft, score, narrative };
}

const sign = user.signLaunchTx;

describe('Treasurer', () => {
  it('refuses to build a launch tx without a passing Sentinel score', async () => {
    const { h, c, forge, draft } = await scored(launchConfig('C-12', 'chain'), { name: 'Nude Cat', ticker: 'NCAT' });
    await forge.prepareDeploy(draft).catch(() => undefined);
    await expect(new Treasurer(h.ctx).deploy({ launcherWallet: c.payload.launcherWallet, sign })).rejects.toBeInstanceOf(SentinelBlockError);
    expect(h.chain.built).toHaveLength(0);
    expect(h.approvals.requests.some((r) => r.action === 'launch')).toBe(false);
  });

  it('refuses with no score at all', async () => {
    const cfg = launchConfig('C-12', 'chain');
    const h = makeHarness(cfg);
    await expect(new Treasurer(h.ctx).deploy({ launcherWallet: 'W', sign })).rejects.toThrow(/No Sentinel score/);
  });

  it('refuses without a granted launch approval', async () => {
    const { h, c, forge, draft } = await scored(launchConfig('C-12', 'chain'));
    await forge.prepareDeploy(draft);
    h.approvals.policy = (a) => a !== 'launch';
    expect(await new Treasurer(h.ctx).deploy({ launcherWallet: c.payload.launcherWallet, sign })).toBeNull();
    expect(h.chain.built).toHaveLength(0);
    expect(h.bus.ofKind('approval.rejected')).toHaveLength(1);
    expectReasoningForEveryAction(h.bus);
  });

  it('creates the launch wallet at most once per launch, reading it back from the log after a restart', async () => {
    const { h, c, forge, draft } = await scored(launchConfig('C-12', 'chain'));
    await forge.prepareDeploy(draft);
    h.approvals.policy = (a) => a !== 'launch';
    expect(await new Treasurer(h.ctx).deploy({ launcherWallet: c.payload.launcherWallet, sign })).toBeNull();
    h.approvals.policy = () => true;
    const dep = await new Treasurer(h.ctx).deploy({ launcherWallet: c.payload.launcherWallet, sign }); // fresh instance = restart
    expect(dep!.payload.creatorWallet).toBe('CreatorWa11et1111111111111111111111111111111');
    expect(await new Treasurer(h.ctx).launchWallet()).toBe(dep!.payload.creatorWallet);
    expect(h.chain.walletsCreated).toBe(1);
  });

  it('refuses when the draft changed after the score', async () => {
    const { h, c, forge, draft, narrative } = await scored(launchConfig('C-12', 'chain'));
    const changed = await forge.draft(narrative, narrative.names[0]!, { revision: { name: 'Other Cat', ticker: 'OCAT' }, previous: draft });
    await forge.prepareDeploy(changed);
    await expect(new Treasurer(h.ctx).deploy({ launcherWallet: c.payload.launcherWallet, sign })).rejects.toThrow(/Draft changed/);
    expect(h.chain.built).toHaveLength(0);
  });

  it('a resumed split never pays twice; buybacks only spend the 30% leg', async () => {
    const cfg = launchConfig('C-12', 'ring');
    const { h, c, forge, draft } = await scored(cfg);
    await forge.prepareDeploy(draft);
    const t = new Treasurer(h.ctx);
    expect(await t.deploy({ launcherWallet: c.payload.launcherWallet, sign })).not.toBeNull();

    // Crash after the claim event, before the split receipt.
    await h.bus.append({ launchId: 'L1', kind: 'fee.claimed', actor: 'treasurer', payload: { claimId: 'c9', lamports: '1000000000', txSig: 's' } });
    await t.resumeSplits();
    await t.resumeSplits();
    expect(h.chain.payouts).toHaveLength(3);
    expect(h.bus.ofKind('split.receipt')).toHaveLength(1);

    let total = 0n;
    for (let i = 0; i < 40; i++) {
      const b = await t.buyback();
      if (!b) break;
      total += BigInt(b.payload.lamportsIn);
      expect(BigInt(b.payload.lamportsIn)).toBeLessThanOrEqual(10_000_000n);
    }
    expect(total).toBe(300_000_000n);
    expect(await t.buyback()).toBeNull();
  });

  it('[AG-006/AG-005] the buyback receipt carries what the chain says the trade spent, once per buy', async () => {
    const cfg = launchConfig('C-12', 'ring');
    const { h, c, forge, draft } = await scored(cfg);
    await forge.prepareDeploy(draft);
    const t = new Treasurer(h.ctx);
    await t.deploy({ launcherWallet: c.payload.launcherWallet, sign });
    await h.bus.append({ launchId: 'L1', kind: 'fee.claimed', actor: 'treasurer', payload: { claimId: 'c7', lamports: '1000000000', txSig: 's' } });
    await t.resumeSplits();
    h.chain.buySpend = (r) => r - 75_000n; // slippage + fees left part of the max unspent
    const b = await t.buyback();
    expect(b!.payload.lamportsIn).toBe((10_000_000n - 75_000n).toString());
    // The unspent part stays in the leg for the next buy.
    expect((await t.buybackFunds())[0]!.remaining).toBe(300_000_000n - 10_000_000n + 75_000n);
    expect(new Set(h.bus.ofKind('buyback.executed').map((e) => e.payload.txSig)).size).toBe(h.bus.ofKind('buyback.executed').length);
  });

  it('[AG-007] claims in the chain ledger without a receipt (crash, or a third-party crank) get fee.claimed and a split receipt', async () => {
    const cfg = launchConfig('C-12', 'chain');
    const { h, c, forge, draft } = await scored(cfg);
    await forge.prepareDeploy(draft);
    const t = new Treasurer(h.ctx);
    await t.deploy({ launcherWallet: c.payload.launcherWallet, sign });
    let scans = 0;
    const ledger = [
      { claimId: 'crashed', lamports: 5n, txSig: 'sigA', origin: 'carbon' as const },
      { claimId: 'foreign_sigB', lamports: 7n, txSig: 'sigB', origin: 'foreign' as const },
    ];
    Object.assign(h.chain, { scanForeignDistributions: async () => (scans++, []), confirmedClaims: async () => ledger });
    await t.resumeSplits();
    await t.resumeSplits();
    expect(scans).toBe(2);
    const claimed = h.bus.ofKind('fee.claimed').map((e) => e.payload.claimId);
    expect(claimed.sort()).toEqual(['crashed', 'foreign_sigB']);
    for (const id of ['crashed', 'foreign_sigB']) expect(h.bus.ofKind('split.receipt').some((r) => r.payload.claimId === id)).toBe(true);
    expectReasoningForEveryAction(h.bus);
  });

  it('[AG-025] a C-14 clock starts at the create transaction block time, recorded in decay.started', async () => {
    const cfg = launchConfig('C-14', 'chain');
    const { h, c, forge, draft } = await scored(cfg);
    await forge.prepareDeploy(draft);
    const born = h.clock.now() - 42_000; // the block landed 42 s before the event is appended
    h.chain.bornAtMs = born;
    await new Treasurer(h.ctx).deploy({ launcherWallet: c.payload.launcherWallet, sign });
    const started = h.bus.ofKind('decay.started');
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toEqual({ rule: 'clock', collapseAt: born + 7 * 24 * 3600_000 });
  });
});

describe('Herald', () => {
  async function deployed(cfg: LaunchConfig) {
    const h = makeHarness(cfg);
    await created(h, cfg);
    const r = new MoleculeRunner(h.ctx, user);
    expect((await r.run()).status).toBe('deployed');
    return { h, herald: new Herald(h.ctx) };
  }

  it('refuses to post without an approval', async () => {
    const { h, herald } = await deployed(launchConfig('C-12', 'ring'));
    const n = h.x.posts.length;
    h.approvals.policy = () => false;
    expect(await herald.loopPost(['x'])).toBeNull();
    expect(h.x.posts.length).toBe(n);
    // And an approval id that was never granted cannot be consumed.
    await expect(h.approvals.consume('L1', 'appr-bogus', 'post')).rejects.toThrow();
  });

  it('refuses outside the CHAIN posting window', async () => {
    const cfg = launchConfig('C-12', 'chain');
    const { h, herald } = await deployed(cfg);
    const n = h.x.posts.length;
    const requests = h.approvals.requests.length;
    h.clock.advance((cfg.postingWindowMin! + 1) * 60_000);
    expect(await herald.loopPost(['x'])).toBeNull();
    expect(h.x.posts.length).toBe(n);
    expect(h.approvals.requests.length).toBe(requests); // no card for a post that can't go out
    expect(h.bus.ofKind('error').pop()!.payload.message).toMatch(/posting window/);
    // Keeper won't draft either.
    h.bus.append({ launchId: 'L1', kind: 'holders.snapshot', actor: 'system', payload: { slot: 1, holderCount: 100 } });
    expect(await new Keeper(h.ctx).milestones()).toBeNull();
    expectReasoningForEveryAction(h.bus);
  });

  it('Keeper mention cursor survives a restart (read from the log)', async () => {
    const { h } = await deployed(launchConfig('C-12', 'ring'));
    const dep = h.bus.ofKind('launch.deployed')[0]!;
    h.x.mentionList = [
      { id: '1000', text: 'gm', authorId: 'a', createdAt: new Date(dep.ts + 1).toISOString() },
      { id: '1001', text: 'nice', authorId: 'b', createdAt: new Date(dep.ts + 2).toISOString() },
    ];
    expect(await new Keeper(h.ctx).respond()).toHaveLength(2);
    const restarted = new Keeper(h.ctx);
    expect(await restarted.mentionCursor()).toBe('1001');
    expect(await restarted.respond()).toHaveLength(0);
    expect(h.x.replies.map((r) => r.inReplyTo)).toEqual(['1000', '1001']);
  });

  it('C-13 heavy Herald doubles only Herald post capacity', async () => {
    const base = launchConfig('C-13', 'ring', 'keeper');
    const heavy = launchConfig('C-13', 'ring', 'herald');
    expect(heavy.postsPerHour).toBe(2 * base.postsPerHour);
    expect(heavy.repliesPerHour).toBe(base.repliesPerHour / 2);
    expect(heavy.capacity.keeper).toEqual(launchConfig('C-12', 'ring').capacity.keeper);

    const count = async (cfg: LaunchConfig) => {
      const { h, herald } = await deployed(cfg);
      for (let i = 0; i < 30; i++) await herald.loopPost([`tick ${i}`]);
      return h.bus.ofKind('post.published').filter((p) => p.payload.kind === 'post').length;
    };
    const plain = await count(launchConfig('C-12', 'ring'));
    const doubled = await count(heavy);
    expect(plain).toBe(launchConfig('C-12', 'ring').postsPerHour);
    expect(doubled).toBe(2 * plain);
  });
});
