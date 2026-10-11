/**
 * Building, signing and durably sending transactions.
 *
 * The durable send protocol every ledger row follows:
 *   1. pending  : nothing signed yet. Build, sign locally; the signature is known.
 *   2. sent     : signature, raw signed bytes and lastValidBlockHeight are written
 *                 to Postgres BEFORE the bytes are broadcast.
 *   3. confirmed: the chain reports the signature confirmed without error.
 * On resume a 'sent' row is resolved by asking the chain about that exact
 * signature: confirmed -> done; failed -> back to pending (nothing moved);
 * not found and the block height is past lastValidBlockHeight -> it can never
 * land -> back to pending; not found but still valid -> rebroadcast the same
 * bytes and keep waiting. A leg is therefore paid at most once.
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { Db } from './db.js';
import { LedgerError, TxFailedError, errorMessage } from './errors.js';
import { rpcCall, type RpcLike } from './rpc.js';

/** Max serialized transaction size (one packet). */
export const PACKET_DATA_SIZE = 1232;

export interface SignedTx {
  sig: string;
  raw: Uint8Array;
  lastValidBlockHeight: number;
}

export interface CompileArgs {
  rpc: RpcLike;
  payer: PublicKey;
  instructions: TransactionInstruction[];
  signers: Keypair[];
  lookupTables?: AddressLookupTableAccount[];
  priorityFeeMicroLamports?: number;
  computeUnits?: number;
}

export function withComputeBudget(ixs: TransactionInstruction[], opts: { priorityFeeMicroLamports?: number; computeUnits?: number }): TransactionInstruction[] {
  const pre: TransactionInstruction[] = [];
  if (opts.computeUnits) pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits }));
  if (opts.priorityFeeMicroLamports && opts.priorityFeeMicroLamports > 0) {
    pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityFeeMicroLamports }));
  }
  return [...pre, ...ixs];
}

export async function compileAndSign(a: CompileArgs): Promise<SignedTx> {
  const { blockhash, lastValidBlockHeight } = await rpcCall('getLatestBlockhash', () => a.rpc.getLatestBlockhash('confirmed'));
  const msg = new TransactionMessage({
    payerKey: a.payer,
    recentBlockhash: blockhash,
    instructions: withComputeBudget(a.instructions, a),
  }).compileToV0Message(a.lookupTables ?? []);
  const tx = new VersionedTransaction(msg);
  tx.sign(a.signers);
  const raw = tx.serialize();
  if (raw.length > PACKET_DATA_SIZE) throw new TxFailedError(`transaction is ${raw.length} bytes, over the ${PACKET_DATA_SIZE}-byte limit`);
  const first = tx.signatures[0];
  if (!first || first.every((b) => b === 0)) throw new TxFailedError('fee payer did not sign');
  return { sig: bs58.encode(first), raw, lastValidBlockHeight };
}

export type FinalStatus = 'confirmed' | 'failed' | 'expired';

export interface PollOptions {
  pollMs: number;
  maxPolls: number;
  /** Rebroadcast the stored bytes every n polls while the signature is unknown. */
  rebroadcastEvery: number;
}
export const DEFAULT_POLL: PollOptions = { pollMs: 1500, maxPolls: 80, rebroadcastEvery: 4 };

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** One look at a signature. 'unknown' = not found yet and still within its blockhash validity. */
export async function signatureStatus(rpc: RpcLike, sig: string, lastValidBlockHeight: number): Promise<{ status: FinalStatus | 'unknown'; err?: string }> {
  const lookup = async () => {
    const r = await rpcCall('getSignatureStatuses', () => rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }));
    return r.value[0] ?? null;
  };
  const s = await lookup();
  if (s) {
    if (s.err) return { status: 'failed', err: JSON.stringify(s.err) };
    if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return { status: 'confirmed' };
    return { status: 'unknown' };
  }
  const height = await rpcCall('getBlockHeight', () => rpc.getBlockHeight('confirmed'));
  if (height > lastValidBlockHeight) {
    // Re-check after reading the height: a tx that landed just before expiry must not be missed.
    const again = await lookup();
    if (again) return again.err ? { status: 'failed', err: JSON.stringify(again.err) } : { status: 'unknown' };
    return { status: 'expired' };
  }
  return { status: 'unknown' };
}

