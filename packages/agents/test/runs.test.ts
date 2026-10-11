import { SHAPES, launchConfig, pairKey } from '@carbon/core';
import { describe, expect, it } from 'vitest';
import { MoleculeRunner } from '../src/molecule-runner.js';
import { GROUNDED, created, expectReasoningForEveryAction, makeHarness, user } from './script.js';

function handoffsWithinTopology(h: ReturnType<typeof makeHarness>, shape: keyof typeof SHAPES) {
  for (const e of h.bus.ofKind('handoff')) {
    expect(SHAPES[shape].topology).toContain(pairKey(e.payload.from, e.payload.to));
  }
}

describe('CHAIN full run', () => {
  it('routes Scout→Forge→Sentinel→Herald with Treasurer off Sentinel and Keeper off Herald', async () => {
    const cfg = launchConfig('C-12', 'chain');
    const h = makeHarness(cfg);
    await created(h, cfg);
    h.x.mentionList = [];
    const out = await new MoleculeRunner(h.ctx, user).run();
    expect(out.status).toBe('deployed');

    const route = h.handoffs.sent.map((s) => `${s.from}>${s.to}:${s.topic}`);
    expect(route).toEqual([
      'scout>forge:narratives',
      'forge>sentinel:coin-draft',
      'sentinel>forge:cleared',
      'forge>sentinel:deploy-package',
      'sentinel>treasurer:score',
      'treasurer>sentinel:deployed',
      'sentinel>herald:launch-ready',
      'herald>keeper:announced',
      'keeper>herald:recruiting',
    ]);
    handoffsWithinTopology(h, 'chain');

    // Scout kept only sources it was handed (X) or grounding returned; invented narrative dropped.
    const proposals = h.bus.ofKind('scout.proposals')[0]!.payload.narratives;
    expect(proposals).toHaveLength(2);
    for (const n of proposals) for (const s of n.sources) expect(s.startsWith('https://x.com/i/web/status/') || s === GROUNDED).toBe(true);
    expect(proposals[1]!.names[0]!.ticker).toBe('GLAC');

    const score = h.bus.ofKind('sentinel.score')[0]!.payload;
    expect(score.passed).toBe(true);
    expect(score.threshold).toBe(60);

    // Metadata uploaded only after the score passed.
    const drafts = h.bus.ofKind('forge.draft');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.payload.metadataUri).toBeUndefined();
    expect(drafts[1]!.seq).toBeGreaterThan(h.bus.ofKind('sentinel.score')[0]!.seq);
    expect(drafts[1]!.payload.metadataUri).toBe('https://ipfs.io/ipfs/meta');
    expect(drafts[0]!.payload.logoHash).toMatch(/^[0-9a-f]{16}$/);

    // Launch: approval consumed before build; announcement carries CA; recruiting post went through Herald.
    expect(h.chain.built).toHaveLength(1);
    expect(h.approvals.isConsumed(h.chain.built[0]!.approvalId, 'launch')).toBe(true);
    const ca = h.bus.ofKind('launch.deployed')[0]!.payload.ca;
    expect(h.x.posts[0]!.text).toContain(ca);
    expect(h.x.posts).toHaveLength(2);
    expect(h.bus.ofKind('post.published').every((p) => p.actor === 'herald' && p.payload.kind === 'post')).toBe(true);

    // Budgets were spent before every LLM call.
    const llmSpends = h.budgets.calls.filter((c) => c.kind === 'llm').length;
    expect(llmSpends).toBe(h.llm.calls.length + h.llm.images.length);
    expect(h.budgets.calls.filter((c) => c.kind === 'post')).toHaveLength(2);

    // CHAIN tick: fee claim + split, no buyback (cap 0), no loop post.
    h.chain.pendingClaims.push({ claimId: 'c1', lamports: 1_000_000_000n, txSig: 'claimSig' });
    const t = await new MoleculeRunner(h.ctx, user).tick();
    expect(t.claimed).toBe(true);
    expect(t.buyback).toBeNull();
    expect(h.bus.ofKind('split.receipt')).toHaveLength(1);
    expect(h.chain.buys).toHaveLength(0);

    expectReasoningForEveryAction(h.bus);
  });
});

