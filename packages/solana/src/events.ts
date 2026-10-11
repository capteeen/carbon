/**
 * Reading receipts from confirmed transactions: Anchor events emitted by the
 * pump programs (both `emit!` log lines and `emit_cpi!` self-CPIs) and the
 * real per-account balance deltas from the transaction meta.
 */
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { PROGRAMS, type ProgramKey, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } from './programs.js';

/** Anchor's emit_cpi! instruction tag: sha256("anchor:event")[..8], little-endian 0x1d9acb512ea545e4. */
export const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export interface DecodedEvent {
  program: ProgramKey;
  name: string;
  data: Record<string, unknown>;
}

const PROGRAM_IDS: [ProgramKey, PublicKey][] = [
  ['pump', PUMP_PROGRAM_ID],
  ['amm', PUMP_AMM_PROGRAM_ID],
  ['fees', PUMP_FEE_PROGRAM_ID],
];

function decodeEventBytes(program: ProgramKey, bytes: Buffer): DecodedEvent | null {
  try {
    const ev = PROGRAMS[program].coder.events.decode(bytes.toString('base64'));
    return ev ? { program, name: ev.name, data: ev.data as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

/** All account keys of a fetched transaction, static then loaded (ALT) writable then readonly. */
export function accountKeysOf(tx: VersionedTransactionResponse): PublicKey[] {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? null });
  const out: PublicKey[] = [];
  for (let i = 0; i < keys.length; i++) out.push(keys.get(i)!);
  return out;
}

export function decodeTxEvents(tx: VersionedTransactionResponse): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  const keys = accountKeysOf(tx);
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const pid = keys[ix.programIdIndex];
      const entry = pid ? PROGRAM_IDS.find(([, id]) => id.equals(pid)) : undefined;
      if (!entry) continue;
      const data = Buffer.from(bs58.decode(ix.data));
      if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
      const ev = decodeEventBytes(entry[0], data.subarray(8));
      if (ev) out.push(ev);
    }
  }
  // emit! style: "Program data: <base64>" inside the invoking program's log span.
  const stack: string[] = [];
  for (const line of tx.meta?.logMessages ?? []) {
    const invoke = /^Program (\w+) invoke/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program (\w+) (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith('Program data: ')) {
      const current = stack[stack.length - 1];
      const entry = PROGRAM_IDS.find(([, id]) => id.toBase58() === current);
      if (!entry) continue;
      const ev = decodeEventBytes(entry[0], Buffer.from(line.slice('Program data: '.length), 'base64'));
      if (ev) out.push(ev);
    }
  }
  return out;
}

/** Lamport change of `account` in this transaction (post − pre). Throws if the account is not in it. */
export function lamportDelta(tx: VersionedTransactionResponse, account: PublicKey): bigint {
  const keys = accountKeysOf(tx);
  const i = keys.findIndex((k) => k.equals(account));
  if (i < 0 || !tx.meta) throw new Error(`account ${account.toBase58()} is not in transaction`);
  return BigInt(tx.meta.postBalances[i]!) - BigInt(tx.meta.preBalances[i]!);
}

/** Change in `owner`'s balance of `mint` (base units) across this transaction. */
export function tokenDelta(tx: VersionedTransactionResponse, owner: PublicKey, mint: PublicKey): bigint {
  const sum = (rows: NonNullable<VersionedTransactionResponse['meta']>['postTokenBalances']) =>
    (rows ?? []).filter((r) => r.owner === owner.toBase58() && r.mint === mint.toBase58()).reduce((s, r) => s + BigInt(r.uiTokenAmount.amount), 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}
