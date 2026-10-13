/**
 * HERALD: drafts posts, asks for a one-tap approval, and only after a granted
 * (and consumed) approval calls x.post with that approvalId. Enforces the
 * shape's posting window (from launch.deployed) and postsPerHour (from the log,
 * so Ar-40 heavy Herald's doubled capacity applies here and nowhere else).
 */
import type { ArgonEvent } from '@argon/core';
import type { ApprovalCard } from '../cards.js';
import { type AgentContext, all, emit, emitError, latest, requestApproval, think } from '../context.js';
import { llmJson, obj, optStr, str } from '../json.js';
import { HERALD_ANNOUNCE_PROMPT, HERALD_LOOP_PROMPT, HERALD_SYSTEM, POST_SCHEMA, fill } from '../prompts/index.js';

export const MAX_POST = 280;
const HOUR = 3_600_000;

export type PostingCheck = { ok: true } | { ok: false; reason: string };

/** Posting window per shape, measured from launch.deployed. */
export async function postingWindow(ctx: AgentContext): Promise<PostingCheck> {
  const dep = await latest(ctx, 'launch.deployed');
  if (!dep) return { ok: false, reason: 'coin is not deployed yet' };
  const w = ctx.config.postingWindowMin;
  if (w === null) return { ok: true };
  const closesAt = dep.ts + w * 60_000;
  if (ctx.now() > closesAt) return { ok: false, reason: `posting window (${w} min after deploy) closed` };
  return { ok: true };
}

export async function publishedInLastHour(ctx: AgentContext, kind: 'post' | 'reply'): Promise<number> {
  const since = ctx.now() - HOUR;
  return (await all(ctx, 'post.published')).filter((e) => e.payload.kind === kind && e.ts > since).length;
}

export async function postRate(ctx: AgentContext): Promise<PostingCheck> {
  const n = await publishedInLastHour(ctx, 'post');
  if (n >= ctx.config.postsPerHour) return { ok: false, reason: `post limit reached (${n}/${ctx.config.postsPerHour} in the last hour)` };
  return { ok: true };
}

export function fitPost(text: string, mustInclude?: string): string {
  let t = text.replace(/\s+\n/g, '\n').trim();
  if (mustInclude && !t.includes(mustInclude)) {
    const suffix = `\nCA: ${mustInclude}`;
    t = t.slice(0, MAX_POST - suffix.length).trimEnd() + suffix;
  }
  if (t.length > MAX_POST) {
    if (mustInclude && t.includes(mustInclude)) {
      const rest = t.replace(mustInclude, '').replace(/\s+/g, ' ').trim();
      const room = MAX_POST - mustInclude.length - 1;
      t = `${rest.slice(0, room).trimEnd()} ${mustInclude}`;
    } else t = t.slice(0, MAX_POST);
  }
  return t;
}

export class Herald {
  constructor(private readonly ctx: AgentContext) {}

  /** Launch announcement with the CA. */
  async announce(): Promise<ArgonEvent<'post.published'> | null> {
    const ctx = this.ctx;
    const dep = await latest(ctx, 'launch.deployed');
    const draft = await latest(ctx, 'forge.draft');
    if (!dep || !draft) return this.refuse('coin is not deployed yet');
    if (!(await this.precheck())) return null;
    const res = await think(ctx, 'herald', {
      system: HERALD_SYSTEM,
      prompt: fill(HERALD_ANNOUNCE_PROMPT, {
        name: draft.payload.name,
        ticker: draft.payload.ticker,
        lore: draft.payload.lore,
        ca: dep.payload.ca,
        network: dep.payload.network,
      }),
      jsonSchema: POST_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.8,
    });
    const out = obj(llmJson(res), 'herald');
    const text = fitPost(str(out.text, 'text'), dep.payload.ca);
    const why = optStr(out.reasoning) ?? `Announcing $${draft.payload.ticker} with its CA.`;
    return this.publish(text, `Launch post for $${draft.payload.ticker}`, why);
  }

  /** RING loop post, grounded only in facts from the log that the caller passes. */
  async loopPost(facts: string[]): Promise<ArgonEvent<'post.published'> | null> {
    const ctx = this.ctx;
    const dep = await latest(ctx, 'launch.deployed');
    const draft = await latest(ctx, 'forge.draft');
    if (!dep || !draft) return this.refuse('coin is not deployed yet');
    if (!(await this.precheck())) return null;
    const res = await think(ctx, 'herald', {
      system: HERALD_SYSTEM,
      prompt: fill(HERALD_LOOP_PROMPT, {
        name: draft.payload.name,
        ticker: draft.payload.ticker,
        ca: dep.payload.ca,
        facts: facts.length ? facts.map((f) => `- ${f}`).join('\n') : '- (no new on-chain facts this loop)',
      }),
      jsonSchema: POST_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.8,
    });
    const out = obj(llmJson(res), 'herald');
    const text = fitPost(str(out.text, 'text'), dep.payload.ca);
    const why = optStr(out.reasoning) ?? `Loop update for $${draft.payload.ticker}.`;
    return this.publish(text, `Loop post for $${draft.payload.ticker}`, why);
  }

  /**
   * Publish a post Keeper drafted and the user already approved. `trigger` is
   * Keeper's hand-off; its refEventId is the approval.requested event.
   */
  async postApproved(trigger: ArgonEvent<'handoff'>): Promise<ArgonEvent<'post.published'> | null> {
    const ctx = this.ctx;
    const req = (await all(ctx, 'approval.requested')).find((e) => e.id === trigger.payload.refEventId);
    if (!req || req.payload.action !== 'post') return this.refuse('hand-off does not reference a post approval');
    const card = req.payload.draft as ApprovalCard;
    if (typeof card?.text !== 'string') return this.refuse('approval card has no post text');
    if (!(await this.precheck())) return null;
    return this.publish(card.text, card.title, `Posting the approved ${trigger.payload.topic} that Keeper drafted.`, req.payload.approvalId);
  }

  /** True when Herald may post now; otherwise emits the refusal and returns false. */
  private async precheck(): Promise<boolean> {
    const w = await postingWindow(this.ctx);
    if (!w.ok) return (await this.refuse(w.reason), false);
    const r = await postRate(this.ctx);
    if (!r.ok) return (await this.refuse(r.reason), false);
    return true;
  }

  private async refuse(reason: string): Promise<null> {
    await emitError(this.ctx, 'herald', `Herald refused to post: ${reason}`);
    return null;
  }

  private async publish(text: string, title: string, why: string, approvedId?: string): Promise<ArgonEvent<'post.published'> | null> {
    const ctx = this.ctx;
    let approvalId = approvedId;
    if (!approvalId) {
      const card: ApprovalCard = { title, agent: 'herald', summary: 'Post this from your connected X account?', text, details: { characters: String(text.length) } };
      const { decision } = await requestApproval(ctx, 'herald', 'post', card, `Drafted post for approval: ${why}`);
      if (!decision.granted) return null;
      approvalId = decision.approvalId;
    }
    // Time may have passed while the card waited: check again before anything irreversible.
    if (!(await this.precheck())) return null;
    await ctx.approvals.consume(ctx.launchId, approvalId, 'post');
    await ctx.budgets.spend(ctx.launchId, 'herald', 'post');
    const posted = await ctx.x.post(ctx.launchId, text, approvalId);
    return emit(ctx, 'herald', 'post.published', { postId: posted.id, url: posted.url, text, approvalId, kind: 'post' }, `Posted after approval ${approvalId.slice(0, 8)}: ${why}`);
  }
}
