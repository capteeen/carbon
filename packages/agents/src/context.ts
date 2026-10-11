/**
 * AgentContext: the only way an agent touches the outside world. Everything in
 * here is a port from @carbon/core (implemented by core, x and solana) plus two
 * small local ports (AssetStore, fetchBytes) that the agents package needs and
 * that ports.ts does not yet define (proposed to the integrator).
 */
import { SHAPES, pairKey } from '@carbon/core';
import type {
  AgentId,
  ApprovalAction,
  ApprovalDecision,
  Approvals,
  Budgets,
  CarbonEvent,
  ChainClient,
  EventBus,
  EventKind,
  EventPayloads,
  Handoffs,
  LaunchConfig,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  XClient,
} from '@carbon/core';
import type { ApprovalCard } from './cards.js';

/** Where Forge puts generated assets (banner, logo copy, site HTML). Local port: proposed for ports.ts. */
export interface AssetStore {
  put(launchId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ uri: string }>;
  /** Bytes of an asset this store returned a URI for (null if it is not one of its URIs). Sentinel reads drafts' images and site with it. */
  read?(uri: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

export type FetchBytes = (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;

export interface AgentContext {
  bus: EventBus;
  handoffs: Handoffs;
  approvals: Approvals;
  budgets: Budgets;
  llm: LlmProvider;
  x: XClient;
  chain: ChainClient;
  config: LaunchConfig;
  launchId: string;
  now(): number;
  assets: AssetStore;
  /** Used by Sentinel to fetch existing coins' images for the logo hash. Defaults to a size-limited global fetch. */
  fetchBytes?: FetchBytes;
}

export const REASONING_MAX = 240;

export class AgentRefusal extends Error {
  constructor(
    public readonly agent: AgentId,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRefusal';
  }
}

export function clip(text: string, max = REASONING_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Agent reasoning, tied to the event it explains. Text must come from the actual decision/LLM output. */
export async function reason(ctx: AgentContext, agent: AgentId, forEventId: string, text: string): Promise<CarbonEvent<'reasoning'>> {
  const t = clip(text);
  if (!t) throw new Error('reasoning text must not be empty');
  return ctx.bus.append({ launchId: ctx.launchId, kind: 'reasoning', actor: agent, payload: { agent, forEventId, text: t } });
}

/** Append an agent action and its reasoning. */
export async function emit<K extends EventKind>(
  ctx: AgentContext,
  agent: AgentId,
  kind: K,
  payload: EventPayloads[K],
  reasoning: string,
): Promise<CarbonEvent<K>> {
  const e = await ctx.bus.append({ launchId: ctx.launchId, kind, actor: agent, payload });
  await reason(ctx, agent, e.id, reasoning);
  return e;
}

/** Emits an `error` event for a refusal/failure, with reasoning. */
export async function emitError(ctx: AgentContext, agent: AgentId, message: string): Promise<CarbonEvent<'error'>> {
  return emit(ctx, agent, 'error', { agent, message: clip(message, 500) }, message);
}

export function bondAllowed(cfg: LaunchConfig, from: AgentId, to: AgentId): boolean {
  return SHAPES[cfg.shape].topology.includes(pairKey(from, to));
}

/** Every inter-agent hand-off goes through Handoffs (valence enforcement, signed, forms bonds). */
export async function handoff(
  ctx: AgentContext,
  from: AgentId,
  to: AgentId,
  topic: string,
  summary: string,
  refEventId?: string,
): Promise<CarbonEvent<'handoff'>> {
  if (!bondAllowed(ctx.config, from, to)) {
    throw new Error(`shape ${ctx.config.shape} has no ${from}–${to} bond`);
  }
  const s = clip(summary);
  const e = await ctx.handoffs.send(ctx.launchId, from, to, topic, s, refEventId);
  await reason(ctx, from, e.id, s);
  return e;
}

/** Budget first, then the LLM call. */
export async function think(ctx: AgentContext, agent: AgentId, req: LlmRequest): Promise<LlmResponse> {
  await ctx.budgets.spend(ctx.launchId, agent, 'llm');
  return ctx.llm.generate(req);
}

export async function latest<K extends EventKind>(ctx: AgentContext, kind: K): Promise<CarbonEvent<K> | null> {
  const list = (await ctx.bus.list(ctx.launchId, { kinds: [kind] })) as CarbonEvent<K>[];
  return list.length ? list[list.length - 1]! : null;
}

export async function all<K extends EventKind>(ctx: AgentContext, kind: K): Promise<CarbonEvent<K>[]> {
  return (await ctx.bus.list(ctx.launchId, { kinds: [kind] })) as CarbonEvent<K>[];
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  requestEvent: CarbonEvent<'approval.requested'> | null;
}

/**
 * Requests an approval with a pre-drafted card. The reasoning event is tied to
 * the approval.requested event as soon as it appears on the bus.
 */
export async function requestApproval(
  ctx: AgentContext,
  agent: AgentId,
  action: ApprovalAction,
  card: ApprovalCard,
  why: string,
): Promise<ApprovalResult> {
  const key = JSON.stringify(card);
  let found: CarbonEvent<'approval.requested'> | null = null;
  let reasoned: Promise<unknown> | null = null;
  const match = (e: CarbonEvent) =>
    e.kind === 'approval.requested' &&
    e.actor === agent &&
    (e as CarbonEvent<'approval.requested'>).payload.action === action &&
    JSON.stringify((e as CarbonEvent<'approval.requested'>).payload.draft) === key;
  const unsub = ctx.bus.subscribe(ctx.launchId, (e) => {
    if (!found && match(e)) {
      found = e as CarbonEvent<'approval.requested'>;
      reasoned = reason(ctx, agent, e.id, why);
    }
  });
  let decision: ApprovalDecision;
  try {
    decision = await ctx.approvals.request(ctx.launchId, action, card, agent);
  } finally {
    unsub();
  }
  if (reasoned) await reasoned;
  const byId = (await all(ctx, 'approval.requested')).find((e) => e.payload.approvalId === decision.approvalId) ?? null;
  // Subscription missed it (e.g. a bus without live tail in this process): tie the reasoning now.
  if (byId && !found) await reason(ctx, agent, byId.id, why);
  return { decision, requestEvent: byId ?? found };
}

/** DIAMOND: every action gated behind an approval. No-op for other shapes. */
export async function gate(ctx: AgentContext, agent: AgentId, title: string, details: Record<string, string>): Promise<void> {
  if (!ctx.config.gateEveryAction) return;
  const card: ApprovalCard = { title, agent, summary: `${agent.toUpperCase()} wants to: ${title}`, details };
  const { decision } = await requestApproval(ctx, agent, 'action', card, `Diamond gate: asking approval to ${title}.`);
  if (!decision.granted) throw new AgentRefusal(agent, `Action not approved: ${title}`);
  await ctx.approvals.consume(ctx.launchId, decision.approvalId, 'action');
}

export async function killSwitchEngaged(ctx: AgentContext): Promise<boolean> {
  return (await latest(ctx, 'killswitch.engaged')) !== null;
}
