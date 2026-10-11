/**
 * SCOUT: live trends on X (+ Gemini search grounding) → 3-5 narratives with
 * names, tickers, a "why" and the sources it actually used. Any source the
 * model cites that we did not hand it (X) or that grounding did not return
 * (web) is dropped; a narrative with no surviving source is dropped.
 */
import type { CarbonEvent, XPost } from '@carbon/core';
import { type AgentContext, clip, emit, emitError, errMsg, gate, think } from '../context.js';
import { arr, llmJson, normalizeName, normalizeTicker, obj, optStr, str } from '../json.js';
import { SCOUT_PROMPT, SCOUT_SCHEMA, SCOUT_SYSTEM, fill } from '../prompts/index.js';

export interface Narrative {
  title: string;
  names: { name: string; ticker: string }[];
  why: string;
  sources: string[];
}

export function xPostUrl(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

/** X status id from an x.com / twitter.com status URL, or null. */
export function xStatusId(url: string): string | null {
  const m = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:[^/]+|i\/web)\/status\/(\d{5,25})/.exec(url);
  return m ? m[1]! : null;
}

/** Search query from the user's line: its words, no retweets. */
export function buildQuery(line: string): string {
  const words = line
    .toLowerCase()
    .replace(/[^a-z0-9$#@\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);
  const core = words.length ? words.join(' OR ') : line.trim();
  return `(${core}) -is:retweet`;
}

export class Scout {
  constructor(private readonly ctx: AgentContext) {}

  async propose(line: string): Promise<CarbonEvent<'scout.proposals'>> {
    const ctx = this.ctx;
    await gate(ctx, 'scout', 'research live narratives on X and the web', { line });

    let posts: XPost[] = [];
    let xOk = true;
    let xStatus: string;
    try {
      posts = await ctx.x.searchRecent(buildQuery(line), { max: 50 });
      xStatus = `X recent search returned ${posts.length} posts.`;
    } catch (e) {
      xOk = false;
      xStatus = `X unavailable (${errMsg(e)}). Use only grounded web sources.`;
    }
    let trends: { name: string; volume?: number }[] = [];
    if (xOk && ctx.x.trends) {
      try {
        trends = await ctx.x.trends();
      } catch {
        trends = [];
      }
    }

    const byUrl = new Map(posts.map((p) => [xPostUrl(p.id), p]));
    const byId = new Map(posts.map((p) => [p.id, xPostUrl(p.id)]));
    const res = await think(ctx, 'scout', {
      system: SCOUT_SYSTEM,
      prompt: fill(SCOUT_PROMPT, {
        line,
        xStatus,
        posts: posts.length
          ? posts.map((p) => `${p.id} · ${p.createdAt} · ${xPostUrl(p.id)} · ${p.text.replace(/\s+/g, ' ').slice(0, 280)}`).join('\n')
          : '(none)',
        trends: trends.length ? trends.map((t) => t.name).join(', ') : '(none)',
      }),
      jsonSchema: SCOUT_SCHEMA as unknown as Record<string, unknown>,
      grounding: true,
      temperature: 0.8,
    });

    const allowed = new Set<string>([...byUrl.keys(), ...res.sources]);
    const out = obj(llmJson(res), 'scout');
    let dropped = 0;
    const narratives: Narrative[] = [];
    for (const raw of arr(out.narratives, 'narratives')) {
      try {
        const n = obj(raw, 'narrative');
        const sources = [
          ...new Set(
            arr(n.sources, 'sources')
              .filter((s): s is string => typeof s === 'string')
              .map((s) => s.trim())
              .map((s) => (allowed.has(s) ? s : byId.get(s) ?? (xStatusId(s) ? byId.get(xStatusId(s)!) : undefined) ?? ''))
              .filter((s) => s && allowed.has(s)),
          ),
        ];
        const names = arr(n.names, 'names')
          .map((x) => obj(x, 'name'))
          .map((x) => ({ name: normalizeName(str(x.name, 'name')), ticker: normalizeTicker(str(x.ticker, 'ticker')) }))
          .filter((x) => x.name && x.ticker.length >= 2);
        if (!sources.length || !names.length) {
          dropped++;
          continue;
        }
        narratives.push({ title: clip(str(n.title, 'title'), 80), names: names.slice(0, 3), why: clip(str(n.why, 'why'), 280), sources });
      } catch {
        dropped++;
      }
      if (narratives.length === 5) break;
    }

    const prefix = xOk ? '' : 'X unavailable; grounded web sources only. ';
    const dropNote = dropped ? ` Dropped ${dropped} narrative(s) without a verifiable source.` : '';
    if (!narratives.length) {
      await emitError(ctx, 'scout', `${prefix}No narrative had a verifiable source; nothing proposed.${dropNote}`);
      throw new Error('scout: no sourced narratives');
    }
    const cited = new Set(narratives.flatMap((n) => n.sources)).size;
    const llmReason = optStr(out.reasoning) ?? `Proposed ${narratives.length} narratives citing ${cited} sources.`;
    return emit(ctx, 'scout', 'scout.proposals', { narratives }, `${prefix}${llmReason}${dropNote}`);
  }
}
