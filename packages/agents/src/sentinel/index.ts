/**
 * SENTINEL: computes the stability score from exactly the inputs in
 * formula.ts, emits sentinel.score, and can BLOCK: assertLaunchCleared() is
 * what Treasurer calls before it will build a launch transaction.
 *
 * A score is bound to the draft it checked (AG-035): sentinel.score carries that
 * draft's event id and a sha256 of its content, and the gate compares against them.
 * The content rules cover the name, ticker, lore, the generated site's text and the
 * generated logo and banner images (vision through the LLM provider).
 */
import { createHash } from 'node:crypto';
import { canonicalJson, hasVision, type ArgonEvent, type EventPayloads, type PumpCoinInfo, type SentinelInput, type SentinelReport } from '@argon/core';
import { type AgentContext, AgentRefusal, all, emit, errMsg, gate, think } from '../context.js';
import { hamming, hashImageBytes } from '../image/phash.js';
import { arr, llmJson, obj, optStr, str } from '../json.js';
import { defaultFetchBytes } from '../net.js';
import { SENTINEL_CONTENT_PROMPT, SENTINEL_CONTENT_SCHEMA, SENTINEL_CONTENT_SYSTEM, SENTINEL_IMAGE_PROMPT, SENTINEL_IMAGE_SYSTEM, fill } from '../prompts/index.js';
import { xStatusId } from '../scout/index.js';
import type { Narrative } from '../scout/index.js';
import { checkDenylist } from './denylist.js';
import {
  type CoinRef,
  type ContentFinding,
  finalize,
  scoreCollision,
  scoreContent,
  scoreFreshness,
  scoreLogo,
  scoreSniper,
  scoreWallet,
  unavailable,
} from './formula.js';

/** X ids are snowflakes: ms timestamp = (id >> 22) + Twitter epoch. Exact, no lookup needed. */
export function xSnowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + 1288834974657n);
}

const RULES = new Set(['real_person', 'protected_brand', 'sexual', 'violent']);

/**
 * What a score binds to (AG-035). Local extension of SentinelReport; proposed for
 * contracts.ts as optional fields of the sentinel.score payload.
 */
export interface ScoreBinding {
  /** Event id of the forge.draft that was scored. */
  draftEventId: string;
  /** draftContentHash() of that draft. */
  contentHash: string;
}
export type BoundSentinelReport = SentinelReport & ScoreBinding;

/**
 * sha256 over the content that was checked: name, ticker, lore, the logo's hash and the
 * banner and site URIs (content-addressed by the asset store). logoUri and metadataUri are
 * left out: Forge re-points logoUri at the IPFS copy of the same bytes (logoHash binds them)
 * and adds metadataUri when it uploads the cleared draft.
 */
