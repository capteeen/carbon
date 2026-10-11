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