export async function waitForFinal(rpc: RpcLike, sig: string, raw: Uint8Array, lastValidBlockHeight: number, poll: PollOptions): Promise<{ status: FinalStatus; err?: string }> {
  for (let i = 0; i < poll.maxPolls; i++) {
    const s = await signatureStatus(rpc, sig, lastValidBlockHeight);
    if (s.status !== 'unknown') return s as { status: FinalStatus; err?: string };
    if (i > 0 && i % poll.rebroadcastEvery === 0) {
      await rpc.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
    await sleep(poll.pollMs);
  }
  throw new TxFailedError(`signature ${sig} not final yet; the row stays 'sent' and resumes on the next call`);
}

function isPreflightRejection(e: unknown): boolean {
  return e instanceof Error && (e.name === 'SendTransactionError' || /simulation failed/i.test(e.message));
}

export interface TxRowRef {
  table: 'sol_claims' | 'split_ledger' | 'sol_buybacks' | 'sol_airdrops';
  /** Primary-key columns and values. Column names are fixed literals from this package, never user input. */
  key: Record<string, string>;
}

interface TxRow {
  state: 'pending' | 'sent' | 'confirmed';
  tx_sig: string | null;
  raw_tx: string | null;
  lvbh: string | null;
}

function whereClause(key: Record<string, string>, offset: number): { sql: string; params: string[] } {
  const cols = Object.keys(key);
  for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new LedgerError(`bad key column ${c}`);
  return { sql: cols.map((c, i) => `${c} = $${i + offset}`).join(' AND '), params: cols.map((c) => key[c]!) };
}

export async function readTxRow(db: Db, ref: TxRowRef): Promise<TxRow | null> {
  const w = whereClause(ref.key, 1);
  const r = await db.query<TxRow>(`SELECT state, tx_sig, raw_tx, lvbh::text AS lvbh FROM ${ref.table} WHERE ${w.sql}`, w.params);
  return r.rows[0] ?? null;
}

/**
 * Drive one ledger row to 'confirmed', following the protocol above. `build`
 * is called only when the row is 'pending'. Returns the confirmed signature
 * and whether this call broadcast a new transaction.
 */
export async function driveTxRow(db: Db, rpc: RpcLike, ref: TxRowRef, build: () => Promise<SignedTx>, poll: PollOptions = DEFAULT_POLL): Promise<{ sig: string; fresh: boolean }> {
  const w = whereClause(ref.key, 1);
  let fresh = false;
  for (let round = 0; round < 3; round++) {
    const row = await readTxRow(db, ref);
    if (!row) throw new LedgerError(`${ref.table} row not found`);
    if (row.state === 'confirmed') {
      if (!row.tx_sig) throw new LedgerError(`${ref.table} row confirmed without a signature`);
      return { sig: row.tx_sig, fresh };
    }
    if (row.state === 'sent') {
      if (!row.tx_sig || !row.raw_tx || row.lvbh === null) throw new LedgerError(`${ref.table} row 'sent' without signature/bytes`);
      const raw = Uint8Array.from(Buffer.from(row.raw_tx, 'base64'));
      const r = await waitForFinal(rpc, row.tx_sig, raw, Number(row.lvbh), poll);
      if (r.status === 'confirmed') {
        await db.query(`UPDATE ${ref.table} SET state = 'confirmed', last_error = NULL, updated_at = now() WHERE ${w.sql} AND state = 'sent' AND tx_sig = $${w.params.length + 1}`, [...w.params, row.tx_sig]);
        return { sig: row.tx_sig, fresh };
      }
      await db.query(
        `UPDATE ${ref.table} SET state = 'pending', tx_sig = NULL, raw_tx = NULL, lvbh = NULL, last_error = $${w.params.length + 2}, updated_at = now() WHERE ${w.sql} AND state = 'sent' AND tx_sig = $${w.params.length + 1}`,
        [...w.params, row.tx_sig, r.status === 'failed' ? `failed on chain: ${r.err ?? ''}` : 'expired before landing'],
      );
      if (r.status === 'failed') throw new TxFailedError(`${ref.table} transaction ${row.tx_sig} failed on chain: ${r.err ?? 'unknown error'}`);
      continue; // expired: nothing moved; rebuild
    }
    // pending
    const signed = await build();
    const upd = await db.query(
      `UPDATE ${ref.table} SET state = 'sent', tx_sig = $${w.params.length + 1}, raw_tx = $${w.params.length + 2}, lvbh = $${w.params.length + 3}, attempts = attempts + 1, updated_at = now() WHERE ${w.sql} AND state = 'pending'`,
      [...w.params, signed.sig, Buffer.from(signed.raw).toString('base64'), signed.lastValidBlockHeight],
    );
    if (upd.rowCount !== 1) throw new LedgerError(`${ref.table} row changed under us; refusing to broadcast`);
    fresh = true;
    try {
      await rpc.sendRawTransaction(signed.raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 });
    } catch (e) {
      if (isPreflightRejection(e)) {
        // Rejected in preflight: the node did not forward it, so it cannot land. Safe to reset.
        await db.query(
          `UPDATE ${ref.table} SET state = 'pending', tx_sig = NULL, raw_tx = NULL, lvbh = NULL, last_error = $${w.params.length + 2}, updated_at = now() WHERE ${w.sql} AND tx_sig = $${w.params.length + 1}`,
          [...w.params, signed.sig, `preflight: ${errorMessage(e)}`],
        );
        throw new TxFailedError(`${ref.table} transaction rejected in preflight: ${errorMessage(e)}`, { cause: e });
      }
      throw e; // unknown whether it reached the network: the row stays 'sent' and resumes by signature
    }
  }
  throw new LedgerError(`${ref.table} row did not settle after 3 rounds`);
}
