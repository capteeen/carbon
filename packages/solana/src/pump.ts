/**
 * pump.fun instruction builders on the official @pump-fun/pump-sdk /
 * @pump-fun/pump-swap-sdk. Pure where possible (state in, instructions out);
 * the online helpers take an RpcLike.
 */
import type { BondingCurve, FeeConfig, Global, OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { pumpSdk, pumpSwapSdk } from './sdk.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { FEE_SPLIT_BPS } from '@carbon/core';
import type { Share, TxPurpose } from './allowlist.js';
import { ChainConfigError, ChainUnavailableError } from './errors.js';
import { asConnection, rpcCall, type RpcLike } from './rpc.js';

const {
  bondingCurvePda,
  canonicalPumpPoolPda,
  feeSharingConfigPda,
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getFeeRecipient,
  newBondingCurve,
  PUMP_SDK,
} = pumpSdk;
const { OnlinePumpAmmSdk, PUMP_AMM_SDK } = pumpSwapSdk;

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** SOL (config number) to lamports, exact for the 9-decimal config values. */
export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol < 0) throw new ChainConfigError(`invalid SOL amount ${sol}`);
  return BigInt(Math.round(sol * 1e9));
}

/** The on-chain 50/30/20 shareholder list, in the order update_fee_shares stores it. */
export function carbonShares(launcher: PublicKey, buyback: PublicKey, treasury: PublicKey): Share[] {
  const shares: Share[] = [
    { address: launcher, bps: FEE_SPLIT_BPS.launcher },
    { address: buyback, bps: FEE_SPLIT_BPS.carbonBuyback },
    { address: treasury, bps: FEE_SPLIT_BPS.treasury },
  ];
  const total = shares.reduce((s, x) => s + x.bps, 0);
  if (total !== 10_000) throw new ChainConfigError(`fee split sums to ${total} bps, not 10000`);
  const uniq = new Set(shares.map((s) => s.address.toBase58()));
  if (uniq.size !== shares.length) throw new ChainConfigError('launcher, buyback and treasury wallets must all differ (pump-fees refuses duplicates)');
  return shares;
}

/** Fee recipient for a SOL-curve buy: first non-zero Global.buybackFeeRecipients entry (deterministic). */
export function buybackFeeRecipient(global: Global): PublicKey {
  const r = global.buybackFeeRecipients.find((k) => !k.equals(PublicKey.default));
  if (!r) throw new ChainUnavailableError('pump Global lists no buyback fee recipient');
  return r;
}

function deterministicFeeRecipient(global: Global): PublicKey {
  const r = [global.feeRecipient, ...global.feeRecipients].find((k) => !k.equals(PublicKey.default));
  return r ?? getFeeRecipient(global, false);
}

/**
 * Tokens for a first buy on a fresh curve whose creator is `creator`, such
 * that the SDK's own quote of the cost is <= maxLamports. The creator matters:
 * the creator fee is charged only when the curve has one.
 */
export function devBuyTokenAmount(global: Global, feeConfig: FeeConfig | null, creator: PublicKey, maxLamports: bigint): BN {
  const curve: BondingCurve = { ...newBondingCurve(global, PublicKey.default), creator };
  const lamports = new BN(maxLamports.toString());
  const quote = (amount: BN) =>
    getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply: global.tokenTotalSupply, bondingCurve: curve, amount, quoteMint: NATIVE_MINT });
  let amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: global.tokenTotalSupply, bondingCurve: curve, amount: lamports, quoteMint: NATIVE_MINT });
  for (let i = 0; i < 20 && amount.gtn(0) && quote(amount).gt(lamports); i++) {
    amount = amount.muln(999).divn(1000);
  }
  if (amount.lten(0) || quote(amount).gt(lamports)) throw new ChainConfigError('could not quote a dev buy within the cap');
  return amount;
}

export interface LaunchIxArgs {
  global: Global;
  feeConfig: FeeConfig | null;
  mint: PublicKey;
  /** The user's wallet: signs and pays. */
  payer: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  devBuyLamports: bigint;
}

export interface BuiltLaunch {
  instructions: TransactionInstruction[];
  purpose: Extract<TxPurpose, { kind: 'launch' }>;
  /** The coin's creator after this transaction. */
  feeRecipient: PublicKey;
}

/**
 * Native mode, one transaction:
 *   create_v2(creator = payer) → create_fee_sharing_config (payer) →
 *   update_fee_shares([launcher 5000, buyback 3000, treasury 2000]) →
 *   payer's Token-2022 ATA → dev buy (creator vault = the sharing config's).
 */
