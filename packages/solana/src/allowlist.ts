/**
 * The Treasurer trade allowlist (SPEC §2: "Treasurer never trades anything
 * except $ARGON buybacks and the launch's own dev buy").
 *
 * Every transaction this package builds passes through `assertAllowed` with
 * the purpose it was built for. An instruction is accepted only if its
 * program and instruction are listed for that purpose AND its accounts and
 * arguments match the purpose (right mint, right creator, cost under the cap,
 * exact 50/30/20 shares, transfers only to the split recipients). Sells, any
 * other mint, and every unknown program are refused.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { TradeNotAllowedError } from './errors.js';
import { decodePumpIx, type DecodedPumpIx } from './programs.js';

export interface Share {
  address: PublicKey;
  bps: number;
}

export type TxPurpose =
  /** create_v2 (+ native fee-sharing setup) + the launch's own dev buy. */
  | { kind: 'launch'; mint: PublicKey; creator: PublicKey; payer: PublicKey; devBuyMaxLamports: bigint; shares: Share[] | null }
  /** Permissionless distribution crank for a fee-shared coin. */
  | { kind: 'crank'; mint: PublicKey }
  /** Wallet mode: collect a per-launch creator's fees. */
  | { kind: 'claim'; mint: PublicKey; creator: PublicKey }
  /** Wallet mode: one leg of the 50/30/20 split. */
  | { kind: 'split'; from: PublicKey; recipients: PublicKey[] }
  /** $ARGON buyback funded by the buyback leg. */
  | { kind: 'buyback'; argonMint: PublicKey; buyer: PublicKey; maxLamports: bigint }
  /** Daughter airdrop: transfers of the daughter mint only. */
  | { kind: 'airdrop'; mint: PublicKey; from: PublicKey };

const BUY_COST_ARG: Record<string, string> = {
  // pump bonding curve
  buy: 'maxSolCost',
  buyV2: 'maxSolCost',
  buyV3: 'maxSolCost',
  buyExactSolIn: 'spendableSolIn',
  buyExactQuoteInV2: 'spendableQuoteIn',
  buyExactQuoteInV3: 'spendableQuoteIn',
};
const AMM_BUY_COST_ARG: Record<string, string> = {
  buy: 'maxQuoteAmountIn',
  buyV2: 'maxQuoteAmountIn',
  buyExactQuoteIn: 'spendableQuoteIn',
  buyExactQuoteInV2: 'spendableQuoteIn',
};

function refuse(msg: string): never {
  throw new TradeNotAllowedError(`trade allowlist: ${msg}`);
}

function bnArg(d: DecodedPumpIx, name: string): bigint {
  const v = d.data[name];
  if (!(v instanceof BN)) refuse(`${d.program}.${d.name} has no numeric ${name}`);
  return BigInt(v.toString());
}

function eq(a: PublicKey, b: PublicKey, what: string): void {
  if (!a.equals(b)) refuse(`${what}: ${a.toBase58()} is not ${b.toBase58()}`);
}

/** The pump bonding-curve mint account of a buy: `mint` on v1 builders, `baseMint` on v2/v3. */
function curveBuyMint(d: DecodedPumpIx): PublicKey {
  try {
    return d.account('mint');
  } catch {
    return d.account('baseMint');
  }
}

