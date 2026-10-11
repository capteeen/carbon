/**
 * TREASURER: the launch's fee address (native pump.fun fee sharing: the
 * sharing-config PDA; fallback: a per-launch creator wallet), the launch
 * transaction (only after a consumed 'launch' approval AND a passing Sentinel
 * score), the scheduled fee crank, split receipts, and $CARBON buybacks funded
 * only by the 30% leg (buyCarbon is passed the splitId; idempotent per split).
 *
 * The only chain calls that move value are buildLaunchTx/submitLaunchTx (the
 * launch's own dev buy), runSplit and buyCarbon. Nothing else is ever traded.
 */
import { ISOTOPES, type AgentId, type BudgetKind, type CarbonEvent, type ChainClient, type SplitReceipt } from '@carbon/core';
import type { ApprovalCard } from '../cards.js';
import { type AgentContext, AgentRefusal, all, emit, emitError, errMsg, gate, latest, requestApproval } from '../context.js';
import { assertLaunchCleared } from '../sentinel/index.js';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function lamportsToSol(l: bigint): string {
  const whole = l / LAMPORTS_PER_SOL;
  const frac = (l % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Optional chain-ledger reads that @carbon/solana's CarbonChainClient implements and
 * the ChainClient port does not (yet) declare. Local type, proposed for ports.ts.
 */
export interface ChainLedger {
  /** Every confirmed claim/distribution in the chain's durable ledger (AG-007). */
  confirmedClaims?(launchId: string): Promise<{ claimId: string; lamports: bigint; txSig: string; origin?: 'carbon' | 'foreign' }[]>;
  /** Native mode: record distributions a third party cranked on the coin's sharing config. */
  scanForeignDistributions?(launchId: string): Promise<unknown[]>;
  /** The split's open (unacknowledged) buy, if any: resumed without a new request. */
  recordedBuyback?(splitId: string): Promise<{ lamports: bigint; state: string; txSig: string | null } | null>;
  /** Tells the chain ledger the buy's receipt is in the log, so the split may buy again. */
  ackBuyback?(splitId: string, txSig: string): Promise<void>;
}

/** What buyCarbon may report beyond the port: the SOL the confirmed trade actually spent. */
type BuyResult = Awaited<ReturnType<ChainClient['buyCarbon']>> & { lamportsIn?: bigint; event?: { payload?: { lamportsIn?: string } } };
/** What submitLaunchTx may report beyond the port: the create transaction's block time. */
type SubmitResult = Awaited<ReturnType<ChainClient['submitLaunchTx']>> & { bornAtMs?: number | null };

/** Budgets.spend with an idempotency key (PgBudgets honours it; a 4-argument implementation ignores it). */
async function spendOnce(ctx: AgentContext, agent: AgentId, kind: BudgetKind, amount: number, key: string): Promise<void> {
  const spend = ctx.budgets.spend.bind(ctx.budgets) as (l: string, a: AgentId, k: BudgetKind, n: number, key: string) => Promise<void>;
  await spend(ctx.launchId, agent, kind, amount, key);
}

/** The user's wallet signs and pays the launch tx; Carbon never holds that key. */
export type SignLaunchTx = (args: { txBase64: string; mint: string }) => Promise<string>;

export class Treasurer {
  private wallet: string | null = null;

  constructor(private readonly ctx: AgentContext) {}

  /**
   * The launch's fee address (native mode: the coin's pump.fun sharing-config
   * PDA; wallet mode: the per-launch creator wallet). Read from the log first,
   * launch.deployed, else the address on Treasurer's launch approval card, so
   * chain.createLaunchWallet runs at most once per launchId across restarts.
   */
  async launchWallet(): Promise<string> {
    if (this.wallet) return this.wallet;
    const dep = await latest(this.ctx, 'launch.deployed');
    const carded = (await all(this.ctx, 'approval.requested'))
      .filter((e) => e.actor === 'treasurer' && e.payload.action === 'launch')
      .map((e) => (e.payload.draft as ApprovalCard | null)?.details?.launchWallet)
      .find((a): a is string => typeof a === 'string' && a.length > 0);
    this.wallet = dep?.payload.creatorWallet ?? carded ?? (await this.ctx.chain.createLaunchWallet(this.ctx.launchId)).address;
    return this.wallet;
  }

  /**
   * Deploy. Refuses (throws) unless Sentinel's latest score passed for the
   * exact draft being deployed and the user granted a 'launch' approval, which
   * is consumed before the transaction is built.
   */
  async deploy(args: { launcherWallet: string; sign: SignLaunchTx }): Promise<CarbonEvent<'launch.deployed'> | null> {
    const ctx = this.ctx;
    if (await latest(ctx, 'launch.deployed')) throw new AgentRefusal('treasurer', 'launch already deployed');
    const cleared = await assertLaunchCleared(ctx);
    const d = cleared.draft.payload;
    if (!d.metadataUri) throw new AgentRefusal('treasurer', 'draft has no uploaded metadata; Forge must prepare the deploy first');
    const creatorWallet = await this.launchWallet();

    const card: ApprovalCard = {
      title: `Launch ${d.name} ($${d.ticker})`,
      agent: 'treasurer',
      summary: `Launch on pump.fun (${ctx.chain.network}). Your wallet signs and pays; creator fees go to ${creatorWallet} and are split 50/30/20; dev buy ${ctx.config.devBuySol} SOL.`,
      details: {
        name: d.name,
        ticker: d.ticker,
        logo: d.logoUri,
        site: d.siteUri,
        metadata: d.metadataUri,
        devBuySol: String(ctx.config.devBuySol),
        launchWallet: creatorWallet,
        payer: args.launcherWallet,
        network: ctx.chain.network,
        stability: `${cleared.score.payload.score}/${cleared.score.payload.threshold}`,
      },
    };
    const { decision } = await requestApproval(
      ctx,
      'treasurer',
      'launch',
      card,
      `Sentinel passed ${cleared.score.payload.score}/${cleared.score.payload.threshold}; asking you to approve the launch of $${d.ticker}.`,
    );
    if (!decision.granted) return null;
    // Re-check: nothing may have changed while the card waited.
    const again = await assertLaunchCleared(ctx);
    if (again.score.id !== cleared.score.id || again.draft.id !== cleared.draft.id) {
      throw new AgentRefusal('treasurer', 'Sentinel score or draft changed while waiting for approval; approve again');
    }
    await ctx.approvals.consume(ctx.launchId, decision.approvalId, 'launch');
    // One dev buy per launch: a retried deploy does not count it twice.
    await spendOnce(ctx, 'treasurer', 'devbuy-lamports', Number(solToLamports(ctx.config.devBuySol)), `devbuy:${ctx.launchId}`);
    const tx = await ctx.chain.buildLaunchTx({
      launchId: ctx.launchId,
      payer: args.launcherWallet,
      name: d.name,
      symbol: d.ticker,
      metadataUri: d.metadataUri,
      devBuySol: ctx.config.devBuySol,
      approvalId: decision.approvalId,
    });
    const signed = await args.sign({ txBase64: tx.txBase64, mint: tx.mint });
    const submitted: SubmitResult = await ctx.chain.submitLaunchTx(ctx.launchId, signed);
    const { txSig, ca } = submitted;
    const deployed = await emit(
      ctx,
      'treasurer',
      'launch.deployed',
      { ca, txSig, creatorWallet, devBuySol: ctx.config.devBuySol, network: ctx.chain.network },
      `Deployed $${d.ticker} on ${ctx.chain.network} after approval and Sentinel ${cleared.score.payload.score}/${cleared.score.payload.threshold}; dev buy ${ctx.config.devBuySol} SOL; fee address ${creatorWallet}.`,
    );
    await this.startDecayClock(submitted.bornAtMs ?? null, txSig);
    return deployed;
  }

  /**
   * AG-025: an unstable isotope's clock starts at the create transaction's block time on
   * chain, not at the time an event was appended. Recorded once, in decay.started.
   */
  private async startDecayClock(bornAtMs: number | null, txSig: string): Promise<void> {
    const rule = ISOTOPES[this.ctx.config.isotope].decay;
    if (rule.kind === 'none' || bornAtMs === null) return;
    if (await latest(this.ctx, 'decay.started')) return;
    const collapseAt = rule.kind === 'clock' ? bornAtMs + rule.clockSec * 1000 : null;
    await emit(
      this.ctx,
      'treasurer',
      'decay.started',
      { rule: rule.kind, collapseAt },
      collapseAt !== null
        ? `${this.ctx.config.isotope} clock started at the create tx's block time (tx ${txSig.slice(0, 8)}); collapse at ${new Date(collapseAt).toISOString()}.`
        : `${this.ctx.config.isotope} decays after a quiet period with no trades, counted from the create tx's block time (tx ${txSig.slice(0, 8)}).`,
    );
  }

  /**
   * No claim without a receipt (AG-007): every confirmed claim in the chain's durable
   * ledger that has no fee.claimed event gets one now, so a crash between the claim
   * landing and its append is recovered on the next tick. In native mode, distributions
   * a third party cranked on the coin's sharing config are found and receipted the same way.
   */
  async reconcileClaims(): Promise<CarbonEvent<'fee.claimed'>[]> {
    const ctx = this.ctx;
    const chain = ctx.chain as ChainClient & ChainLedger;
    if (!chain.confirmedClaims || !(await latest(ctx, 'launch.deployed'))) return [];
    if (chain.scanForeignDistributions) {
      try {
        await chain.scanForeignDistributions(ctx.launchId);
      } catch (e) {
        await emitError(ctx, 'treasurer', `Scan for third-party fee distributions failed; retried next tick: ${errMsg(e)}`);
      }
    }
    const logged = new Set((await all(ctx, 'fee.claimed')).map((e) => e.payload.claimId));
    const out: CarbonEvent<'fee.claimed'>[] = [];
    for (const c of await chain.confirmedClaims(ctx.launchId)) {
      if (logged.has(c.claimId)) continue;
      const sol = lamportsToSol(c.lamports);
      const why =
        c.origin === 'foreign'
          ? `A third party cranked this coin's fee distribution (tx ${c.txSig.slice(0, 8)}): ${sol} SOL distributed on chain; receipting it.`
          : `Recovered a confirmed fee claim that had no receipt (tx ${c.txSig.slice(0, 8)}): ${sol} SOL.`;
      out.push(await emit(ctx, 'treasurer', 'fee.claimed', { claimId: c.claimId, lamports: c.lamports.toString(), txSig: c.txSig }, why));
      logged.add(c.claimId);
    }
    return out;
  }

  /** Re-run any split that has no fully confirmed receipt (idempotent on the chain side). */
  async resumeSplits(): Promise<CarbonEvent<'split.receipt'>[]> {
    const ctx = this.ctx;
    await this.reconcileClaims();
    const claims = await all(ctx, 'fee.claimed');
    const receipts = await all(ctx, 'split.receipt');
    const out: CarbonEvent<'split.receipt'>[] = [];
    for (const c of claims) {
      const last = receipts.filter((r) => r.payload.claimId === c.payload.claimId).pop();
      if (last && last.payload.legs.every((l) => l.status === 'confirmed')) continue;
      out.push(await this.split(c.payload.claimId, last ? 'Re-read an unfinished split' : 'Receipt for a claim that had none'));
    }
    return out;
  }

  /** Scheduled: claim creator fees and split them. Returns null when there was nothing to claim. */
  async claimAndSplit(): Promise<{ claim: CarbonEvent<'fee.claimed'>; receipt: CarbonEvent<'split.receipt'> } | null> {
    const ctx = this.ctx;
    if (!(await latest(ctx, 'launch.deployed'))) return null;
    await gate(ctx, 'treasurer', 'claim creator fees and run the 50/30/20 split', { network: ctx.chain.network });
    const c = await ctx.chain.claimCreatorFees(ctx.launchId);
    if (!c) return null;
    const claim = await emit(
      ctx,
      'treasurer',
      'fee.claimed',
      { claimId: c.claimId, lamports: c.lamports.toString(), txSig: c.txSig },
      `Fee crank collected ${lamportsToSol(c.lamports)} SOL of creator fees (tx ${c.txSig.slice(0, 8)}).`,
    );
    const receipt = await this.split(c.claimId, '50/30/20 receipt');
    return { claim, receipt };
  }

  /**
   * Records the receipt the chain reports. Treasurer never moves legs itself:
   * in native mode runSplit parses the on-chain distribution; in wallet mode
   * the Solana package's idempotent ledger sends them.
   */
  private async split(claimId: string, why: string): Promise<CarbonEvent<'split.receipt'>> {
    const r: SplitReceipt = await this.ctx.chain.runSplit(this.ctx.launchId, claimId);
    const legs = r.legs.map((l) => `${l.to} ${lamportsToSol(BigInt(l.lamports))} ${l.status}`).join(', ');
    return emit(this.ctx, 'treasurer', 'split.receipt', r, `${why}: ${legs}.`);
  }

  /** Unspent lamports on confirmed carbon-buyback legs, per split, oldest first (leg minus what receipted buys spent). */
  async buybackFunds(): Promise<{ splitId: string; remaining: bigint; bought: number }[]> {
    const receipts = await all(this.ctx, 'split.receipt');
    const latestBySplit = new Map<string, SplitReceipt>();
    for (const r of receipts) latestBySplit.set(r.payload.splitId, r.payload);
    const spent = new Map<string, { lamports: bigint; n: number }>();
    for (const b of await all(this.ctx, 'buyback.executed')) {
      const cur = spent.get(b.payload.splitId) ?? { lamports: 0n, n: 0 };
      spent.set(b.payload.splitId, { lamports: cur.lamports + BigInt(b.payload.lamportsIn), n: cur.n + 1 });
    }
    const out: { splitId: string; remaining: bigint; bought: number }[] = [];
    for (const [splitId, r] of latestBySplit) {
      const funded = r.legs.filter((l) => l.to === 'carbon-buyback' && l.status === 'confirmed').reduce((s, l) => s + BigInt(l.lamports), 0n);
      const s = spent.get(splitId) ?? { lamports: 0n, n: 0 };
      const remaining = funded - s.lamports;
      if (remaining > 0n) out.push({ splitId, remaining, bought: s.n });
    }
    return out;
  }

  /**
   * Finishes a buy the chain ledger holds for a split with no receipt yet (the process
   * stopped between the buy and its receipt, AG-005/AG-022). Its approval was consumed and
   * its budget spent (keyed by split and buy number) before it started, so nothing is
   * requested or counted again. Runs even after the kill switch: it only completes a receipt.
   */
  async resumeBuyback(): Promise<CarbonEvent<'buyback.executed'> | null> {
    const chain = this.ctx.chain as ChainClient & ChainLedger;
    if (!chain.recordedBuyback) return null;
    const logged = await all(this.ctx, 'buyback.executed');
    for (const f of await this.buybackFunds()) {
      const rec = await chain.recordedBuyback(f.splitId);
      if (!rec) continue;
      const done = rec.txSig ? logged.find((e) => e.payload.txSig === rec.txSig) : undefined;
      if (done) {
        // Receipt appended, acknowledgement lost: acknowledge and move on.
        await chain.ackBuyback?.(f.splitId, done.payload.txSig);
        continue;
      }
      await spendOnce(this.ctx, 'treasurer', 'buyback-lamports', Number(rec.lamports), buybackKey(f.splitId, f.bought));
      const res: BuyResult = await chain.buyCarbon(rec.lamports, f.splitId);
      return this.recordBuy(res, f.splitId, 'Finished a buyback recorded on chain without a receipt');
    }
    return null;
  }

  /** One receipt per on-chain buy: the log is checked by txSig before appending; the chain is then told it is receipted. */
  private async recordBuy(res: BuyResult, splitId: string, why: string): Promise<CarbonEvent<'buyback.executed'>> {
    const ctx = this.ctx;
    const chain = ctx.chain as ChainClient & ChainLedger;
    let e = (await all(ctx, 'buyback.executed')).find((x) => x.payload.txSig === res.txSig);
    if (!e) {
      // What the confirmed trade spent, as the chain reports it; never the requested amount (AG-006).
      const reported = res.lamportsIn ?? (res.event?.payload?.lamportsIn !== undefined ? BigInt(res.event.payload.lamportsIn) : null);
      if (reported === null) throw new Error(`buy ${res.txSig} landed but the chain client did not report the SOL it spent; refusing to write a receipt with a guessed amount`);
      e = await emit(
        ctx,
        'treasurer',
        'buyback.executed',
        { lamportsIn: reported.toString(), carbonOut: res.carbonOut.toString(), txSig: res.txSig, funding: 'fee-split', splitId },
        `${why}: bought ${res.carbonOut} base units of $CARBON for ${lamportsToSol(reported)} SOL from split ${splitId.slice(0, 8)}'s 30% leg (tx ${res.txSig.slice(0, 8)}).`,
      );
    }
    await chain.ackBuyback?.(splitId, res.txSig);
    return e;
  }

  /** Buy $CARBON with at most buybackSolPerTick, from the 30% leg only. Needs a 'buyback' approval (or autopilot). */
  async buyback(): Promise<CarbonEvent<'buyback.executed'> | null> {
    const ctx = this.ctx;
    const resumed = await this.resumeBuyback();
    if (resumed) return resumed;
    const cap = solToLamports(ctx.config.buybackSolPerTick);
    if (cap <= 0n) return null;
    const fund = (await this.buybackFunds())[0];
    if (!fund) return null;
    const amount = fund.remaining < cap ? fund.remaining : cap;
    const card: ApprovalCard = {
      title: `Buy $CARBON with ${lamportsToSol(amount)} SOL`,
      agent: 'treasurer',
      summary: 'Funded only by the 30% buyback share of a fee split.',
      details: { splitId: fund.splitId, lamports: amount.toString(), capPerTick: ctx.config.buybackSolPerTick.toString() },
    };
    const { decision } = await requestApproval(ctx, 'treasurer', 'buyback', card, `Split ${fund.splitId.slice(0, 8)} has ${lamportsToSol(fund.remaining)} SOL of buyback funds; buying ${lamportsToSol(amount)} SOL of $CARBON (cap per tick).`);
    if (!decision.granted) return null;
    // Recompute: never spend more than the leg funded, even if two ticks raced.
    const again = (await this.buybackFunds()).find((f) => f.splitId === fund.splitId);
    if (!again || again.remaining < amount || again.bought !== fund.bought) throw new AgentRefusal('treasurer', 'buyback funds changed while waiting; skipped');
    await ctx.approvals.consume(ctx.launchId, decision.approvalId, 'buyback');
    // Keyed by split and buy number: a resumed buy is never counted twice (AG-022).
    await spendOnce(ctx, 'treasurer', 'buyback-lamports', Number(amount), buybackKey(fund.splitId, fund.bought));
    const res: BuyResult = await ctx.chain.buyCarbon(amount, fund.splitId);
    return this.recordBuy(res, fund.splitId, 'Buyback');
  }
}

/** Budget idempotency key of a split's next buy (n = receipted buys of the split so far). */
function buybackKey(splitId: string, n: number): string {
  return `buyback:${splitId}:${n + 1}`;
}