export function draftContentHash(d: EventPayloads['forge.draft']): string {
  const content = { name: d.name, ticker: d.ticker, lore: d.lore, logoHash: d.logoHash, bannerUri: d.bannerUri, siteUri: d.siteUri };
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export function scoreBinding(draft: ArgonEvent<'forge.draft'>): ScoreBinding {
  return { draftEventId: draft.id, contentHash: draftContentHash(draft.payload) };
}

/** Visible text of the generated coin site (its <main>; the footer is the fixed Argon disclaimer). */
export function siteText(html: string): string {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html.replace(/<head[\s\S]*?<\/head>|<footer[\s\S]*?<\/footer>|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  const alts = [...main.matchAll(/\balt="([^"]*)"/gi)].map((m) => m[1]!);
  return [main.replace(/<[^>]+>/g, ' '), ...alts]
    .join(' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Sentinel {
  constructor(private readonly ctx: AgentContext) {}

  async score(args: { draft: ArgonEvent<'forge.draft'>; narrative: Narrative; launcherWallet: string }): Promise<ArgonEvent<'sentinel.score'>> {
    const ctx = this.ctx;
    const d = args.draft.payload;
    await gate(ctx, 'sentinel', 'run the stability check', { name: d.name, ticker: d.ticker });
    const run = (await all(ctx, 'sentinel.score')).length + 1;

    const [coinsResult, wallet, content] = await Promise.all([
      this.searchCoins(d.name, d.ticker),
      ctx.chain.walletHistory(args.launcherWallet).then(
        (h) => scoreWallet(h, ctx.now()),
        (e) => unavailable('wallet', errMsg(e)),
      ),
      this.content(d),
    ]);

    let collision: SentinelInput;
    let logo: SentinelInput;
    if (!coinsResult.ok) {
      collision = unavailable('collision', coinsResult.error);
      logo = unavailable('logo', coinsResult.error);
    } else {
      collision = scoreCollision(d.name, d.ticker, coinsResult.coins);
      logo = scoreLogo(await this.compareLogos(d.logoHash, coinsResult.coins));
    }
    const sniper = scoreSniper(ctx.config.devBuySol);

    const times: number[] = [];
    let undated = 0;
    for (const s of args.narrative.sources) {
      const id = xStatusId(s);
      if (id) times.push(xSnowflakeTime(id));
      else undated++;
    }
    const freshness = scoreFreshness(times, undated, ctx.now());

    const report: BoundSentinelReport = { ...finalize([collision, logo, wallet, sniper, freshness, content], ctx.config.sentinelThreshold, run), ...scoreBinding(args.draft) };
    const failing = report.inputs.filter((i) => i.hardFail).map((i) => i.key);
    const verdict = report.passed
      ? `PASS ${report.score}/${report.threshold}`
      : report.hardFail
        ? `BLOCK: hard fail on ${failing.join(', ')} (score ${report.score})`
        : `BLOCK: ${report.score} below threshold ${report.threshold}`;
    const weakest = [...report.inputs].sort((a, b) => a.points / a.max - b.points / b.max)[0]!;
    return emit(ctx, 'sentinel', 'sentinel.score', report, `Run ${run}: ${verdict}. Weakest: ${weakest.key} ${weakest.points}/${weakest.max} — ${weakest.reason}`);
  }

  private async searchCoins(name: string, ticker: string): Promise<{ ok: true; coins: PumpCoinInfo[] } | { ok: false; error: string }> {
    try {
      const [a, b] = await Promise.all([this.ctx.chain.searchCoins(name), this.ctx.chain.searchCoins(ticker)]);
      const seen = new Map<string, PumpCoinInfo>();
      for (const c of [...a, ...b]) seen.set(c.mint, c);
      return { ok: true, coins: [...seen.values()] };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  private async compareLogos(ours: string, coins: PumpCoinInfo[]) {
    const fetchBytes = this.ctx.fetchBytes ?? defaultFetchBytes;
    let compared = 0;
    let failed = 0;
    let minDistance: number | null = null;
    let closest: CoinRef | undefined;
    await Promise.all(
      coins
        .filter((c) => c.imageUri)
        .slice(0, 40)
        .map(async (c) => {
          try {
            const { bytes } = await fetchBytes(c.imageUri!);
            const dist = hamming(ours, hashImageBytes(bytes));
            compared++;
            if (minDistance === null || dist < minDistance) {
              minDistance = dist;
              closest = { mint: c.mint, name: c.name, symbol: c.symbol };
            }
          } catch {
            failed++;
          }
        }),
    );
    return { compared, failed, minDistance, closest };
  }

  /** Draft assets: from the asset store when it can read its own URIs, else a size-limited fetch. */
  private async readAsset(uri: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const fromStore = this.ctx.assets.read ? await this.ctx.assets.read(uri) : null;
    if (fromStore) return fromStore;
    return (this.ctx.fetchBytes ?? defaultFetchBytes)(uri);
  }

  /**
   * Content rules over everything the coin will show: the name, ticker and lore, the
   * site's text (denylist + text classifier), and the logo and banner images (image
   * classifier). Any part that cannot run is a hard fail, never assumed clean.
   */
  private async content(d: EventPayloads['forge.draft']): Promise<SentinelInput> {
    const { name, ticker, lore } = d;
    const findings: ContentFinding[] = checkDenylist({ name, ticker, lore });
    const failures: string[] = [];
    let site = '';
    try {
      site = siteText(new TextDecoder().decode((await this.readAsset(d.siteUri)).bytes));
      findings.push(...checkDenylist({ site }));
    } catch (e) {
      failures.push(`site text unreadable: ${errMsg(e)}`);
    }
    const [text, images] = await Promise.all([this.classifyText(name, ticker, lore, site), this.classifyImages(d)]);
    for (const r of [text, images]) {
      if (r.ok) findings.push(...r.findings);
      else failures.push(r.error);
    }
    return scoreContent(findings, failures.length ? { ok: false, error: failures.join('; ') } : { ok: true });
  }

  private async classifyText(name: string, ticker: string, lore: string, site: string): Promise<{ ok: true; findings: ContentFinding[] } | { ok: false; error: string }> {
    try {
      const res = await think(this.ctx, 'sentinel', {
        system: SENTINEL_CONTENT_SYSTEM,
        prompt: fill(SENTINEL_CONTENT_PROMPT, { name, ticker, lore, site: site || '(none)' }),
        jsonSchema: SENTINEL_CONTENT_SCHEMA as unknown as Record<string, unknown>,
        temperature: 0,
      });
      return { ok: true, findings: violations(res, 'classifier') };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  /** The generated logo and banner, checked by the LLM's vision input against the same rules. */
  private async classifyImages(d: EventPayloads['forge.draft']): Promise<{ ok: true; findings: ContentFinding[] } | { ok: false; error: string }> {
    const ctx = this.ctx;
    try {
      if (!hasVision(ctx.llm)) throw new Error(`LLM provider ${ctx.llm.id} has no image input`);
      const [logo, banner] = await Promise.all([this.readAsset(d.logoUri), this.readAsset(d.bannerUri)]);
      // The logo classified must be the logo the draft (and the logo-similarity check) refers to.
      if (hashImageBytes(logo.bytes) !== d.logoHash) throw new Error('logo bytes do not match the draft logoHash');
      await ctx.budgets.spend(ctx.launchId, 'sentinel', 'llm');
      const res = await ctx.llm.generateWithImages(
        {
          system: SENTINEL_IMAGE_SYSTEM,
          prompt: fill(SENTINEL_IMAGE_PROMPT, { name: d.name, ticker: d.ticker }),
          jsonSchema: SENTINEL_CONTENT_SCHEMA as unknown as Record<string, unknown>,
          temperature: 0,
        },
        [logo, banner],
      );
      return { ok: true, findings: violations(res, 'image-classifier') };
    } catch (e) {
      return { ok: false, error: `image check: ${errMsg(e)}` };
    }
  }
}

function violations(res: Parameters<typeof llmJson>[0], by: ContentFinding['by']): ContentFinding[] {
  const out = obj(llmJson(res), 'classifier');
  return arr(out.violations, 'violations').map((v) => {
    const o = obj(v, 'violation');
    const rule = str(o.rule, 'rule');
    if (!RULES.has(rule)) throw new Error(`classifier returned unknown rule ${rule}`);
    return { rule: rule as ContentFinding['rule'], evidence: optStr(o.evidence) ?? '(no evidence given)', by };
  });
}

export class SentinelBlockError extends AgentRefusal {
  constructor(message: string) {
    super('sentinel', message);
    this.name = 'SentinelBlockError';
  }
}

/**
 * The block. Throws unless the latest sentinel.score passed, names the draft it scored
 * (by event id, before the score, with the recorded content hash) AND every forge.draft
 * since the scored one carries exactly that content (AG-001, AG-035).
 * Returns the latest draft (the one to deploy) and the score.
 */
export async function assertLaunchCleared(ctx: AgentContext): Promise<{ score: ArgonEvent<'sentinel.score'>; draft: ArgonEvent<'forge.draft'> }> {
  const scores = await all(ctx, 'sentinel.score');
  const score = scores[scores.length - 1];
  if (!score) throw new SentinelBlockError('No Sentinel score yet; launch locked');
  if (!score.payload.passed) {
    throw new SentinelBlockError(
      score.payload.hardFail ? 'Latest Sentinel score has a hard fail; launch blocked' : `Latest Sentinel score ${score.payload.score} is below ${score.payload.threshold}; launch locked`,
    );
  }
  if (score.payload.threshold < ctx.config.sentinelThreshold) throw new SentinelBlockError('Score was computed against a lower threshold than this launch requires');
  const binding = score.payload as Partial<ScoreBinding>;
  if (typeof binding.draftEventId !== 'string' || typeof binding.contentHash !== 'string') {
    throw new SentinelBlockError('Sentinel score does not name the draft it checked; re-run Sentinel');
  }
  const drafts = await all(ctx, 'forge.draft');
  const scored = drafts.find((d) => d.id === binding.draftEventId);
  if (!scored || scored.seq > score.seq) throw new SentinelBlockError('The draft the Sentinel score names is not in this launch before the score');
  if (draftContentHash(scored.payload) !== binding.contentHash) throw new SentinelBlockError('Sentinel score content hash does not match the draft it names');
  // Every draft since the scored one (including any appended while Sentinel was running) must match.
  const after = drafts.filter((d) => d.seq > scored.seq);
  if (after.some((d) => draftContentHash(d.payload) !== binding.contentHash)) throw new SentinelBlockError('Draft changed after the Sentinel score; re-run Sentinel');
  return { score, draft: after.length ? after[after.length - 1]! : scored };
}
