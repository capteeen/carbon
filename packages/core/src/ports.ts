/**
 * Ports: the interfaces packages build against while they are written in
 * parallel. core implements EventBus/Approvals/Budgets/LlmProvider; x
 * implements XClient; solana implements ChainClient; agents consume all of
 * them. Written by the integrator.
 */
import type {
  AgentId,
  ApprovalAction,
  AutopilotClass,
  Bond,
  CarbonEvent,
  EventKind,
  EventPayloads,
  LaunchConfig,
  SentinelReport,
  SplitReceipt,
} from './contracts.js';

// ───────────────────────────── event bus ─────────────────────────────

export interface AppendInput<K extends EventKind = EventKind> {
  launchId: string;
  kind: K;
  actor: CarbonEvent['actor'];
  payload: EventPayloads[K];
}

export interface EventBus {
  /** Hash, sign (actor's key), append to Postgres, publish to Redis. Returns the stored event. */
  append<K extends EventKind>(input: AppendInput<K>): Promise<CarbonEvent<K>>;
  /** Ordered by seq. */
  list(launchId: string | '*', opts?: { afterSeq?: number; kinds?: EventKind[]; limit?: number }): Promise<CarbonEvent[]>;
  /** Live tail. Returns an unsubscribe function. */
  subscribe(launchId: string | '*', cb: (e: CarbonEvent) => void, opts?: { afterSeq?: number }): () => void;
  /** Verify hash and signature of a stored event. */
  verify(e: CarbonEvent): boolean;
}

/** Sends a hand-off through valence enforcement: appends `handoff`, or `handoff.queued` and waits. */
export interface Handoffs {
  send(launchId: string, from: AgentId, to: AgentId, topic: string, summary: string, refEventId?: string): Promise<CarbonEvent<'handoff'>>;
  /** Bonds recomputed from the log at time `at` (ms). Pure w.r.t. the log. */
  bonds(launchId: string, at?: number): Promise<Bond[]>;
}

// ───────────────────────────── approvals / autopilot / budgets ─────────────────────────────

export interface ApprovalDecision {
  approvalId: string;
  granted: boolean;
  by: string;
  viaAutopilot: boolean;
}

export interface Approvals {
  /**
   * Emits approval.requested with a pre-drafted card and resolves when the user
   * decides. Autopilot may auto-grant only for its enabled class and never for
   * 'launch'. Diamond (gateEveryAction) disables autopilot entirely.
   */
  request(launchId: string, action: ApprovalAction, draft: unknown, actor: AgentId): Promise<ApprovalDecision>;
  /** Called by the web API when the user taps approve/reject. `by` = launcher wallet. */
  decide(approvalId: string, granted: boolean, by: string, reason?: string): Promise<void>;
  /** Throws unless approvalId is granted, unconsumed, for this launch and action. Consumes it. */
  consume(launchId: string, approvalId: string, action: ApprovalAction): Promise<void>;
  setAutopilot(launchId: string, cls: AutopilotClass, enabled: boolean, by: string): Promise<void>;
  killSwitch(launchId: string, by: string, reason?: string): Promise<void>;
}

export interface Budgets {
  /** Throws BudgetExceededError (and emits budget.exceeded) if the agent is over its capacity. */
  spend(launchId: string, agent: AgentId, kind: 'llm' | 'post' | 'reply' | 'buyback-lamports' | 'devbuy-lamports', amount?: number): Promise<void>;
}

// ───────────────────────────── LLM ─────────────────────────────

export interface LlmRequest {
  system: string;
  prompt: string;
  /** JSON schema the response must match (structured output). */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  /** Ground with Google Search (Gemini) where supported. */
  grounding?: boolean;
}
export interface LlmResponse {
  text: string;
  json?: unknown;
  provider: string;
  model: string;
  /** Grounding / citation URLs returned by the provider, if any. */
  sources: string[];
}
export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
  /** Image generation for Forge (logo/banner). PNG bytes. */
  generateImage?(prompt: string, aspect: '1:1' | '3:1'): Promise<{ bytes: Uint8Array; mime: string; model: string }>;
}

// ───────────────────────────── X ─────────────────────────────

export interface XPost {
  id: string;
  text: string;
  authorId: string;
  createdAt: string;
  metrics?: { likes: number; reposts: number; replies: number; quotes: number; impressions?: number };
}
export interface XClient {
  /** Recent search (app or user token). Used by Scout for live trends. */
  searchRecent(query: string, opts?: { max?: number; launchId?: string }): Promise<XPost[]>;
  /** Trends where the API tier allows it; [] with a reason otherwise. */
  trends?(woeid?: number): Promise<{ name: string; volume?: number }[]>;
  /** Why trends are (un)available, so Scout can say so instead of guessing. */
  trendsAvailability?(): { status: string; reason: string | null; checkedAt: number | null };
  /** Post from the user's connected account. Requires a consumed approval. */
  post(launchId: string, text: string, approvalId: string): Promise<{ id: string; url: string }>;
  reply(launchId: string, inReplyTo: string, text: string, approvalId: string): Promise<{ id: string; url: string }>;
  mentions(launchId: string, sinceId?: string): Promise<XPost[]>;
  isConnected(launchId: string): Promise<boolean>;
}

// ───────────────────────────── chain ─────────────────────────────

export interface PumpCoinInfo {
  mint: string;
  name: string;
  symbol: string;
  imageUri?: string;
  createdAt?: number;
}

export interface ChainClient {
  readonly network: 'devnet' | 'mainnet-beta';
  /** Fresh per-launch creator wallet; secret encrypted at rest, never returned. */
  createLaunchWallet(launchId: string): Promise<{ address: string }>;
  /**
   * Build the unsigned pump.fun create(+dev buy) transaction for the user's
   * wallet to sign and pay. Creator = the per-launch wallet. Returns base64.
   */
  buildLaunchTx(args: { launchId: string; payer: string; name: string; symbol: string; metadataUri: string; devBuySol: number; approvalId: string }): Promise<{ txBase64: string; mint: string }>;
  /** Submit the user-signed tx; confirms; returns signature. */
  /** bornAtMs = the deploy tx's block time (C-14 clock origin). */
  submitLaunchTx(launchId: string, signedTxBase64: string): Promise<{ txSig: string; ca: string; bornAtMs?: number }>;
  uploadMetadata(args: { name: string; symbol: string; description: string; image: Uint8Array; twitter?: string; website?: string }): Promise<{ metadataUri: string; imageUri: string }>;
  /** Existing coins matching name/ticker, for Sentinel. Throws ChainUnavailableError when the source is unreachable. */
  searchCoins(query: string): Promise<PumpCoinInfo[]>;
  walletHistory(address: string): Promise<{ txCount: number; firstSeen: number | null; launches: number }>;
  claimCreatorFees(launchId: string): Promise<{ claimId: string; lamports: bigint; txSig: string } | null>;
  /** Idempotent: resumes a split by splitId without double-paying. */
  runSplit(launchId: string, claimId: string): Promise<SplitReceipt>;
  /** lamportsIn = what the trade actually spent, from the on-chain event. */
  buyCarbon(lamports: bigint, splitId: string): Promise<{ txSig: string; carbonOut: bigint; lamportsIn?: bigint }>;
  // Ledger reconciliation methods (confirmedClaims, scanForeignDistributions, recordedBuyback, ackBuyback)
  // are typed in @carbon/agents as ChainLedger and implemented by @carbon/solana.
  lastTradeAt(ca: string): Promise<number | null>;
}

export type { LaunchConfig, SentinelReport };
