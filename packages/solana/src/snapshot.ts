/**
 * Holder snapshots producing @qsd/protocol `HolderSnapshot` rows, from chain
 * data only:
 *   balances  getProgramAccounts on SPL Token and Token-2022, memcmp mint at
 *             offset 0 (create_v2 coins are Token-2022, whose accounts vary in
 *             size, so no dataSize filter), read at a reported context slot.
 *   timing    firstAcquiredAt = block time of the most recent transaction in
 *             which the holder's token account went from 0 (or absent) to a
 *             positive balance: the start of the current unbroken holding
 *             period, found by walking that account's signatures newest-first.
 * The bonding curve and the canonical pool are excluded (they are the market,
 * not holders). Balances are those at the reported read slot (taken right
 * after the collapse moment; RPC serves no historical state), and wallets
 * whose holding began after the collapse moment are left out. Argon coins
 * have no measurements, so
 * heldThroughMeasurementIds is always [].
 */
import type { HolderSnapshot } from '@qsd/protocol';
import { AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { ChainUnavailableError } from './errors.js';
import { rpcCall, type RpcLike } from './rpc.js';
import { pumpSdk } from './sdk.js';

const { bondingCurvePda, canonicalPumpPoolPda } = pumpSdk;

export interface TokenAccountRow {
  address: string;
  owner: string;
  amount: bigint;
}

export async function tokenAccountsByMint(rpc: RpcLike, mint: PublicKey): Promise<{ rows: TokenAccountRow[]; slot: number }> {
  const rows: TokenAccountRow[] = [];
  let slot = 0;
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await rpcCall(`getProgramAccounts(${program.toBase58()})`, () =>
      rpc.getProgramAccounts(program, { commitment: 'confirmed', withContext: true, filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }] }),
    );
    slot = Math.max(slot, res.context.slot);
    for (const a of res.value) {
      if (a.account.data.length < AccountLayout.span) continue;
      const d = AccountLayout.decode(a.account.data.subarray(0, AccountLayout.span));
      if (!new PublicKey(d.mint).equals(mint)) continue;
      rows.push({ address: a.pubkey.toBase58(), owner: new PublicKey(d.owner).toBase58(), amount: BigInt(d.amount.toString()) });
    }
  }
  return { rows, slot };
}

/**
 * Start of the current unbroken holding period of one token account (unix s).
 * Walks signatures newest-first and returns the time of the latest successful
 * transaction where this account's balance rose from 0/absent to > 0.
 */
export async function holdingStartOf(rpc: RpcLike, tokenAccount: PublicKey, maxSignatures = 2000): Promise<number> {
  let before: string | undefined;
  let scanned = 0;
  for (;;) {
    const sigs = await rpcCall('getSignaturesForAddress', () => rpc.getSignaturesForAddress(tokenAccount, { limit: 100, ...(before ? { before } : {}) }, 'confirmed'));
    for (const s of sigs) {
      scanned++;
      if (s.err) continue;
      const tx = await rpcCall('getTransaction', () => rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
      if (!tx?.meta || typeof tx.blockTime !== 'number') continue;
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? null });
      let index = -1;
      for (let i = 0; i < keys.length; i++) if (keys.get(i)!.equals(tokenAccount)) index = i;
      if (index < 0) continue;
      const pre = tx.meta.preTokenBalances?.find((b) => b.accountIndex === index);
      const post = tx.meta.postTokenBalances?.find((b) => b.accountIndex === index);
      const preAmt = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
      const postAmt = post ? BigInt(post.uiTokenAmount.amount) : 0n;
      if (preAmt === 0n && postAmt > 0n) return tx.blockTime;
    }
    if (sigs.length < 100) break;
    if (scanned >= maxSignatures) throw new ChainUnavailableError(`holding start of ${tokenAccount.toBase58()} not found in ${scanned} signatures`);
    before = sigs[sigs.length - 1]!.signature;
  }
  throw new ChainUnavailableError(`no acquiring transaction found for ${tokenAccount.toBase58()}`);
}

export interface SnapshotRequest {
  mint: string;
  /** Collapse moment, unix seconds. */
  collapseAt: number;
  /** The final quiet period's start (Ar-41: last trade; Ar-39: last trade before the clock ran out), unix seconds. */
  quietPeriodStart: number;
  /** Extra owners never included (e.g. Argon's own wallets). */
  excludeOwners?: string[];
}

export interface SnapshotResult {
  slot: number;
  holders: HolderSnapshot[];
}

export async function takeHolderSnapshot(rpc: RpcLike, req: SnapshotRequest): Promise<SnapshotResult> {
  const mint = new PublicKey(req.mint);
  const { rows, slot } = await tokenAccountsByMint(rpc, mint);
  const excluded = new Set([bondingCurvePda(mint).toBase58(), canonicalPumpPoolPda(mint).toBase58(), ...(req.excludeOwners ?? [])]);
  const byOwner = new Map<string, { balance: bigint; accounts: string[] }>();
  for (const r of rows) {
    if (r.amount === 0n || excluded.has(r.owner)) continue;
    const e = byOwner.get(r.owner) ?? { balance: 0n, accounts: [] };
    e.balance += r.amount;
    e.accounts.push(r.address);
    byOwner.set(r.owner, e);
  }
  const holders: HolderSnapshot[] = [];
  for (const [wallet, e] of [...byOwner.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // A wallet with several accounts has held since the earliest of their current holding periods.
    let start = Number.POSITIVE_INFINITY;
    for (const acc of e.accounts) start = Math.min(start, await holdingStartOf(rpc, new PublicKey(acc)));
    // Acquired after the collapse moment: not a holder at collapse.
    if (start > req.collapseAt) continue;
    const firstAcquiredAt = start;
    holders.push({
      wallet,
      balance: e.balance,
      firstAcquiredAt,
      heldThroughMeasurementIds: [],
      heldThroughQuietPeriod: firstAcquiredAt <= req.quietPeriodStart,
    });
  }
  return { slot, holders };
}
