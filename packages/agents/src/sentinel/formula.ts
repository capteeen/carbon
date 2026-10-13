/**
 * THE public stability formula. Sentinel scores with exactly these functions
 * and /how renders exactly these tables (renderFormulaMarkdown). Pure: no I/O.
 */
import { SHAPES, SHAPE_IDS } from '@argon/core';
import type { SentinelInput, SentinelReport } from '@argon/core';
import { DENYLIST } from './denylist.js';

export type InputKey = SentinelInput['key'];

export const WEIGHTS: Record<InputKey, number> = {
  collision: 25,
  logo: 15,
  wallet: 15,
  sniper: 15,
  freshness: 10,
  content: 20,
};

export const INPUT_LABELS: Record<InputKey, string> = {
  collision: 'Name/ticker collision with live pump.fun coins',
  logo: 'Perceptual-hash logo match to existing coins',
  wallet: 'Launching wallet history',
  sniper: 'Bundle/sniper risk (dev buy vs bonding curve)',
  freshness: 'Narrative freshness (age of Scout sources)',
  content: 'Content rules (no real people, protected brands, sexual or violent content)',
};

export const SOURCE_UNAVAILABLE = 'source unavailable';

export function unavailable(key: InputKey, detail?: string): SentinelInput {
  return { key, points: 0, max: WEIGHTS[key], reason: detail ? `${SOURCE_UNAVAILABLE}: ${detail}` : SOURCE_UNAVAILABLE, hardFail: false };
}

// ─────────── collision ───────────

