/**
 * Orchestrator. Runs one launch end-to-end per shape. Every inter-agent
 * hand-off goes through handoffs.send (via `handoff()`), so bonds come from
 * real traffic; an agent only acts on a hand-off it received.
 *
 * CHAIN    Scout→Forge→Sentinel→Herald; Treasurer off Sentinel; Keeper off Herald.
 * RING     the same path around the ring, then a timed loop every loopMinutes:
 *          Treasurer claim/split/buyback → Herald loop post → Keeper between.
 * DIAMOND  the CHAIN path with every agent action gated by an approval.
 */
import type { AgentId, CarbonEvent, SentinelReport } from '@carbon/core';
import { type AgentContext, AgentRefusal, bondAllowed, emitError, errMsg, handoff, killSwitchEngaged, latest } from './context.js';
import { Forge, type Revision } from './forge/index.js';
import { Herald } from './herald/index.js';
import { Keeper } from './keeper/index.js';
import { Scout } from './scout/index.js';
import { Sentinel } from './sentinel/index.js';
import { lamportsToSol, type SignLaunchTx, Treasurer } from './treasurer/index.js';

/** The launcher's choices, answered by the web app (the user taps). */
export interface LaunchUser {
  chooseNarrative(proposals: CarbonEvent<'scout.proposals'>): Promise<{ narrative: number; name: number }>;
  signLaunchTx: SignLaunchTx;
  /** Called when Sentinel blocks. Return a revision to re-draft and re-run, or null to stop. */
  revise?(report: SentinelReport, draft: CarbonEvent<'forge.draft'>): Promise<Revision | null>;
}

export type LaunchOutcome =
  | { status: 'deployed'; deployed: CarbonEvent<'launch.deployed'>; announcement: CarbonEvent<'post.published'> | null }
  | { status: 'blocked'; score: CarbonEvent<'sentinel.score'> }
  | { status: 'not-approved' }
  | { status: 'stopped'; reason: string };

export interface TickResult {
  claimed: boolean;
  buyback: CarbonEvent<'buyback.executed'> | null;
  posts: CarbonEvent<'post.published'>[];
  replies: CarbonEvent<'post.published'>[];
  stopped?: string;
}

export interface RunnerOptions {
  maxRevisions?: number;
  /** Fee-claim schedule for shapes without a RING loop. */
  claimEveryMinutes?: number;
}

export class MoleculeRunner {
  readonly scout: Scout;
  readonly forge: Forge;
  readonly sentinel: Sentinel;
  readonly herald: Herald;
  readonly keeper: Keeper;
  readonly treasurer: Treasurer;
  private ticking = false;

  constructor(
    private readonly ctx: AgentContext,
    private readonly user: LaunchUser,
    private readonly opts: RunnerOptions = {},
  ) {
    this.scout = new Scout(ctx);
    this.forge = new Forge(ctx);
    this.sentinel = new Sentinel(ctx);
    this.herald = new Herald(ctx);
    this.keeper = new Keeper(ctx);
    this.treasurer = new Treasurer(ctx);
  }

  /** Scout → … → deploy → announcement. */
  async run(): Promise<LaunchOutcome> {
    try {
      return await this.runInner();
    } catch (e) {
      if (e instanceof AgentRefusal) {
        await emitError(this.ctx, e.agent, e.message);
        return { status: 'stopped', reason: e.message };
      }
      throw e;
    }
  }

  private async runInner(): Promise<LaunchOutcome> {
    const ctx = this.ctx;
    const created = await latest(ctx, 'launch.created');
    if (!created) throw new Error(`launch ${ctx.launchId} has no launch.created event`);
    const { line, launcherWallet } = created.payload;

    // SCOUT → FORGE
    const proposals = await this.scout.propose(line);
    await handoff(ctx, 'scout', 'forge', 'narratives', `${proposals.payload.narratives.length} sourced narratives for Forge.`, proposals.id);
    const choice = await this.user.chooseNarrative(proposals);
    const narrative = proposals.payload.narratives[choice.narrative];
    const pick = narrative?.names[choice.name];
    if (!narrative || !pick) throw new Error('chosen narrative/name out of range');

    // FORGE → SENTINEL (with revisions)
    let draft = await this.forge.draft(narrative, pick);
    await handoff(ctx, 'forge', 'sentinel', 'coin-draft', `Draft ${draft.payload.name} ($${draft.payload.ticker}) for the stability check.`, draft.id);
    let score: CarbonEvent<'sentinel.score'>;
    let revisions = 0;
    for (;;) {
      score = await this.sentinel.score({ draft, narrative, launcherWallet });
      if (score.payload.passed) break;
      const rev = revisions < (this.opts.maxRevisions ?? 3) && this.user.revise ? await this.user.revise(score.payload, draft) : null;
      if (!rev) return { status: 'blocked', score };
      revisions++;
      await handoff(ctx, 'sentinel', 'forge', 'revision', `Blocked at ${score.payload.score}/${score.payload.threshold}; user asked for a revision.`, score.id);
      draft = await this.forge.draft(narrative, pick, { revision: rev, previous: draft });
      await handoff(ctx, 'forge', 'sentinel', 'coin-draft', `Revised draft ${draft.payload.name} ($${draft.payload.ticker}) for re-check.`, draft.id);
    }

    // SENTINEL clears → FORGE uploads metadata → SENTINEL → TREASURER
    await handoff(ctx, 'sentinel', 'forge', 'cleared', `Passed ${score.payload.score}/${score.payload.threshold}; prepare the deploy.`, score.id);
    const ready = await this.forge.prepareDeploy(draft);
    await handoff(ctx, 'forge', 'sentinel', 'deploy-package', `Metadata uploaded for $${ready.payload.ticker}.`, ready.id);
    await handoff(ctx, 'sentinel', 'treasurer', 'score', `Cleared to launch at ${score.payload.score}/${score.payload.threshold}.`, score.id);

    const deployed = await this.treasurer.deploy({ launcherWallet, sign: this.user.signLaunchTx });
    if (!deployed) return { status: 'not-approved' };

    // TREASURER → HERALD (direct on RING/DIAMOND, via SENTINEL on CHAIN)
    const summary = `Deployed at ${deployed.payload.ca}; announce it.`;
    if (bondAllowed(ctx.config, 'treasurer', 'herald')) {
      await handoff(ctx, 'treasurer', 'herald', 'launch-ready', summary, deployed.id);
    } else {
      await handoff(ctx, 'treasurer', 'sentinel', 'deployed', `Deployed at ${deployed.payload.ca}.`, deployed.id);
      await handoff(ctx, 'sentinel', 'herald', 'launch-ready', summary, deployed.id);
    }
    const announcement = await this.herald.announce();
    if (announcement) {
      await handoff(ctx, 'herald', 'keeper', 'announced', 'Launch post is live; watch the replies.', announcement.id);
      await this.keeperDraft(this.keeper.recruit());
    }
    return { status: 'deployed', deployed, announcement };
  }