function checkPump(d: DecodedPumpIx, p: TxPurpose): void {
  const n = d.name;
  if (n === 'createV2') {
    if (p.kind !== 'launch') refuse(`create_v2 outside a launch`);
    eq(d.account('mint'), p.mint, 'create_v2 mint');
    eq(d.account('user'), p.payer, 'create_v2 user');
    eq(d.data['creator'] as PublicKey, p.creator, 'create_v2 creator');
    if (d.data['isMayhemMode'] !== false) refuse('mayhem mode is not used by Argon');
    const opt = (k: string) => (d.data[k] as { 0?: unknown } | null)?.[0];
    if (opt('isCashbackEnabled') === true) refuse('cashback coins are deprecated');
    if (opt('isHolderReward') === true) refuse('holder-reward coins pay holders, not the split');
    return;
  }
  if (n in BUY_COST_ARG) {
    const cost = bnArg(d, BUY_COST_ARG[n]!);
    const mint = curveBuyMint(d);
    const user = d.account('user');
    if (p.kind === 'launch') {
      eq(mint, p.mint, 'dev buy mint');
      eq(user, p.payer, 'dev buy user');
      if (cost > p.devBuyMaxLamports) refuse(`dev buy cost ${cost} exceeds the config cap ${p.devBuyMaxLamports}`);
      return;
    }
    if (p.kind === 'buyback') {
      eq(mint, p.argonMint, 'buyback mint must be $ARGON');
      eq(user, p.buyer, 'buyback user');
      if (cost > p.maxLamports) refuse(`buyback cost ${cost} exceeds ${p.maxLamports}`);
      return;
    }
    refuse(`buy outside a launch or $ARGON buyback`);
  }
  if (n === 'sweepCreatorFee') {
    if (p.kind !== 'crank' && p.kind !== 'claim') refuse('sweep outside a crank/claim');
    eq(d.account('baseMint'), p.mint, 'sweep mint');
    return;
  }
  if (n === 'distributeCreatorFees' || n === 'distributeCreatorFeesV2') {
    if (p.kind !== 'crank') refuse('distribute outside a crank');
    eq(d.account('mint'), p.mint, 'distribute mint');
    return;
  }
  if (n === 'collectCreatorFee' || n === 'collectCreatorFeeV2') {
    if (p.kind !== 'claim') refuse('collect outside a claim');
    eq(d.account('creator'), p.creator, 'collect creator');
    return;
  }
  refuse(`pump.${n} is not on the allowlist`);
}

function checkAmm(d: DecodedPumpIx, p: TxPurpose): void {
  const n = d.name;
  if (n in AMM_BUY_COST_ARG) {
    if (p.kind !== 'buyback') refuse('PumpSwap buy outside a $ARGON buyback');
    eq(d.account('baseMint'), p.argonMint, 'PumpSwap buy mint must be $ARGON');
    eq(d.account('user'), p.buyer, 'PumpSwap buy user');
    const cost = bnArg(d, AMM_BUY_COST_ARG[n]!);
    if (cost > p.maxLamports) refuse(`PumpSwap buy cost ${cost} exceeds ${p.maxLamports}`);
    return;
  }
  if (n === 'initUserVolumeAccumulator' || n === 'syncUserVolumeAccumulator') {
    if (p.kind !== 'buyback') refuse(`${n} outside a buyback`);
    return;
  }
  if (n === 'transferCreatorFeesToPump' || n === 'transferCreatorFeesToPumpV2' || n === 'sweepCreatorFee') {
    if (p.kind !== 'crank' && p.kind !== 'claim') refuse(`${n} outside a crank/claim`);
    return;
  }
  if (n === 'collectCoinCreatorFee') {
    if (p.kind !== 'claim') refuse('collect_coin_creator_fee outside a claim');
    eq(d.account('coinCreator'), p.creator, 'collect coin creator');
    return;
  }
  refuse(`pump-amm.${n} is not on the allowlist`);
}

function checkFees(d: DecodedPumpIx, p: TxPurpose): void {
  if (p.kind !== 'launch' || !p.shares) refuse(`pump-fees.${d.name} outside a native fee-sharing launch`);
  if (d.name === 'createFeeSharingConfig') {
    eq(d.account('mint'), p.mint, 'sharing config mint');
    eq(d.account('payer'), p.creator, 'sharing config payer must be the creator');
    return;
  }
  if (d.name === 'updateFeeShares') {
    eq(d.account('mint'), p.mint, 'update_fee_shares mint');
    eq(d.account('authority'), p.creator, 'update_fee_shares authority');
    const got = d.data['shareholders'] as { address: PublicKey; shareBps: number }[];
    const want = p.shares;
    if (!Array.isArray(got) || got.length !== want.length) refuse('shareholder list differs from the 50/30/20 split');
    got.forEach((g, i) => {
      eq(g.address, want[i]!.address, `shareholder ${i}`);
      if (g.shareBps !== want[i]!.bps) refuse(`shareholder ${i} has ${g.shareBps} bps, expected ${want[i]!.bps}`);
    });
    return;
  }
  refuse(`pump-fees.${d.name} is not on the allowlist`);
}

