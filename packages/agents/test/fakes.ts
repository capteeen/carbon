/**
 * In-memory test doubles of the core ports. Test-only; never exported from src/.
 */
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import {
  AGENT_IDS,
  type AgentId,
  type ApprovalAction,
  type AutopilotClass,
  type Bond,
  type CarbonEvent,
  type EventKind,
  type LaunchConfig,
  type SplitReceipt,
  VALENCE,
  pairKey,
} from '@carbon/core';
import type {
  AppendInput,
  ApprovalDecision,
  Approvals,
  Budgets,
  ChainClient,
  EventBus,
  Handoffs,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  PumpCoinInfo,
  XClient,
  XPost,
} from '@carbon/core';
import type { AgentContext, AssetStore } from '../src/context.js';

export class Clock {
  constructor(public t = Date.UTC(2026, 9, 11, 12, 0, 0)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

export class FakeBus implements EventBus {
  events: CarbonEvent[] = [];
  private listeners = new Set<{ launchId: string; cb: (e: CarbonEvent) => void }>();
  constructor(private clock: Clock) {}
  async append<K extends EventKind>(input: AppendInput<K>): Promise<CarbonEvent<K>> {
    const body = { launchId: input.launchId, kind: input.kind, actor: input.actor, payload: input.payload, ts: this.clock.now(), n: this.events.length };
    const id = createHash('sha256').update(canon(body)).digest('hex');
    const e = { id, seq: this.events.length + 1, launchId: input.launchId, ts: body.ts, kind: input.kind, actor: input.actor, payload: input.payload, signer: 'test', sig: 'test' } as CarbonEvent<K>;
    this.events.push(e as CarbonEvent);
    for (const l of [...this.listeners]) if (l.launchId === '*' || l.launchId === e.launchId) l.cb(e as CarbonEvent);
    return e;
  }
  async list(launchId: string, opts: { afterSeq?: number; kinds?: EventKind[]; limit?: number } = {}): Promise<CarbonEvent[]> {
    let out = this.events.filter((e) => (launchId === '*' || e.launchId === launchId) && e.seq > (opts.afterSeq ?? 0) && (!opts.kinds || opts.kinds.includes(e.kind)));
    if (opts.limit) out = out.slice(0, opts.limit);
    return out;
  }
  subscribe(launchId: string, cb: (e: CarbonEvent) => void): () => void {
    const l = { launchId, cb };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  verify(): boolean {
    return true;
  }
  ofKind<K extends EventKind>(k: K): CarbonEvent<K>[] {
    return this.events.filter((e) => e.kind === k) as CarbonEvent<K>[];
  }
}

/** Valence: each agent may be in at most VALENCE concurrent in-flight hand-offs (fake: sends are instantaneous). */
export class FakeHandoffs implements Handoffs {
  sent: { from: AgentId; to: AgentId; topic: string }[] = [];
  constructor(private bus: FakeBus) {}
  async send(launchId: string, from: AgentId, to: AgentId, topic: string, summary: string, refEventId?: string) {
    this.sent.push({ from, to, topic });
    return this.bus.append({ launchId, kind: 'handoff', actor: from, payload: { from, to, topic, summary, ...(refEventId ? { refEventId } : {}) } });
  }
  async bonds(launchId: string): Promise<Bond[]> {
    const m = new Map<string, Bond>();
    for (const e of this.bus.ofKind('handoff').filter((e) => e.launchId === launchId)) {
      const k = pairKey(e.payload.from, e.payload.to);
      const b = m.get(k) ?? { pair: k, order: 0, exchanges: 0, lastHash: '' };
      b.exchanges++;
      b.order = (b.exchanges >= 8 ? 3 : b.exchanges >= 3 ? 2 : 1) as Bond['order'];
      b.lastHash = e.id;
      m.set(k, b);
    }
    void VALENCE;
    return [...m.values()];
  }
}

export type Policy = (action: ApprovalAction, draft: unknown, actor: AgentId) => boolean;

export class FakeApprovals implements Approvals {
  private n = 0;
  state = new Map<string, { launchId: string; action: ApprovalAction; granted: boolean; consumed: boolean }>();
  autopilot = new Set<AutopilotClass>();
  requests: { action: ApprovalAction; actor: AgentId; draft: unknown }[] = [];
  constructor(
    private bus: FakeBus,
    public policy: Policy = () => true,
    private gateEvery = false,
  ) {}
  async request(launchId: string, action: ApprovalAction, draft: unknown, actor: AgentId): Promise<ApprovalDecision> {
    const approvalId = `appr-${++this.n}`;
    this.requests.push({ action, actor, draft });
    await this.bus.append({ launchId, kind: 'approval.requested', actor, payload: { approvalId, action, draft, expiresAt: null } });
    const cls: AutopilotClass | null = action === 'post' ? 'posts' : action === 'reply' ? 'replies' : action === 'buyback' ? 'buybacks' : null;
    const auto = !this.gateEvery && cls !== null && this.autopilot.has(cls);
    const granted = auto || this.policy(action, draft, actor);
    this.state.set(approvalId, { launchId, action, granted, consumed: false });
    if (granted) await this.bus.append({ launchId, kind: 'approval.granted', actor: 'user', payload: { approvalId, by: auto ? 'autopilot' : 'wallet', viaAutopilot: auto } });
    else await this.bus.append({ launchId, kind: 'approval.rejected', actor: 'user', payload: { approvalId, by: 'wallet' } });
    return { approvalId, granted, by: 'wallet', viaAutopilot: auto };
  }
  async decide(): Promise<void> {}
  async consume(launchId: string, approvalId: string, action: ApprovalAction): Promise<void> {
    const s = this.state.get(approvalId);
    if (!s || !s.granted || s.consumed || s.launchId !== launchId || s.action !== action) throw new Error(`approval ${approvalId} not consumable for ${action}`);
    s.consumed = true;
  }
  isConsumed(approvalId: string, action: ApprovalAction): boolean {
    const s = this.state.get(approvalId);
    return !!s && s.consumed && s.action === action;
  }
  async setAutopilot(_l: string, cls: AutopilotClass, enabled: boolean): Promise<void> {
    if (enabled) this.autopilot.add(cls);
    else this.autopilot.delete(cls);
  }
  async killSwitch(launchId: string, by: string): Promise<void> {
    this.autopilot.clear();
    await this.bus.append({ launchId, kind: 'killswitch.engaged', actor: 'user', payload: { by } });
  }
}

export class FakeBudgets implements Budgets {
  calls: { agent: AgentId; kind: string; amount?: number }[] = [];
  constructor(private cfg: LaunchConfig) {}
  async spend(_l: string, agent: AgentId, kind: Parameters<Budgets['spend']>[2], amount?: number): Promise<void> {
    if (kind === 'llm' && this.calls.filter((c) => c.agent === agent && c.kind === 'llm').length >= this.cfg.capacity[agent].llmCallsPerHour) {
      throw new Error(`budget exceeded: ${agent} llm`);
    }
    this.calls.push({ agent, kind, ...(amount !== undefined ? { amount } : {}) });
  }
}

/** Solid-ish test PNG with a seeded pattern. */
export function makePng(seed: number, w = 64, h = 64): Uint8Array {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = (Math.sin((x + seed * 7) / (3 + (seed % 5))) * Math.cos((y * (seed + 1)) / 9) * 127 + 128) | 0;
      png.data[i] = v;
      png.data[i + 1] = (v * 3 + seed) & 255;
      png.data[i + 2] = 255 - v;
      png.data[i + 3] = 255;
    }
  return new Uint8Array(PNG.sync.write(png));
}

export type Script = (req: LlmRequest) => { json: unknown; sources?: string[] };

export class ScriptedLlm implements LlmProvider {
  readonly id = 'scripted';
  readonly model = 'scripted-test';
  calls: LlmRequest[] = [];
  images: string[] = [];
  constructor(
    private script: Script,
    public imageSeed = 1,
  ) {}
  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const r = this.script(req);
    return { text: JSON.stringify(r.json), json: r.json, provider: this.id, model: this.model, sources: r.sources ?? [] };
  }
  async generateImage(prompt: string, aspect: '1:1' | '3:1') {
    this.images.push(prompt);
    return { bytes: makePng(this.imageSeed, aspect === '1:1' ? 64 : 192, 64), mime: 'image/png', model: 'scripted-image' };
  }
}

export const TW_EPOCH = 1288834974657n;
export function snowflake(ms: number, n = 0): string {
  return ((BigInt(ms) - TW_EPOCH) << 22n | BigInt(n)).toString();
}

export class FakeX implements XClient {
  posts: { text: string; approvalId: string }[] = [];
  replies: { inReplyTo: string; text: string; approvalId: string }[] = [];
  mentionList: XPost[] = [];
  searchResult: XPost[] | Error = [];
  constructor(private approvals: FakeApprovals) {}
  async searchRecent(): Promise<XPost[]> {
    if (this.searchResult instanceof Error) throw this.searchResult;
    return this.searchResult;
  }
  async post(_l: string, text: string, approvalId: string) {
    if (!this.approvals.isConsumed(approvalId, 'post')) throw new Error('FakeX: post without consumed approval');
    this.posts.push({ text, approvalId });
    return { id: `p${this.posts.length}`, url: `https://x.com/i/web/status/${this.posts.length}` };
  }
  async reply(_l: string, inReplyTo: string, text: string, approvalId: string) {
    if (!this.approvals.isConsumed(approvalId, 'reply')) throw new Error('FakeX: reply without consumed approval');
    this.replies.push({ inReplyTo, text, approvalId });
    return { id: `r${this.replies.length}`, url: `https://x.com/i/web/status/r${this.replies.length}` };
  }
  async mentions(): Promise<XPost[]> {
    return this.mentionList;
  }
  async isConnected() {
    return !(this.searchResult instanceof Error);
  }
}

export class FakeChain implements ChainClient {
  readonly network = 'devnet' as const;
  coins: PumpCoinInfo[] | Error = [];
  history: { txCount: number; firstSeen: number | null; launches: number } | Error = { txCount: 150, firstSeen: 0, launches: 1 };
  built: { approvalId: string; devBuySol: number }[] = [];
  pendingClaims: { claimId: string; lamports: bigint; txSig: string }[] = [];
  splits = new Map<string, SplitReceipt>();
  payouts: { splitId: string; to: string; lamports: string }[] = [];
  buys: { lamports: bigint; splitId: string }[] = [];
  uploads = 0;
  constructor(private approvals: FakeApprovals) {}
  async createLaunchWallet() {
    return { address: 'CreatorWa11et1111111111111111111111111111111' };
  }
  async buildLaunchTx(args: Parameters<ChainClient['buildLaunchTx']>[0]) {
    if (!this.approvals.isConsumed(args.approvalId, 'launch')) throw new Error('FakeChain: no consumed launch approval');
    this.built.push({ approvalId: args.approvalId, devBuySol: args.devBuySol });
    return { txBase64: 'dHg=', mint: 'MintAddr1111111111111111111111111111111pump' };
  }
  async submitLaunchTx(_l: string, signed: string) {
    if (signed !== 'signed:dHg=') throw new Error('bad signature');
    return { txSig: 'LaunchSig111', ca: 'MintAddr1111111111111111111111111111111pump' };
  }
  async uploadMetadata() {
    this.uploads++;
    return { metadataUri: 'https://ipfs.io/ipfs/meta', imageUri: 'https://ipfs.io/ipfs/img' };
  }
  async searchCoins(): Promise<PumpCoinInfo[]> {
    if (this.coins instanceof Error) throw this.coins;
    return this.coins;
  }
  async walletHistory() {
    if (this.history instanceof Error) throw this.history;
    return this.history;
  }
  async claimCreatorFees() {
    return this.pendingClaims.shift() ?? null;
  }
  async runSplit(_l: string, claimId: string): Promise<SplitReceipt> {
    const existing = this.splits.get(claimId);
    if (existing && existing.legs.every((l) => l.status === 'confirmed')) return existing;
    const total = 1_000_000_000n;
    const legs: SplitReceipt['legs'] = (
      [
        ['launcher', 5000n],
        ['carbon-buyback', 3000n],
        ['treasury', 2000n],
      ] as const
    ).map(([to, bps], i) => {
      const lamports = ((total * bps) / 10000n).toString();
      const prev = existing?.legs[i];
      if (!prev || prev.status !== 'confirmed') this.payouts.push({ splitId: `split-${claimId}`, to, lamports });
      return { to, address: `${to}-addr`, lamports, txSig: `sig-${to}`, status: 'confirmed' as const };
    });
    const r: SplitReceipt = { splitId: `split-${claimId}`, claimId, totalLamports: total.toString(), legs, at: 0 };
    this.splits.set(claimId, r);
    return r;
  }
  async buyCarbon(lamports: bigint, splitId: string) {
    this.buys.push({ lamports, splitId });
    return { txSig: `buy-${this.buys.length}`, carbonOut: lamports * 1000n };
  }
  async lastTradeAt() {
    return null;
  }
}

export class MemAssets implements AssetStore {
  files = new Map<string, Uint8Array>();
  async put(launchId: string, name: string, bytes: Uint8Array) {
    const uri = `https://assets.test/${launchId}/${name}`;
    this.files.set(uri, bytes);
    return { uri };
  }
}

export interface Harness {
  ctx: AgentContext;
  bus: FakeBus;
  clock: Clock;
  approvals: FakeApprovals;
  budgets: FakeBudgets;
  llm: ScriptedLlm;
  x: FakeX;
  chain: FakeChain;
  handoffs: FakeHandoffs;
  assets: MemAssets;
}

export function harness(config: LaunchConfig, script: Script, launchId = 'L1'): Harness {
  const clock = new Clock();
  const bus = new FakeBus(clock);
  const approvals = new FakeApprovals(bus, () => true, config.gateEveryAction);
  const budgets = new FakeBudgets(config);
  const llm = new ScriptedLlm(script);
  const x = new FakeX(approvals);
  const chain = new FakeChain(approvals);
  const handoffs = new FakeHandoffs(bus);
  const assets = new MemAssets();
  const ctx: AgentContext = {
    bus,
    handoffs,
    approvals,
    budgets,
    llm,
    x,
    chain,
    config,
    launchId,
    now: clock.now,
    assets,
    fetchBytes: async (url) => {
      const b = assets.files.get(url);
      if (!b) throw new Error(`404 ${url}`);
      return { bytes: b, mime: 'image/png' };
    },
  };
  return { ctx, bus, clock, approvals, budgets, llm, x, chain, handoffs, assets };
}

export const AGENTS = new Set<string>(AGENT_IDS);