describe('RING full run', () => {
  it('deploys, then each loop claims, splits, buys back from the 30% leg, posts and lets Keeper reply', async () => {
    const cfg = launchConfig('C-13', 'ring', 'herald');
    const h = makeHarness(cfg);
    await created(h, cfg);
    const runner = new MoleculeRunner(h.ctx, user);
    const out = await runner.run();
    expect(out.status).toBe('deployed');
    expect(h.handoffs.sent.map((s) => `${s.from}>${s.to}`)).toContain('treasurer>herald');
    expect(h.handoffs.sent.map((s) => `${s.from}>${s.to}`)).not.toContain('treasurer>sentinel');

    const dep = h.bus.ofKind('launch.deployed')[0]!;
    h.clock.advance(cfg.loopMinutes! * 60_000);
    h.chain.pendingClaims.push({ claimId: 'c1', lamports: 1_000_000_000n, txSig: 'claimSig' });
    h.x.mentionList = [{ id: '900', text: 'love this coin', authorId: 'fan', createdAt: new Date(dep.ts + 1000).toISOString() }];
    const t1 = await runner.tick();
    expect(t1.claimed).toBe(true);
    expect(t1.posts).toHaveLength(1);
    expect(t1.replies).toHaveLength(1);
    expect(h.x.replies[0]!.inReplyTo).toBe('900');
    // buyback capped at buybackSolPerTick (0.01 SOL) and funded by the 30% leg (0.3 SOL).
    expect(t1.buyback!.payload.lamportsIn).toBe('10000000');
    expect(t1.buyback!.payload.splitId).toBe('split-c1');

    h.clock.advance(cfg.loopMinutes! * 60_000);
    h.bus.append({ launchId: 'L1', kind: 'holders.snapshot', actor: 'system', payload: { slot: 123, holderCount: 27 } });
    const t2 = await runner.tick();
    expect(t2.claimed).toBe(false);
    expect(t2.buyback!.payload.lamportsIn).toBe('10000000');
    expect(t2.posts.length).toBe(2); // loop post + milestone (25) drafted by Keeper, posted by Herald
    expect(t2.replies).toHaveLength(0); // same mention not answered twice
    const loopHandoffs = h.handoffs.sent.filter((s) => s.topic === 'loop');
    expect(loopHandoffs).toHaveLength(2);
    expect(h.handoffs.sent.some((s) => s.topic === 'milestone-25')).toBe(true);

    // Total bought never exceeds the 30% leg.
    const spent = h.chain.buys.reduce((s, b) => s + b.lamports, 0n);
    expect(spent).toBeLessThanOrEqual(300_000_000n);
    handoffsWithinTopology(h, 'ring');
    expectReasoningForEveryAction(h.bus);

    // Kill switch stops the autopilot loop (posts, replies, new buybacks) but not fee claims,
    // splits or their receipts (AG-008).
    await h.approvals.killSwitch('L1', 'wallet');
    h.clock.advance(cfg.loopMinutes! * 60_000);
    h.chain.pendingClaims.push({ claimId: 'c2', lamports: 1_000_000_000n, txSig: 'claimSig2' });
    const posts = h.x.posts.length;
    const buys = h.chain.buys.length;
    const t3 = await runner.tick();
    expect(t3.stopped).toMatch(/^kill switch engaged/);
    expect(t3.claimed).toBe(true);
    expect(h.bus.ofKind('split.receipt').some((r) => r.payload.claimId === 'c2')).toBe(true);
    expect(t3.posts).toHaveLength(0);
    expect(t3.replies).toHaveLength(0);
    expect(t3.buyback).toBeNull();
    expect(h.x.posts.length).toBe(posts);
    expect(h.chain.buys.length).toBe(buys);
  });
});

describe('DIAMOND', () => {
  it('gates every action behind an approval and stops when one is rejected', async () => {
    const cfg = launchConfig('C-12', 'diamond');
    const h = makeHarness(cfg);
    await created(h, cfg);
    const out = await new MoleculeRunner(h.ctx, user).run();
    expect(out.status).toBe('deployed');
    expect(h.bus.ofKind('sentinel.score')[0]!.payload.threshold).toBe(85);
    // research, draft, check, metadata upload, recruiting draft: each gated; launch/post have their own approvals.
    const actions = h.approvals.requests.filter((r) => r.action === 'action').map((r) => r.actor);
    expect(actions).toEqual(['scout', 'forge', 'sentinel', 'forge', 'keeper']);
    expect(h.approvals.requests.map((r) => r.action)).toContain('launch');
    // Diamond: autopilot never auto-grants.
    await h.approvals.setAutopilot('L1', 'posts', true);
    h.approvals.policy = (a) => a !== 'post';
    h.clock.advance(60_000);
    const before = h.x.posts.length;
    expect(await new MoleculeRunner(h.ctx, user).herald.loopPost([])).toBeNull();
    expect(h.x.posts.length).toBe(before);
    handoffsWithinTopology(h, 'diamond');
    expectReasoningForEveryAction(h.bus);

    const h2 = makeHarness(cfg);
    await created(h2, cfg);
    h2.approvals.policy = (action, _d, actor) => !(action === 'action' && actor === 'forge');
    const out2 = await new MoleculeRunner(h2.ctx, user).run();
    expect(out2.status).toBe('stopped');
    expect(h2.bus.ofKind('forge.draft')).toHaveLength(0);
    expectReasoningForEveryAction(h2.bus);
  });
});

describe('Sentinel block and revision', () => {
  it('blocks, lets the user revise, re-runs (run 2) and only then deploys', async () => {
    const cfg = launchConfig('C-12', 'chain');
    const h = makeHarness(cfg, { name: 'Elon Cat', ticker: 'ECAT' });
    await created(h, cfg);
    const revisions: number[] = [];
    const out = await new MoleculeRunner(h.ctx, {
      ...user,
      revise: async (report) => (revisions.push(report.run), { name: 'Glacier Cat', ticker: 'GCAT', note: 'remove the real person' }),
    }).run();
    expect(revisions).toEqual([1]);
    expect(out.status).toBe('deployed');
    const scores = h.bus.ofKind('sentinel.score').map((s) => [s.payload.run, s.payload.passed]);
    expect(scores).toEqual([[1, false], [2, true]]);
    expect(h.chain.uploads).toBe(1);
    expect(h.bus.ofKind('launch.deployed')).toHaveLength(1);
    expect(h.handoffs.sent.map((s) => s.topic)).toContain('revision');
    expectReasoningForEveryAction(h.bus);
  });

  it('without a revision the launch stays blocked and nothing is uploaded or built', async () => {
    const cfg = launchConfig('C-12', 'chain');
    const h = makeHarness(cfg, { name: 'Elon Cat', ticker: 'ECAT' });
    await created(h, cfg);
    const out = await new MoleculeRunner(h.ctx, user).run();
    expect(out.status).toBe('blocked');
    expect(h.chain.uploads).toBe(0);
    expect(h.chain.built).toHaveLength(0);
  });
});
