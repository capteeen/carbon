/**
 * SENTINEL: computes the stability score from exactly the inputs in
 * formula.ts, emits sentinel.score, and can BLOCK: assertLaunchCleared() is
 * what Treasurer calls before it will build a launch transaction.
 */
import type { CarbonEvent, PumpCoinInfo, SentinelInput } from '@carbon/core';
import { type AgentContext, AgentRefusal, all, emit, errMsg, gate, think } from '../context.js';
import { hamming, hashImageBytes } from '../image/phash.js';
import { arr, llmJson, obj, optStr, str } from '../json.js';
import { defaultFetchBytes } from '../net.js';
import { SENTINEL_CONTENT_PROMPT, SENTINEL_CONTENT_SCHEMA, SENTINEL_CONTENT_SYSTEM, fill } from '../prompts/index.js';
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

export class Sentinel {
  constructor(private readonly ctx: AgentContext) {}

  async score(args: { draft: CarbonEvent<'forge.draft'>; narrative: Narrative; launcherWallet: string }): Promise<CarbonEvent<'sentinel.score'>> {
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
      this.content(d.name, d.ticker, d.lore),
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

    const report = finalize([collision, logo, wallet, sniper, freshness, content], ctx.config.sentinelThreshold, run);
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

  private async content(name: string, ticker: string, lore: string): Promise<SentinelInput> {
    const findings: ContentFinding[] = checkDenylist({ name, ticker, lore });
    let classifier: { ok: true } | { ok: false; error: string } = { ok: true };
    try {
      const res = await think(this.ctx, 'sentinel', {
        system: SENTINEL_CONTENT_SYSTEM,
        prompt: fill(SENTINEL_CONTENT_PROMPT, { name, ticker, lore }),
        jsonSchema: SENTINEL_CONTENT_SCHEMA as unknown as Record<string, unknown>,
        temperature: 0,
      });
      const out = obj(llmJson(res), 'classifier');
      for (const v of arr(out.violations, 'violations')) {
        const o = obj(v, 'violation');
        const rule = str(o.rule, 'rule');
        if (!RULES.has(rule)) throw new Error(`classifier returned unknown rule ${rule}`);
        findings.push({ rule: rule as ContentFinding['rule'], evidence: optStr(o.evidence) ?? '(no evidence given)', by: 'classifier' });
      }
    } catch (e) {
      classifier = { ok: false, error: errMsg(e) };
    }
    return scoreContent(findings, classifier);
  }
}

export class SentinelBlockError extends AgentRefusal {
  constructor(message: string) {
    super('sentinel', message);
    this.name = 'SentinelBlockError';
  }
}

const sameContent = (a: CarbonEvent<'forge.draft'>, b: CarbonEvent<'forge.draft'>) =>
  a.payload.name === b.payload.name && a.payload.ticker === b.payload.ticker && a.payload.lore === b.payload.lore && a.payload.logoHash === b.payload.logoHash;

/**
 * The block. Throws unless the latest sentinel.score passed AND every
 * forge.draft since that score carries exactly the content that was scored.
 * Returns the latest draft (the one to deploy) and the score.
 */
export async function assertLaunchCleared(ctx: AgentContext): Promise<{ score: CarbonEvent<'sentinel.score'>; draft: CarbonEvent<'forge.draft'> }> {
  const scores = await all(ctx, 'sentinel.score');
  const score = scores[scores.length - 1];
  if (!score) throw new SentinelBlockError('No Sentinel score yet; launch locked');
  if (!score.payload.passed) {
    throw new SentinelBlockError(
      score.payload.hardFail ? 'Latest Sentinel score has a hard fail; launch blocked' : `Latest Sentinel score ${score.payload.score} is below ${score.payload.threshold}; launch locked`,
    );
  }
  if (score.payload.threshold < ctx.config.sentinelThreshold) throw new SentinelBlockError('Score was computed against a lower threshold than this launch requires');
  const drafts = await all(ctx, 'forge.draft');
  const scored = drafts.filter((d) => d.seq < score.seq).pop();
  if (!scored) throw new SentinelBlockError('No draft precedes the Sentinel score');
  const after = drafts.filter((d) => d.seq > score.seq);
  if (after.some((d) => !sameContent(d, scored))) throw new SentinelBlockError('Draft changed after the Sentinel score; re-run Sentinel');
  return { score, draft: after.length ? after[after.length - 1]! : scored };
}