export async function buildNativeLaunchIxs(
  a: LaunchIxArgs & { buybackWallet: PublicKey; treasuryWallet: PublicKey; /** Who gets the 50% launcher share; defaults to the payer. Daughters pass the mother's launcher. */ shareLauncher?: PublicKey },
): Promise<BuiltLaunch> {
  const shares = carbonShares(a.shareLauncher ?? a.payer, a.buybackWallet, a.treasuryWallet);
  const sharing = feeSharingConfigPda(a.mint);
  const create = await PUMP_SDK.createV2Instruction({ mint: a.mint, name: a.name, symbol: a.symbol, uri: a.uri, creator: a.payer, user: a.payer, mayhemMode: false });
  const cfg = await PUMP_SDK.createFeeSharingConfig({ creator: a.payer, mint: a.mint, pool: null });
  const upd = await PUMP_SDK.updateFeeShares({
    authority: a.payer,
    mint: a.mint,
    currentShareholders: [a.payer],
    newShareholders: shares.map((s) => ({ address: s.address, shareBps: s.bps })),
    bondingCurveComplete: false,
  });
  const buy = await devBuyIxs(a, sharing);
  return {
    instructions: [create, cfg, upd, ...buy],
    purpose: { kind: 'launch', mint: a.mint, creator: a.payer, payer: a.payer, devBuyMaxLamports: a.devBuyLamports, shares },
    feeRecipient: sharing,
  };
}

/** Wallet mode: create_v2(creator = per-launch wallet, user = payer) → ATA → dev buy. */
export async function buildWalletLaunchIxs(a: LaunchIxArgs & { creator: PublicKey }): Promise<BuiltLaunch> {
  const create = await PUMP_SDK.createV2Instruction({ mint: a.mint, name: a.name, symbol: a.symbol, uri: a.uri, creator: a.creator, user: a.payer, mayhemMode: false });
  const buy = await devBuyIxs(a, a.creator);
  return {
    instructions: [create, ...buy],
    purpose: { kind: 'launch', mint: a.mint, creator: a.creator, payer: a.payer, devBuyMaxLamports: a.devBuyLamports, shares: null },
    feeRecipient: a.creator,
  };
}

async function devBuyIxs(a: LaunchIxArgs, curveCreator: PublicKey): Promise<TransactionInstruction[]> {
  if (a.devBuyLamports <= 0n) return [];
  const ata = getAssociatedTokenAddressSync(a.mint, a.payer, true, TOKEN_2022_PROGRAM_ID);
  const amount = devBuyTokenAmount(a.global, a.feeConfig, curveCreator, a.devBuyLamports);
  const buy = await PUMP_SDK.getBuyInstructionRaw({
    user: a.payer,
    mint: a.mint,
    creator: curveCreator,
    amount,
    solAmount: new BN(a.devBuyLamports.toString()), // max_sol_cost: never more than the config's devBuySol
    feeRecipient: deterministicFeeRecipient(a.global),
    buybackFeeRecipient: buybackFeeRecipient(a.global),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  return [createAssociatedTokenAccountIdempotentInstruction(a.payer, ata, a.payer, a.mint, TOKEN_2022_PROGRAM_ID), buy];
}

/** Every static account of a launch transaction, for the owner's address lookup table. */
export function launchLookupAddresses(sample: TransactionInstruction[], mint: PublicKey, payer: PublicKey): PublicKey[] {
  const skip = new Set([mint.toBase58(), payer.toBase58(), feeSharingConfigPda(mint).toBase58(), bondingCurvePda(mint).toBase58()]);
  const out = new Map<string, PublicKey>();
  for (const ix of sample) {
    out.set(ix.programId.toBase58(), ix.programId);
    for (const k of ix.keys) if (!k.isSigner && !skip.has(k.pubkey.toBase58())) out.set(k.pubkey.toBase58(), k.pubkey);
  }
  return [...out.values()];
}

// ───────────────────────────── online helpers ─────────────────────────────

export function onlinePump(rpc: RpcLike): OnlinePumpSdk {
  return new pumpSdk.OnlinePumpSdk(asConnection(rpc));
}

export async function fetchLaunchState(rpc: RpcLike): Promise<{ global: Global; feeConfig: FeeConfig | null }> {
  const sdk = onlinePump(rpc);
  const global = await rpcCall('pump Global', () => sdk.fetchGlobal());
  const feeConfig = await sdk.fetchFeeConfig().catch(() => null);
  return { global, feeConfig };
}

/** Native crank: sweeps (if any) + transfer_creator_fees_to_pump (if graduated) + distribute_creator_fees. */
export async function buildCrankIxs(rpc: RpcLike, mint: PublicKey, payer: PublicKey): Promise<{ instructions: TransactionInstruction[]; canDistribute: boolean; distributable: bigint }> {
  const sdk = onlinePump(rpc);
  const min = await rpcCall('getMinimumDistributableFee', () => sdk.getMinimumDistributableFee(mint, payer, { payer }));
  if (!min.canDistribute) return { instructions: [], canDistribute: false, distributable: BigInt(min.distributableFees.toString()) };
  const r = await rpcCall('buildDistributeCreatorFeesInstructions', () => sdk.buildDistributeCreatorFeesInstructions(mint, { payer }));
  return { instructions: r.instructions, canDistribute: true, distributable: BigInt(min.distributableFees.toString()) };
}

/** Wallet mode claim: sweep the curve bucket if non-zero, then collect from both programs to the creator. */
export async function buildClaimIxs(rpc: RpcLike, mint: PublicKey, creator: PublicKey, payer: PublicKey): Promise<{ instructions: TransactionInstruction[]; pending: bigint }> {
  const sdk = onlinePump(rpc);
  const vault = BigInt((await rpcCall('getCreatorVaultBalanceBothPrograms', () => sdk.getCreatorVaultBalanceBothPrograms(creator))).toString());
  const curveInfo = await rpcCall('bonding curve', () => rpc.getAccountInfo(bondingCurvePda(mint)));
  const curve = curveInfo ? PUMP_SDK.decodeBondingCurve(curveInfo) : null;
  const bucket = curve ? BigInt(curve.creatorFee.toString()) : 0n;
  const pending = vault + bucket;
  if (pending === 0n) return { instructions: [], pending };
  const ixs: TransactionInstruction[] = [];
  if (bucket > 0n) ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer, mint, creator, quoteMint: NATIVE_MINT }));
  ixs.push(...(await rpcCall('collectCoinCreatorFeeInstructions', () => sdk.collectCoinCreatorFeeInstructions(creator, payer))));
  return { instructions: ixs, pending };
}

