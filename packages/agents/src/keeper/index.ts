/**
 * KEEPER: reads mentions and drafts replies (each needs an approval, or the
 * 'replies' autopilot), drafts holder-milestone and recruiting posts. Keeper
 * never posts top-level posts itself: an approved draft is handed to Herald
 * through handoffs.send with the approval.requested event as its reference.
 */
import type { CarbonEvent, XPost } from '@carbon/core';
import type { ApprovalCard } from '../cards.js';
import { type AgentContext, all, emit, emitError, errMsg, gate, handoff, latest, requestApproval, think } from '../context.js';
import { MAX_POST, fitPost, postRate, postingWindow, publishedInLastHour } from '../herald/index.js';
import { llmJson, obj, optStr, str } from '../json.js';
import {
  KEEPER_MILESTONE_PROMPT,
  KEEPER_RECRUIT_PROMPT,
  KEEPER_REPLY_PROMPT,
  KEEPER_REPLY_SCHEMA,
  KEEPER_SYSTEM,
  POST_SCHEMA,
  fill,
} from '../prompts/index.js';

export const HOLDER_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

export interface KeeperDraftResult {
  /** The hand-off to Herald (ref = approval.requested), when the user approved. */
  handoff: CarbonEvent<'handoff'> | null;
}

export class Keeper {
  private sinceId: string | undefined;

  constructor(private readonly ctx: AgentContext) {}

  /** Reply to new mentions since deploy. Returns the published replies. */
  async respond(): Promise<CarbonEvent<'post.published'>[]> {
    const ctx = this.ctx;
    const dep = await latest(ctx, 'launch.deployed');
    const draft = await latest(ctx, 'forge.draft');
    if (!dep || !draft) return [];
    await gate(ctx, 'keeper', 'read mentions and draft replies', { ca: dep.payload.ca });
    let mentions: XPost[];
    try {
      mentions = await ctx.x.mentions(ctx.launchId, this.sinceId);
    } catch (e) {
      await emitError(ctx, 'keeper', `Could not read mentions: ${errMsg(e)}`);
      return [];
    }
    const fresh = mentions
      .filter((m) => Date.parse(m.createdAt) >= dep.ts && (this.sinceId === undefined || BigInt(m.id) > BigInt(this.sinceId)))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const out: CarbonEvent<'post.published'>[] = [];
    for (const m of fresh) {
      this.sinceId = m.id;
      const used = await publishedInLastHour(ctx, 'reply');
      if (used >= ctx.config.repliesPerHour) {
        await emitError(ctx, 'keeper', `Reply limit reached (${used}/${ctx.config.repliesPerHour} in the last hour); ${fresh.length - out.length} mentions wait`);
        break;
      }
      const res = await think(ctx, 'keeper', {
        system: KEEPER_SYSTEM,
        prompt: fill(KEEPER_REPLY_PROMPT, {
          name: draft.payload.name,
          ticker: draft.payload.ticker,
          ca: dep.payload.ca,
          author: m.authorId,
          text: m.text.replace(/\s+/g, ' ').slice(0, 500),
        }),
        jsonSchema: KEEPER_REPLY_SCHEMA as unknown as Record<string, unknown>,
        temperature: 0.7,
      });
      const o = obj(llmJson(res), 'keeper');
      const reply = optStr(o.reply);
      const why = optStr(o.reasoning) ?? (reply ? `Drafted a reply to mention ${m.id}.` : `Skipped mention ${m.id}.`);
      if (!reply) continue; // skipped by the model; no action, no event
      const text = reply.slice(0, MAX_POST);
      const card: ApprovalCard = {
        title: `Reply to mention ${m.id}`,
        agent: 'keeper',
        summary: 'Reply from your connected X account?',
        text,
        details: { inReplyTo: m.id, mention: m.text.slice(0, 280) },
      };
      const { decision } = await requestApproval(ctx, 'keeper', 'reply', card, why);
      if (!decision.granted) continue;
      await ctx.approvals.consume(ctx.launchId, decision.approvalId, 'reply');
      await ctx.budgets.spend(ctx.launchId, 'keeper', 'reply');
      const r = await ctx.x.reply(ctx.launchId, m.id, text, decision.approvalId);
      out.push(
        await emit(ctx, 'keeper', 'post.published', { postId: r.id, url: r.url, text, approvalId: decision.approvalId, kind: 'reply' }, `Replied to ${m.id} after approval: ${why}`),
      );
    }
    return out;
  }

  /** If the latest holder snapshot crossed a milestone nobody has drafted yet, draft a post and hand it to Herald once approved. */
  async milestones(): Promise<KeeperDraftResult | null> {
    const ctx = this.ctx;
    const snap = await latest(ctx, 'holders.snapshot');
    if (!snap) return null;
    const reached = HOLDER_MILESTONES.filter((m) => snap.payload.holderCount >= m).pop();
    if (reached === undefined) return null;
    const done = (await all(ctx, 'handoff')).some((h) => h.payload.from === 'keeper' && h.payload.topic === `milestone-${reached}`);
    const asked = (await all(ctx, 'approval.requested')).some(
      (a) => a.actor === 'keeper' && (a.payload.draft as ApprovalCard | null)?.details?.milestone === String(reached),
    );
    if (done || asked) return null;
    return this.draftPost(`milestone-${reached}`, KEEPER_MILESTONE_PROMPT, { holders: String(snap.payload.holderCount), milestone: String(reached) }, {
      milestone: String(reached),
      snapshotEvent: snap.id,
    });
  }

  /** One recruiting post per launch. */
  async recruit(): Promise<KeeperDraftResult | null> {
    const asked = (await all(this.ctx, 'approval.requested')).some(
      (a) => a.actor === 'keeper' && (a.payload.draft as ApprovalCard | null)?.details?.kind === 'recruiting',
    );
    if (asked) return null;
    const draft = await latest(this.ctx, 'forge.draft');
    return this.draftPost('recruiting', KEEPER_RECRUIT_PROMPT, { lore: draft?.payload.lore ?? '' }, { kind: 'recruiting' });
  }

  private async draftPost(topic: string, prompt: string, vars: Record<string, string>, details: Record<string, string>): Promise<KeeperDraftResult | null> {
    const ctx = this.ctx;
    const dep = await latest(ctx, 'launch.deployed');
    const draft = await latest(ctx, 'forge.draft');
    if (!dep || !draft) return null;
    // Don't ask the user to approve something Herald will refuse.
    const w = await postingWindow(ctx);
    const r = await postRate(ctx);
    if (!w.ok || !r.ok) return null;
    await gate(ctx, 'keeper', `draft a ${topic} post`, details);
    const res = await think(ctx, 'keeper', {
      system: KEEPER_SYSTEM,
      prompt: fill(prompt, { name: draft.payload.name, ticker: draft.payload.ticker, ca: dep.payload.ca, ...vars }),
      jsonSchema: POST_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.8,
    });
    const o = obj(llmJson(res), 'keeper');
    const text = fitPost(str(o.text, 'text'), dep.payload.ca);
    const why = optStr(o.reasoning) ?? `Drafted a ${topic} post.`;
    const card: ApprovalCard = { title: `${topic} post`, agent: 'keeper', summary: 'Post this from your connected X account?', text, details: { ...details } };
    const { decision, requestEvent } = await requestApproval(ctx, 'keeper', 'post', card, why);
    if (!decision.granted || !requestEvent) return { handoff: null };
    const h = await handoff(ctx, 'keeper', 'herald', topic, `Approved ${topic} post ready for Herald to publish.`, requestEvent.id);
    return { handoff: h };
  }
}