  /** Keeper's approved drafts reach Herald only through the hand-off it sends. */
  private async keeperDraft(p: Promise<{ handoff: CarbonEvent<'handoff'> | null } | null>): Promise<CarbonEvent<'post.published'> | null> {
    const r = await p;
    if (!r?.handoff) return null;
    return this.herald.postApproved(r.handoff);
  }

  private async step<T>(agent: AgentId, f: () => Promise<T>): Promise<T | null> {
    try {
      return await f();
    } catch (e) {
      await emitError(this.ctx, agent, errMsg(e));
      return null;
    }
  }

  /** One scheduled tick. RING: the full loop; other shapes: fee claim + Keeper. */
  async tick(): Promise<TickResult> {
    const ctx = this.ctx;
    const result: TickResult = { claimed: false, buyback: null, posts: [], replies: [] };
    if (this.ticking) return { ...result, stopped: 'previous tick still running' };
    if (!(await latest(ctx, 'launch.deployed'))) return { ...result, stopped: 'not deployed' };
    this.ticking = true;
    try {
      // Money owed to people and its public receipts run regardless of the kill switch:
      // the switch turns autopilot (posts, replies, buybacks) off, not fee claims,
      // splits or receipts for money that already moved (AG-008).
      await this.step('treasurer', () => this.treasurer.resumeSplits());
      const claim = await this.step('treasurer', () => this.treasurer.claimAndSplit());
      result.claimed = !!claim;
      if (await killSwitchEngaged(ctx)) {
        result.buyback = (await this.step('treasurer', () => this.treasurer.resumeBuyback())) ?? null;
        return { ...result, stopped: 'kill switch engaged: posts, replies and new buybacks stopped; fee claims, splits and receipts still run' };
      }
      result.buyback = (await this.step('treasurer', () => this.treasurer.buyback())) ?? null;

      if (ctx.config.loopMinutes !== null) {
        const facts: string[] = [];
        if (claim) {
          facts.push(`Claimed ${lamportsToSol(BigInt(claim.claim.payload.lamports))} SOL creator fees (tx ${claim.claim.payload.txSig}).`);
          facts.push('Split 50% launcher / 30% $CARBON buyback / 20% Carbon treasury, receipt public.');
        }
        if (result.buyback) facts.push(`Bought $CARBON with ${lamportsToSol(BigInt(result.buyback.payload.lamportsIn))} SOL (tx ${result.buyback.payload.txSig}).`);
        const snap = await latest(ctx, 'holders.snapshot');
        if (snap) facts.push(`${snap.payload.holderCount} holders at slot ${snap.payload.slot}.`);
        const ref = result.buyback?.id ?? claim?.receipt.id ?? (await latest(ctx, 'launch.deployed'))!.id;
        await handoff(ctx, 'treasurer', 'herald', 'loop', claim ? 'Fees claimed and split this loop; post the update.' : 'No new fees this loop; post the update.', ref);
        const post = await this.step('herald', () => this.herald.loopPost(facts));
        if (post) {
          result.posts.push(post);
          await handoff(ctx, 'herald', 'keeper', 'loop-posted', 'Loop post is live; respond between loops.', post.id);
        }
      }
      result.replies = (await this.step('keeper', () => this.keeper.respond())) ?? [];
      const ms = await this.step('keeper', () => this.keeperDraft(this.keeper.milestones()));
      if (ms) result.posts.push(ms);
      return result;
    } finally {
      this.ticking = false;
    }
  }

  /** Starts the schedule (RING loop or fee-claim schedule). Returns a stop function. */
  start(): () => void {
    const minutes = this.ctx.config.loopMinutes ?? this.opts.claimEveryMinutes ?? 60;
    const t = setInterval(() => {
      void this.tick().catch((e) => emitError(this.ctx, 'treasurer', `tick failed: ${errMsg(e)}`).catch(() => undefined));
    }, minutes * 60_000);
    return () => clearInterval(t);
  }
}