/**
 * $CARBON buy for at most `maxLamports`: on the bonding curve while it is
 * live, on the canonical PumpSwap pool once it has graduated.
 */
export async function buildCarbonBuyIxs(rpc: RpcLike, carbonMint: PublicKey, buyer: PublicKey, maxLamports: bigint): Promise<{ instructions: TransactionInstruction[]; venue: 'curve' | 'pumpswap' }> {
  const sdk = onlinePump(rpc);
  const curveInfo = await rpcCall('$CARBON bonding curve', () => rpc.getAccountInfo(bondingCurvePda(carbonMint)));
  const curve = curveInfo ? PUMP_SDK.decodeBondingCurve(curveInfo) : null;
  if (curve && !curve.complete) {
    const { global, feeConfig } = await fetchLaunchState(rpc);
    const tokenProgram = (await rpcCall('$CARBON mint', () => rpc.getAccountInfo(carbonMint)))?.owner ?? TOKEN_2022_PROGRAM_ID;
    const state = await rpcCall('fetchBuyState', () => sdk.fetchBuyState(carbonMint, buyer, tokenProgram));
    const lamports = new BN(maxLamports.toString());
    let amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: state.bondingCurve.tokenTotalSupply, bondingCurve: state.bondingCurve, amount: lamports, quoteMint: NATIVE_MINT });
    amount = amount.muln(99).divn(100); // 1% price-move room; max_sol_cost stays maxLamports
    const ata = getAssociatedTokenAddressSync(carbonMint, buyer, true, tokenProgram);
    const buy = await PUMP_SDK.getBuyInstructionRaw({
      user: buyer,
      mint: carbonMint,
      creator: state.bondingCurve.creator,
      amount,
      solAmount: lamports,
      feeRecipient: deterministicFeeRecipient(global),
      buybackFeeRecipient: buybackFeeRecipient(global),
      tokenProgram,
    });
    return { instructions: [createAssociatedTokenAccountIdempotentInstruction(buyer, ata, buyer, carbonMint, tokenProgram), buy], venue: 'curve' };
  }
  const amm = new OnlinePumpAmmSdk(asConnection(rpc));
  const pool = canonicalPumpPoolPda(carbonMint);
  const state = await rpcCall('PumpSwap swap state', () => amm.swapSolanaState(pool, buyer));
  // buyQuoteInput caps the spend at quote × (1 + slippage%): size the quote so the cap is maxLamports.
  const slippagePct = 1;
  const quote = new BN(((maxLamports * 100n) / 101n).toString());
  const ixs = await PUMP_AMM_SDK.buyQuoteInput(state, quote, slippagePct);
  return { instructions: ixs, venue: 'pumpswap' };
}
