/**
 * Carbon shared contracts. Every package builds against these types.
 * Written by the integrator; change only with the integrator's review.
 *
 * Nothing in here is data: it is shapes and the ONE launch config table
 * (SPEC §1: "Budget, posting cadence, Sentinel threshold and decay clock for
 * each live in ONE config table, rendered on /how").
 */

// ───────────────────────────── protons ─────────────────────────────

/** The six protons, in the canonical order (SPEC §5 ch.03). */
export const AGENT_IDS = ['scout', 'forge', 'herald', 'keeper', 'treasurer', 'sentinel'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Every proton has valence 4: at most 4 bond orders held at once. Never configurable. */
export const VALENCE = 4 as const;

export const AGENT_ROLES: Record<AgentId, string> = {
  scout: 'Finds live trends on X, proposes 3-5 narratives and names',
  forge: 'Creates the coin: name, ticker, lore, logo, banner, site; prepares the pump.fun deploy',
  herald: "Drafts posts and, after approval, posts from the user's connected X account",
  keeper: 'Community: replies, holder milestones, recruiting drafts',
  treasurer: 'Per-launch fee address, fee claims, the 50/30/20 split, $CARBON buybacks, public receipts',
  sentinel: 'Risk checks; computes the stability score; can BLOCK a launch',
};

/**
 * What each agent does, in plain language, for the click-a-proton detail panel
 * and /how. Describes the code in packages/agents; keep the two in step.
 */
export interface AgentDetail {
  /** What it does in a launch, in order. */
  does: string[];
  /** What it reads. */
  inputs: string[];
  /** What it produces and who receives it. */
  outputs: string[];
  /** Where your approval is required. */
  approval: string;
  /** Limits it can never cross. */
  never: string[];
}

export const AGENT_DETAILS: Record<AgentId, AgentDetail> = {
  scout: {
    does: [
      'Reads live trends on X, plus Gemini search grounding for the wider web.',
      'Proposes 3-5 narratives, each with a name, a ticker, why it could work and the sources it used.',
      'Drops any source it was not actually given, and any narrative left with no source.',
    ],
    inputs: ['Live X trends and posts', 'Gemini search grounding results'],
    outputs: ['Narratives with names, tickers and cited sources, handed to Forge'],
    approval: 'You choose which narrative goes ahead. Scout publishes nothing.',
    never: ['Invents sources', 'Posts or trades'],
  },
  forge: {
    does: [
      'Turns the chosen narrative into a coin: name, ticker, lore, logo, banner and a one-page site.',
      'Hands the draft to Sentinel for checks.',
      'Only after Sentinel clears it, uploads the metadata to pump.fun IPFS and prepares the deploy.',
    ],
    inputs: ["Scout's chosen narrative"],
    outputs: ['The coin draft (text, images, site, logo fingerprint) for Sentinel', 'The metadata URI the launch transaction uses'],
    approval: 'Nothing goes live until you approve the launch.',
    never: ['Publishes content that failed the content rules'],
  },
  herald: {
    does: [
      'Drafts posts about the launch.',
      "Posts from your connected X account only after your one-tap approval (or the 'posts' autopilot you turned on).",
      "Publishes Keeper's approved milestone and recruiting posts.",
    ],
    inputs: ['The deployed launch', "Keeper's approved drafts"],
    outputs: ['Posts on your X account, each logged with its approval'],
    approval: 'Every post needs your approval unless you turned on posts autopilot. Never on DIAMOND.',
    never: ['Posts outside the shape’s posting window or above its posts per hour', 'Creates accounts'],
  },
  keeper: {
    does: [
      'Reads mentions of the coin and drafts replies.',
      'Drafts holder-milestone and recruiting posts.',
      'Hands approved top-level posts to Herald rather than posting them itself.',
    ],
    inputs: ['Mentions on X', 'Holder counts'],
    outputs: ['Replies on your X account', 'Milestone and recruiting drafts for Herald'],
    approval: "Every reply needs your approval unless you turned on the 'replies' autopilot.",
    never: ['Replies above the shape’s replies per hour'],
  },
  treasurer: {
    does: [
      "Sets up the launch's fee address with pump.fun native fee sharing: 50% to you, 30% to $CARBON buybacks, 20% to the treasury.",
      'Builds and sends the launch transaction, including your dev buy, once you approve and Sentinel passes it.',
      'Claims fees on a schedule and publishes a receipt for every split.',
      'Buys back $CARBON using only the 30% share.',
    ],
    inputs: ['Your launch approval', "Sentinel's passing score", 'Claimed creator fees'],
    outputs: ['The launch transaction', 'Fee-split receipts', '$CARBON buyback receipts'],
    approval: 'The launch always needs your approval. Autopilot is never available for launches.',
    never: ['Trades anything except $CARBON buybacks and the launch’s own dev buy', 'Moves money without a receipt'],
  },
  sentinel: {
    does: [
      'Scores the draft 0-100 for stability from six public inputs: name and ticker collisions, logo similarity, the launching wallet, bundle and sniper risk, narrative freshness and content rules.',
      "Blocks the launch until the score reaches the shape's threshold.",
      'Hard-fails content-rule breaks and impersonation, whatever the score.',
    ],
    inputs: ["Forge's draft (text, logo, banner, site)", 'Public chain and pump.fun data', "Scout's sources"],
    outputs: ['A stability score bound to the exact draft it checked', 'A block, when the launch is not safe'],
    approval: 'Sentinel can stop a launch you approved. It cannot start one.',
    never: ['Guesses: an input it cannot measure scores 0'],
  },
};

/** HUD label, e.g. PROTON_01_SCOUT. */
export function protonLabel(agent: AgentId): string {
  const i = AGENT_IDS.indexOf(agent) + 1;
  return `PROTON_${String(i).padStart(2, '0')}_${agent.toUpperCase()}`;
}

// ───────────────────────────── isotopes / shapes ─────────────────────────────

export const ISOTOPE_IDS = ['C-11', 'C-12', 'C-13', 'C-14'] as const;
export type IsotopeId = (typeof ISOTOPE_IDS)[number];

export const SHAPE_IDS = ['chain', 'ring', 'diamond'] as const;
export type ShapeId = (typeof SHAPE_IDS)[number];

export type DecayRule =
  /** Stable isotope: never decays. */
  | { kind: 'none' }
  /** C-11: collapses once `quietSec` pass with no trades on the coin. */
  | { kind: 'quiet'; quietSec: number }
  /** C-14: collapses at bornAt + `clockSec`, a fixed visible countdown (trades do not reset it). */
  | { kind: 'clock'; clockSec: number };

export interface IsotopeSpec {
  id: IsotopeId;
  label: string; // HUD label, e.g. ISOTOPE_C14
  neutrons: 5 | 6 | 7 | 8;
  name: 'FLASH' | 'CORE' | 'HEAVY' | 'RADIOACTIVE';
  stable: boolean;
  behaviour: string;
  /** Multiplies the shape's base budgets. */
  budgetMultiplier: number;
  decay: DecayRule;
  /** C-13 only: the user picks one agent whose capacity doubles. */
  heavyAgent: boolean;
  /** Story copy about the real isotope. Never implies the coin lasts that long. */
  realWorldNote: string;
}

export const ISOTOPES: Record<IsotopeId, IsotopeSpec> = {
  'C-11': {
    id: 'C-11',
    label: 'ISOTOPE_C11',
    neutrons: 5,
    name: 'FLASH',
    stable: false,
    behaviour: 'Small budget, fast meme. Decays to a daughter after 20 min with no trades.',
    budgetMultiplier: 0.5,
    decay: { kind: 'quiet', quietSec: 20 * 60 },
    heavyAgent: false,
    realWorldNote: 'Real carbon-11 has a half-life of about 20.4 minutes.',
  },
  'C-12': {
    id: 'C-12',
    label: 'ISOTOPE_C12',
    neutrons: 6,
    name: 'CORE',
    stable: true,
    behaviour: 'Balanced and stable. The default.',
    budgetMultiplier: 1,
    decay: { kind: 'none' },
    heavyAgent: false,
    realWorldNote: 'Carbon-12 is stable and makes up about 99% of natural carbon.',
  },
  'C-13': {
    id: 'C-13',
    label: 'ISOTOPE_C13',
    neutrons: 7,
    name: 'HEAVY',
    stable: true,
    behaviour: 'Stable. The extra neutron doubles the capacity of one agent you choose.',
    budgetMultiplier: 1,
    decay: { kind: 'none' },
    heavyAgent: true,
    realWorldNote: 'Carbon-13 is stable and makes up about 1% of natural carbon.',
  },
  'C-14': {
    id: 'C-14',
    label: 'ISOTOPE_C14',
    neutrons: 8,
    name: 'RADIOACTIVE',
    stable: false,
    behaviour: 'Built-in decay to a daughter on a long, visible 7-day clock.',
    budgetMultiplier: 1,
    decay: { kind: 'clock', clockSec: 7 * 24 * 60 * 60 },
    heavyAgent: false,
    realWorldNote:
      'Real carbon-14 has a half-life of about 5,730 years. That is the story, not the coin: a C-14 coin decays after 7 days.',
  },
};

/** Undirected pair key, agents sorted by AGENT_IDS order: "scout|forge". */
export type PairKey = `${AgentId}|${AgentId}`;

export interface ShapeSpec {
  id: ShapeId;
  label: string; // SHAPE_CHAIN
  description: string;
  sentinelThreshold: number;
  /** Which agent pairs may hand off to each other in this shape. */
  topology: PairKey[];
  /** Every agent action (not just launches and posts) needs a user approval. */
  gateEveryAction: boolean;
  /** Base budgets before the isotope multiplier. */
  base: {
    /** SOL the launcher's wallet spends on the launch's own dev buy. */
    devBuySol: number;
    /** Max SOL per Treasurer $CARBON buyback (funded only by the 30% fee share). */
    buybackSolPerTick: number;
    /** Max LLM calls per agent per hour (capacity). Heavy agent gets 2x. */
    llmCallsPerAgentHour: number;
    /** Max X posts Herald may publish per hour. Heavy Herald gets 2x. */
    postsPerHour: number;
    /** Max X replies Keeper may publish per hour. Heavy Keeper gets 2x. */
    repliesPerHour: number;
  };
  /** Minutes after deploy during which Herald may post. null = no window limit. */
  postingWindowMin: number | null;
  /** RING timed loop period (Herald posts + Treasurer buyback). null = no loop. */
  loopMinutes: number | null;
}

function pair(a: AgentId, b: AgentId): PairKey {
  return (AGENT_IDS.indexOf(a) <= AGENT_IDS.indexOf(b) ? `${a}|${b}` : `${b}|${a}`) as PairKey;
}
export { pair as pairKey };

const ALL_PAIRS: PairKey[] = AGENT_IDS.flatMap((a, i) => AGENT_IDS.slice(i + 1).map((b) => pair(a, b)));

export const SHAPES: Record<ShapeId, ShapeSpec> = {
  chain: {
    id: 'chain',
    label: 'SHAPE_CHAIN',
    description:
      'Linear Scout→Forge→Sentinel→Herald, with Treasurer on Sentinel and Keeper on Herald. Short posting window.',
    sentinelThreshold: 60,
    topology: [
      pair('scout', 'forge'),
      pair('forge', 'sentinel'),
      pair('sentinel', 'herald'),
      pair('sentinel', 'treasurer'),
      pair('herald', 'keeper'),
    ],
    gateEveryAction: false,
    base: { devBuySol: 0.1, buybackSolPerTick: 0, llmCallsPerAgentHour: 20, postsPerHour: 2, repliesPerHour: 6 },
    postingWindowMin: 120,
    loopMinutes: null,
  },
  ring: {
    id: 'ring',
    label: 'SHAPE_RING',
    description:
      'Benzene ring of all six. Timed loop: Herald posts and Treasurer buys back every loop, Keeper responds between.',
    sentinelThreshold: 70,
    topology: [
      pair('scout', 'forge'),
      pair('forge', 'sentinel'),
      pair('sentinel', 'treasurer'),
      pair('treasurer', 'herald'),
      pair('herald', 'keeper'),
      pair('keeper', 'scout'),
    ],
    gateEveryAction: false,
    base: { devBuySol: 0.25, buybackSolPerTick: 0.01, llmCallsPerAgentHour: 40, postsPerHour: 6, repliesPerHour: 20 },
    postingWindowMin: null,
    loopMinutes: 10,
  },
  diamond: {
    id: 'diamond',
    label: 'SHAPE_DIAMOND',
    description:
      'Every agent may bond with every other, so each can hold a triple bond (valence 4 still caps its total). Max budget. Every action gated behind your approval.',
    sentinelThreshold: 85,
    topology: ALL_PAIRS,
    gateEveryAction: true,
    base: { devBuySol: 0.5, buybackSolPerTick: 0.02, llmCallsPerAgentHour: 80, postsPerHour: 6, repliesPerHour: 30 },
    postingWindowMin: null,
    loopMinutes: null,
  },
};

/** One row of the 12-row table. Pure function of (isotope, shape, heavyAgent). */
export interface LaunchConfig {
  isotope: IsotopeId;
  shape: ShapeId;
  heavyAgent: AgentId | null;
  sentinelThreshold: number;
  decay: DecayRule;
  gateEveryAction: boolean;
  postingWindowMin: number | null;
  loopMinutes: number | null;
  devBuySol: number;
  buybackSolPerTick: number;
  /** Per-agent capacity. Only the heavy agent (C-13) differs from the others. */
  capacity: Record<AgentId, { llmCallsPerHour: number; concurrency: number }>;
  postsPerHour: number;
  repliesPerHour: number;
}

export const BASE_CONCURRENCY = 1;

export function launchConfig(isotope: IsotopeId, shape: ShapeId, heavyAgent: AgentId | null = null): LaunchConfig {
  const iso = ISOTOPES[isotope];
  const sh = SHAPES[shape];
  if (iso.heavyAgent && !heavyAgent) throw new Error(`${isotope} needs a heavy agent`);
  if (!iso.heavyAgent && heavyAgent) throw new Error(`${isotope} has no extra neutron; heavyAgent must be null`);
  const m = iso.budgetMultiplier;
  const round = (n: number) => Math.round(n * 1e9) / 1e9;
  const capacity = Object.fromEntries(
    AGENT_IDS.map((a) => {
      const k = a === heavyAgent ? 2 : 1;
      return [a, { llmCallsPerHour: Math.floor(sh.base.llmCallsPerAgentHour * m) * k, concurrency: BASE_CONCURRENCY * k }];
    }),
  ) as LaunchConfig['capacity'];
  return {
    isotope,
    shape,
    heavyAgent,
    sentinelThreshold: sh.sentinelThreshold,
    decay: iso.decay,
    gateEveryAction: sh.gateEveryAction,
    postingWindowMin: sh.postingWindowMin,
    loopMinutes: sh.loopMinutes,
    devBuySol: round(sh.base.devBuySol * m),
    buybackSolPerTick: round(sh.base.buybackSolPerTick * m),
    capacity,
    postsPerHour: Math.max(1, Math.floor(sh.base.postsPerHour * m)) * (heavyAgent === 'herald' ? 2 : 1),
    repliesPerHour: Math.max(1, Math.floor(sh.base.repliesPerHour * m)) * (heavyAgent === 'keeper' ? 2 : 1),
  };
}

// ───────────────────────────── fee split ─────────────────────────────

/** Basis points of every claimed creator fee. Sums to 10 000. */
export const FEE_SPLIT_BPS = { launcher: 5000, carbonBuyback: 3000, treasury: 2000 } as const;

// ───────────────────────────── events ─────────────────────────────

/**
 * Every event on the bus. Append-only in Postgres (`events` table), fanned out
 * through Redis pub/sub to SSE. `id` is the sha256 (hex) of the canonical JSON
 * of {launchId, seq-less body}; `sig` is the ed25519 signature of `id` by the
 * signer's key. Every live visual maps to one of these.
 */
export interface CarbonEvent<K extends EventKind = EventKind> {
  /** sha256 hex of canonicalJson(EventBody). The bond hash shown on seams is id.slice(0, 8). */
  id: string;
  /** Global monotonically increasing sequence (Postgres bigserial). */
  seq: number;
  /** Launch the event belongs to, or 'system' for global events (e.g. $CARBON buybacks). */
  launchId: string;
  /** Unix milliseconds, server clock at append. */
  ts: number;
  kind: K;
  /** Agent that emitted it, or 'user' / 'system'. */
  actor: AgentId | 'user' | 'system';
  payload: EventPayloads[K];
  /** Public key (hex) of the signer: an agent key or the system key. */
  signer: string;
  /** ed25519 signature (hex) over `id`. */
  sig: string;
}

export interface HandoffPayload {
  from: AgentId;
  to: AgentId;
  /** What is being handed off, e.g. 'narratives', 'coin-draft', 'score', 'post-draft'. */
  topic: string;
  /** Reference to the event that carries the actual work product. */
  refEventId?: string;
  summary: string;
}

export interface EventPayloads {
  'launch.created': { line: string; isotope: IsotopeId; shape: ShapeId; heavyAgent: AgentId | null; launcherWallet: string; xConnected: boolean };
  /** A signed agent→agent hand-off. The only event that forms bonds. */
  handoff: HandoffPayload;
  /** A hand-off that would exceed the receiver's or sender's valence; it waits. */
  'handoff.queued': HandoffPayload & { reason: string };
  /** Agent is waiting on another agent (for triple-bond "both blocked" rule). */
  'agent.blocked': { agent: AgentId; on: AgentId; reason: string };
  'agent.unblocked': { agent: AgentId; on: AgentId };
  /** Short reasoning summary, labelled "agent reasoning" in UI, tied to the event it explains. */
  reasoning: { agent: AgentId; forEventId: string; text: string };
  'scout.proposals': { narratives: { title: string; names: { name: string; ticker: string }[]; why: string; sources: string[] }[] };
  'forge.draft': { name: string; ticker: string; lore: string; logoUri: string; logoHash: string; bannerUri: string; siteUri: string; metadataUri?: string };
  'sentinel.score': SentinelReport;
  'approval.requested': { approvalId: string; action: ApprovalAction; draft: unknown; expiresAt: number | null };
  'approval.granted': { approvalId: string; by: string; viaAutopilot: boolean };
  'approval.consumed': { approvalId: string; action: ApprovalAction };
  'approval.rejected': { approvalId: string; by: string; reason?: string };
  /** Per-launch public fee address (native mode: the sharing-config PDA; wallet mode: the per-launch creator wallet). Emitted once per launch. */
  'wallet.created': { address: string; mode: 'native' | 'wallet' };
  /** creatorWallet = the per-launch fee address (see wallet.created), not necessarily the coin's creator. */
  'launch.deployed': { ca: string; txSig: string; creatorWallet: string; devBuySol: number; network: 'devnet' | 'mainnet-beta' };
  'post.published': { postId: string; url: string; text: string; approvalId: string; kind: 'post' | 'reply' };
  'fee.claimed': { claimId: string; lamports: string; txSig: string };
  'split.receipt': SplitReceipt;
  'buyback.executed': { lamportsIn: string; carbonOut: string; txSig: string; funding: 'fee-split'; splitId: string };
  'autopilot.changed': { actionClass: AutopilotClass; enabled: boolean; by: string };
  'killswitch.engaged': { by: string; reason?: string };
  'holders.snapshot': { slot: number; holderCount: number; merkleRoot?: string };
  'decay.started': { rule: 'quiet' | 'clock'; collapseAt: number | null };
  'decay.collapsed': { at: number; reason: 'quiet' | 'clock'; snapshotEventId: string };
  'daughter.launched': { motherCa: string; daughterCa: string; txSig: string; allocationRoot: string };
  'airdrop.sent': { daughterCa: string; wallet: string; units: string; txSig: string };
  'budget.exceeded': { agent: AgentId; budget: string; limit: number };
  error: { agent?: AgentId; message: string };
}
export type EventKind = keyof EventPayloads;

export type ApprovalAction = 'launch' | 'post' | 'reply' | 'buyback' | 'action';
/** Autopilot is per launch and per class. 'launch' is deliberately absent: never autopilot. */
export const AUTOPILOT_CLASSES = ['posts', 'replies', 'buybacks'] as const;
export type AutopilotClass = (typeof AUTOPILOT_CLASSES)[number];

export interface SentinelInput {
  key: 'collision' | 'logo' | 'wallet' | 'sniper' | 'freshness' | 'content';
  points: number;
  max: number;
  reason: string;
  hardFail: boolean;
}
export interface SentinelReport {
  score: number; // 0..100
  threshold: number;
  inputs: SentinelInput[];
  hardFail: boolean;
  passed: boolean; // score >= threshold && !hardFail
  run: number; // re-run counter
  /** The forge.draft event this score is for, and sha256 of its content (launch gate re-checks both). */
  draftEventId?: string;
  contentHash?: string;
}

export interface SplitReceipt {
  splitId: string;
  claimId: string;
  totalLamports: string;
  legs: { to: 'launcher' | 'carbon-buyback' | 'treasury'; address: string; lamports: string; txSig: string | null; status: 'pending' | 'sent' | 'confirmed' }[];
  at: number;
}

// ───────────────────────────── bonds ─────────────────────────────

export type BondOrder = 0 | 1 | 2 | 3;
export const BOND_WINDOW_MS = 60_000;
export interface Bond {
  pair: PairKey;
  order: BondOrder;
  /** Hand-offs in the window. */
  exchanges: number;
  /** id of the most recent hand-off on this bond; seam shows lastHash.slice(0,8). */
  lastHash: string;
}

// ───────────────────────────── footer ─────────────────────────────

export const FOOTER_TEXT =
  'Carbon does not run on a quantum computer. Agents are powered by Google Gemini; Carbon is not affiliated with or endorsed by Google. Coins launch on pump.fun (Solana). A meme, not an investment.';

export const EMPTY_READOUT = '--.--';
export const EMPTY_GRAPHENE = 'No molecules yet. Launch the first one.';
