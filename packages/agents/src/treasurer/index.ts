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
import type { CarbonEvent, SplitReceipt } from '@carbon/core';
import type { ApprovalCard } from '../cards.js';
import { type AgentContext, AgentRefusal, all, emit, gate, latest, requestApproval } from '../context.js';
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
    await ctx.budgets.spend(ctx.launchId, 'treasurer', 'devbuy-lamports', Number(solToLamports(ctx.config.devBuySol)));
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
    const { txSig, ca } = await ctx.chain.submitLaunchTx(ctx.launchId, signed);
    return emit(
      ctx,
      'treasurer',
      'launch.deployed',
      { ca, txSig, creatorWallet, devBuySol: ctx.config.devBuySol, network: ctx.chain.network },
      `Deployed $${d.ticker} on ${ctx.chain.network} after approval and Sentinel ${cleared.score.payload.score}/${cleared.score.payload.threshold}; dev buy ${ctx.config.devBuySol} SOL; fee address ${creatorWallet}.`,
    );
  }

  /** Re-run any split that has no fully confirmed receipt (idempotent on the chain side). */
  async resumeSplits(): Promise<CarbonEvent<'split.receipt'>[]> {
    const ctx = this.ctx;
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

  /** Unspent lamports on confirmed carbon-buyback legs, per split, oldest first. */
  async buybackFunds(): Promise<{ splitId: string; remaining: bigint }[]> {
    const receipts = await all(this.ctx, 'split.receipt');
    const latestBySplit = new Map<string, SplitReceipt>();
    for (const r of receipts) latestBySplit.set(r.payload.splitId, r.payload);
    const spent = new Map<string, bigint>();
    for (const b of await all(this.ctx, 'buyback.executed')) spent.set(b.payload.splitId, (spent.get(b.payload.splitId) ?? 0n) + BigInt(b.payload.lamportsIn));
    const out: { splitId: string; remaining: bigint }[] = [];
    for (const [splitId, r] of latestBySplit) {
      const funded = r.legs.filter((l) => l.to === 'carbon-buyback' && l.status === 'confirmed').reduce((s, l) => s + BigInt(l.lamports), 0n);
      const remaining = funded - (spent.get(splitId) ?? 0n);
      if (remaining > 0n) out.push({ splitId, remaining });
    }
    return out;
  }

  /** Buy $CARBON with at most buybackSolPerTick, from the 30% leg only. Needs a 'buyback' approval (or autopilot). */
  async buyback(): Promise<CarbonEvent<'buyback.executed'> | null> {
    const ctx = this.ctx;
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
    if (!again || again.remaining < amount) throw new AgentRefusal('treasurer', 'buyback funds changed while waiting; skipped');
    await ctx.approvals.consume(ctx.launchId, decision.approvalId, 'buyback');
    await ctx.budgets.spend(ctx.launchId, 'treasurer', 'buyback-lamports', Number(amount));
    const { txSig, carbonOut } = await ctx.chain.buyCarbon(amount, fund.splitId);
    return emit(
      ctx,
      'treasurer',
      'buyback.executed',
      { lamportsIn: amount.toString(), carbonOut: carbonOut.toString(), txSig, funding: 'fee-split', splitId: fund.splitId },
      `Bought ${carbonOut} base units of $CARBON for ${lamportsToSol(amount)} SOL from split ${fund.splitId.slice(0, 8)}'s 30% leg (tx ${txSig.slice(0, 8)}).`,
    );
  }
}