function checkSystem(ix: TransactionInstruction, p: TxPurpose): void {
  const kind = ix.data.length >= 4 ? ix.data.readUInt32LE(0) : -1;
  if (kind !== 2) refuse(`system instruction ${kind} is not on the allowlist`);
  const from = ix.keys[0]?.pubkey;
  const to = ix.keys[1]?.pubkey;
  if (!from || !to) refuse('malformed system transfer');
  if (p.kind === 'split') {
    eq(from, p.from, 'split transfer source');
    if (!p.recipients.some((r) => r.equals(to))) refuse(`split transfer to ${to.toBase58()} is not a split recipient`);
    return;
  }
  if (p.kind === 'buyback') {
    eq(from, p.buyer, 'wrap source');
    eq(to, getAssociatedTokenAddressSync(NATIVE_MINT, p.buyer, true, TOKEN_PROGRAM_ID), 'wrap target must be the buyer WSOL account');
    const lamports = ix.data.length >= 12 ? ix.data.readBigUInt64LE(4) : 0n;
    if (lamports > p.maxLamports) refuse(`wrap of ${lamports} exceeds ${p.maxLamports}`);
    return;
  }
  refuse(`system transfer outside a split or buyback`);
}

function checkToken(ix: TransactionInstruction, p: TxPurpose): void {
  const t = ix.data[0];
  if (p.kind === 'buyback' && (t === 17 /* SyncNative */ || t === 9 /* CloseAccount */)) {
    // Only the buyer's own WSOL account.
    eq(ix.keys[0]!.pubkey, getAssociatedTokenAddressSync(NATIVE_MINT, p.buyer, true, TOKEN_PROGRAM_ID), 'token account');
    if (t === 9) eq(ix.keys[1]!.pubkey, p.buyer, 'close destination');
    return;
  }
  if (p.kind === 'airdrop' && t === 12 /* TransferChecked */) {
    eq(ix.keys[1]!.pubkey, p.mint, 'airdrop mint');
    eq(ix.keys[3]!.pubkey, p.from, 'airdrop authority');
    return;
  }
  refuse(`token instruction ${String(t)} is not on the allowlist for ${p.kind}`);
}

function checkAta(ix: TransactionInstruction, p: TxPurpose): void {
  // create / create_idempotent: [payer, ata, owner, mint, system, token]
  const mint = ix.keys[3]?.pubkey;
  if (!mint) refuse('malformed ATA instruction');
  const allowed: PublicKey[] = [NATIVE_MINT];
  if (p.kind === 'launch' || p.kind === 'crank' || p.kind === 'claim' || p.kind === 'airdrop') allowed.push(p.mint);
  if (p.kind === 'buyback') allowed.push(p.argonMint);
  if (!allowed.some((m) => m.equals(mint))) refuse(`ATA for mint ${mint.toBase58()} not allowed for ${p.kind}`);
}

/** Throws TradeNotAllowedError on the first instruction outside the allowlist for `purpose`. */
export function assertAllowed(instructions: readonly TransactionInstruction[], purpose: TxPurpose): void {
  if (instructions.length === 0) refuse('empty transaction');
  for (const ix of instructions) {
    const pid = ix.programId;
    if (pid.equals(ComputeBudgetProgram.programId)) continue;
    if (pid.equals(SystemProgram.programId)) {
      checkSystem(ix, purpose);
      continue;
    }
    if (pid.equals(TOKEN_PROGRAM_ID) || pid.equals(TOKEN_2022_PROGRAM_ID)) {
      checkToken(ix, purpose);
      continue;
    }
    if (pid.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      checkAta(ix, purpose);
      continue;
    }
    const d = decodePumpIx(ix);
    if (!d) refuse(`program ${pid.toBase58()} is not on the allowlist`);
    if (d.program === 'pump') checkPump(d, purpose);
    else if (d.program === 'amm') checkAmm(d, purpose);
    else checkFees(d, purpose);
  }
}