export interface CoinRef {
  mint: string;
  name: string;
  symbol: string;
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const COLLISION_TIERS = [
  { when: 'An existing coin has the same name AND the same ticker (impersonation)', points: 0, hardFail: true },
  { when: 'Existing coins share the exact name and (another) the exact ticker', points: 4, hardFail: false },
  { when: 'An existing coin has the exact ticker or the exact name', points: 8, hardFail: false },
  { when: 'An existing coin name/ticker contains ours or vice versa (≥4 chars)', points: 18, hardFail: false },
  { when: 'No collision', points: 25, hardFail: false },
] as const;

export function scoreCollision(name: string, ticker: string, coins: CoinRef[]): SentinelInput {
  const n = norm(name);
  const t = norm(ticker);
  const both = coins.find((c) => norm(c.name) === n && norm(c.symbol) === t);
  const tier = (i: number, reason: string): SentinelInput => ({
    key: 'collision',
    points: COLLISION_TIERS[i]!.points,
    max: WEIGHTS.collision,
    reason,
    hardFail: COLLISION_TIERS[i]!.hardFail,
  });
  if (both) return tier(0, `Impersonation: ${both.name} ($${both.symbol}) already exists at ${both.mint}`);
  const sameName = coins.find((c) => norm(c.name) === n);
  const sameTicker = coins.find((c) => norm(c.symbol) === t);
  if (sameName && sameTicker)
    return tier(1, `Name used by ${sameName.mint} and ticker $${sameTicker.symbol} used by ${sameTicker.mint}`);
  if (sameTicker) return tier(2, `Ticker $${sameTicker.symbol} already used by ${sameTicker.name} (${sameTicker.mint})`);
  if (sameName) return tier(2, `Name already used by ${sameName.name} ($${sameName.symbol}, ${sameName.mint})`);
  const contains = (a: string, b: string) => a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
  const partial = coins.find((c) => contains(norm(c.name), n) || contains(norm(c.symbol), t));
  if (partial) return tier(3, `Similar to ${partial.name} ($${partial.symbol}, ${partial.mint})`);
  return tier(4, `No live coin among ${coins.length} search results shares the name or ticker`);
}

// ─────────── logo ───────────

export const LOGO_TIERS = [
  { maxDistance: 4, points: 0, hardFail: true, when: 'dHash distance ≤ 4 of 64 bits: near-identical logo (impersonation)' },
  { maxDistance: 10, points: 5, hardFail: false, when: 'distance 5-10: very similar' },
  { maxDistance: 16, points: 10, hardFail: false, when: 'distance 11-16: somewhat similar' },
  { maxDistance: 64, points: 15, hardFail: false, when: 'distance > 16: distinct' },
] as const;

export function scoreLogo(result: { compared: number; failed: number; minDistance: number | null; closest?: CoinRef }): SentinelInput {
  if (result.compared === 0) {
    if (result.failed > 0) return unavailable('logo', `could not fetch or decode any of ${result.failed} existing coin images`);
    return { key: 'logo', points: WEIGHTS.logo, max: WEIGHTS.logo, reason: 'No existing coin matching the name or ticker has a logo to compare', hardFail: false };
  }
  const d = result.minDistance!;
  const tier = LOGO_TIERS.find((t) => d <= t.maxDistance)!;
  const who = result.closest ? ` (${result.closest.name}, ${result.closest.mint})` : '';
  const skipped = result.failed ? `; ${result.failed} images could not be read` : '';
  return {
    key: 'logo',
    points: tier.points,
    max: WEIGHTS.logo,
    reason: `${tier.hardFail ? 'Impersonation: ' : ''}closest of ${result.compared} logos is ${d}/64 bits away${who}${skipped}`,
    hardFail: tier.hardFail,
  };
}

// ─────────── wallet ───────────

const DAY = 86_400_000;
export const WALLET_RULES = {
  age: [
    { minDays: 30, points: 7 },
    { minDays: 7, points: 4 },
    { minDays: 1, points: 2 },
    { minDays: 0, points: 0 },
  ],
  txCount: [
    { min: 100, points: 4 },
    { min: 20, points: 3 },
    { min: 5, points: 1 },
    { min: 0, points: 0 },
  ],
  priorLaunches: [
    { max: 2, points: 4 },
    { max: 10, points: 2 },
    { max: Infinity, points: 0 },
  ],
} as const;

export function scoreWallet(h: { txCount: number; firstSeen: number | null; launches: number }, now: number): SentinelInput {
  const days = h.firstSeen === null ? 0 : Math.max(0, (now - h.firstSeen) / DAY);
  const a = WALLET_RULES.age.find((r) => days >= r.minDays)!.points;
  const t = WALLET_RULES.txCount.find((r) => h.txCount >= r.min)!.points;
  const l = WALLET_RULES.priorLaunches.find((r) => h.launches <= r.max)!.points;
  return {
    key: 'wallet',
    points: a + t + l,
    max: WEIGHTS.wallet,
    reason: `Wallet age ${h.firstSeen === null ? 'new (no history)' : `${Math.floor(days)}d`} (+${a}), ${h.txCount} txs (+${t}), ${h.launches} prior launches (+${l})`,
    hardFail: false,
  };
}

// ─────────── sniper / bundle ───────────

/**
 * pump.fun bonding-curve constants (initial global state as documented by
 * pump.fun's program): 30 virtual SOL, 1.073B virtual tokens, 1B total supply.
 * Proposal: ChainClient should expose the live Global account so these are read, not pinned.
 */
export const PUMP_CURVE = { virtualSol: 30, virtualTokens: 1_073_000_000, totalSupply: 1_000_000_000 } as const;

export function devBuySupplyPct(devBuySol: number): number {
  const { virtualSol, virtualTokens, totalSupply } = PUMP_CURVE;
  const out = virtualTokens - (virtualSol * virtualTokens) / (virtualSol + Math.max(0, devBuySol));
  return (out / totalSupply) * 100;
}

export const SNIPER_TIERS = [
  { maxPct: 1, points: 15 },
  { maxPct: 2, points: 13 },
  { maxPct: 4, points: 9 },
  { maxPct: 8, points: 4 },
  { maxPct: Infinity, points: 0 },
] as const;

export function scoreSniper(devBuySol: number): SentinelInput {
  const pct = devBuySupplyPct(devBuySol);
  const tier = SNIPER_TIERS.find((t) => pct <= t.maxPct)!;
  return {
    key: 'sniper',
    points: tier.points,
    max: WEIGHTS.sniper,
    reason: `Dev buy ${devBuySol} SOL takes ${pct.toFixed(2)}% of supply on the curve; single create+buy tx from one wallet, no bundle`,
    hardFail: false,
  };
}

// ─────────── freshness ───────────

export const FRESHNESS_TIERS = [
  { maxHours: 24, points: 10 },
  { maxHours: 72, points: 7 },
  { maxHours: 168, points: 4 },
  { maxHours: Infinity, points: 1 },
] as const;

export function scoreFreshness(sourceTimes: number[], undated: number, now: number): SentinelInput {
  if (!sourceTimes.length) return unavailable('freshness', `no dated sources (${undated} undated web sources)`);
  const ages = sourceTimes.map((t) => Math.max(0, (now - t) / 3_600_000)).sort((a, b) => a - b);
  const mid = Math.floor(ages.length / 2);
  const median = ages.length % 2 ? ages[mid]! : (ages[mid - 1]! + ages[mid]!) / 2;
  const tier = FRESHNESS_TIERS.find((t) => median <= t.maxHours)!;
  return {
    key: 'freshness',
    points: tier.points,
    max: WEIGHTS.freshness,
    reason: `Median age of ${ages.length} dated sources is ${median.toFixed(1)}h${undated ? ` (${undated} undated not counted)` : ''}`,
    hardFail: false,
  };
}

// ─────────── content ───────────

export interface ContentFinding {
  rule: 'real_person' | 'protected_brand' | 'sexual' | 'violent';
  evidence: string;
  by: 'denylist' | 'classifier' | 'image-classifier';
}

export function scoreContent(findings: ContentFinding[], classifier: { ok: true } | { ok: false; error: string }): SentinelInput {
  if (findings.length) {
    const f = findings.slice(0, 3).map((x) => `${x.rule} (${x.by}: ${x.evidence})`).join('; ');
    return { key: 'content', points: 0, max: WEIGHTS.content, reason: `Content rule violation: ${f}`, hardFail: true };
  }
  // Content rules are never assumed clean: if the classifier cannot run, the launch is blocked.
  if (!classifier.ok)
    return { ...unavailable('content', `content check could not run (classifier: ${classifier.error}); denylist clean`), hardFail: true };
  return { key: 'content', points: WEIGHTS.content, max: WEIGHTS.content, reason: 'Denylist, text classifier and image classifier found no rule violations', hardFail: false };
}

// ─────────── total ───────────

export function finalize(inputs: SentinelInput[], threshold: number, run: number): SentinelReport {
  const score = Math.max(0, Math.min(100, inputs.reduce((s, i) => s + i.points, 0)));
  const hardFail = inputs.some((i) => i.hardFail);
  return { score, threshold, inputs, hardFail, passed: score >= threshold && !hardFail, run };
}

// ─────────── /how ───────────

export function renderFormulaMarkdown(): string {
  const lines: string[] = [];
  lines.push('## Stability score (Sentinel)', '');
  lines.push('Score is 0-100: the sum of six inputs. A launch stays locked until the score reaches the shape\'s threshold. Content-rule and impersonation failures are hard fails: they block regardless of score. A content check that could not run is also a hard fail. If a data source cannot be reached, that input scores 0 with the reason "source unavailable"; Sentinel never guesses.', '');
  lines.push('| Input | Max points |', '|---|---|');
  for (const k of Object.keys(WEIGHTS) as InputKey[]) lines.push(`| ${INPUT_LABELS[k]} | ${WEIGHTS[k]} |`);
  lines.push('', '### Thresholds by shape', '', '| Shape | Threshold |', '|---|---|');
  for (const s of SHAPE_IDS) lines.push(`| ${SHAPES[s].label} | ${SHAPES[s].sentinelThreshold} |`);
  lines.push('', '### Collision', '', '| Condition | Points | Hard fail |', '|---|---|---|');
  for (const t of COLLISION_TIERS) lines.push(`| ${t.when} | ${t.points} | ${t.hardFail ? 'yes' : 'no'} |`);
  lines.push('', '### Logo (64-bit difference hash, Hamming distance to the closest coin returned by the name/ticker search)', '', '| Condition | Points | Hard fail |', '|---|---|---|');
  for (const t of LOGO_TIERS) lines.push(`| ${t.when} | ${t.points} | ${t.hardFail ? 'yes' : 'no'} |`);
  lines.push('No coin with a comparable logo: full points. Coins found but no image readable: 0, source unavailable.');
  lines.push('', '### Launching wallet', '');
  lines.push(`Age: ${WALLET_RULES.age.map((r) => `≥${r.minDays}d → ${r.points}`).join(', ')}.`);
  lines.push(`Transactions: ${WALLET_RULES.txCount.map((r) => `≥${r.min} → ${r.points}`).join(', ')}.`);
  lines.push(`Prior launches: ${WALLET_RULES.priorLaunches.map((r) => `≤${r.max === Infinity ? '∞' : r.max} → ${r.points}`).join(', ')}.`);
  lines.push('', '### Bundle/sniper risk', '');
  lines.push(`Share of supply the dev buy takes on the pump.fun curve (${PUMP_CURVE.virtualSol} virtual SOL, ${PUMP_CURVE.virtualTokens.toLocaleString('en-US')} virtual tokens, ${PUMP_CURVE.totalSupply.toLocaleString('en-US')} supply): ${SNIPER_TIERS.map((t) => `≤${t.maxPct === Infinity ? '∞' : t.maxPct}% → ${t.points}`).join(', ')}.`);
  lines.push('', '### Narrative freshness', '');
  lines.push(`Median age of the dated sources Scout cited (X post time): ${FRESHNESS_TIERS.map((t) => `≤${t.maxHours === Infinity ? '∞' : t.maxHours}h → ${t.points}`).join(', ')}. No dated source: 0, source unavailable.`);
  lines.push('', '### Content rules', '');
  lines.push('A deterministic denylist and an LLM classifier check the name, ticker, lore and the text of the generated coin site for real people, protected brands, sexual and violent content. The LLM also looks at the generated logo and banner images (vision) against the same rules. Any finding is a hard fail. Clean: 20. A classifier that cannot run (text or image, including images that cannot be read or a model without vision): 0, "source unavailable: content check could not run", and the launch is blocked (hard fail) until it runs.');
  lines.push('', 'A score is bound to the draft it checked: it records that draft\'s event id and a sha256 of its content (name, ticker, lore, logo hash, banner and site URIs, which are content-addressed). The launch is refused unless the draft being deployed has exactly that content.');
  lines.push('', `Denylist (whole-word, case-insensitive): ${Object.entries(DENYLIST).map(([k, v]) => `**${k}**: ${v.join(', ')}`).join('; ')}.`);
  return lines.join('\n');
}
