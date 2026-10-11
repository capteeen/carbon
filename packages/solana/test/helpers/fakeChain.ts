/**
 * TEST DOUBLE ONLY. An in-memory Solana-like ledger implementing the RpcLike
 * slice: it deserializes the real signed transactions this package builds,
 * applies system transfers (and test-supplied effects), and answers
 * signature/transaction queries. Fault switches simulate crashes and drops.
 * Never imported from src/.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type AccountInfo,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { RpcLike } from '../../src/rpc.js';

export interface TokenBal {
  accountIndex: number;
  mint: string;
  owner: string;
  amount: bigint;
}

export interface Effect {
  logs?: string[];
  innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[];
  preTokenBalances?: TokenBal[];
  postTokenBalances?: TokenBal[];
  err?: unknown;
}

export interface Landed {
  sig: string;
  tx: VersionedTransaction;
  slot: number;
  blockTime: number;
  keys: PublicKey[];
  pre: number[];
  post: number[];
  effect: Effect;
}

export class FakeChain {
  height = 1000;
  slot = 5000;
  time = 1_800_000_000;
  balances = new Map<string, bigint>();
  accounts = new Map<string, AccountInfo<Buffer>>();
  landed = new Map<string, Landed>();
  /** Every system transfer applied, in order. */
  transfers: { from: string; to: string; lamports: bigint; sig: string }[] = [];
  sends = 0;
  /** Fault switches, consumed when hit. */
  faults: { throwBeforeSend?: number; throwAfterSend?: number; dropSends?: number; statusThrows?: number } = {};
  /** Optional per-transaction effect (events, token balances). */
  onTx?: (tx: VersionedTransaction, ixs: TransactionInstruction[], keys: PublicKey[]) => Effect | void;
  /** Signature listings for getSignaturesForAddress, newest first. */
  signatures = new Map<string, { signature: string; blockTime: number; err: null; slot: number }[]>();
  programAccounts = new Map<string, { pubkey: PublicKey; account: AccountInfo<Buffer> }[]>();

  balance(addr: PublicKey | string): bigint {
    return this.balances.get(typeof addr === 'string' ? addr : addr.toBase58()) ?? 0n;
  }
  fund(addr: PublicKey, lamports: bigint): void {
    this.balances.set(addr.toBase58(), this.balance(addr) + lamports);
  }

  private apply(raw: Uint8Array): void {
    const tx = VersionedTransaction.deserialize(raw);
    const sig = bs58.encode(tx.signatures[0]!);
    if (this.landed.has(sig)) return; // the same signature lands once
    const msg = tx.message;
    const keys = msg.staticAccountKeys;
    const ixs: TransactionInstruction[] = msg.compiledInstructions.map((ci) => ({
      programId: keys[ci.programIdIndex]!,
      keys: ci.accountKeyIndexes.map((i) => ({ pubkey: keys[i]!, isSigner: msg.isAccountSigner(i), isWritable: msg.isAccountWritable(i) })),
      data: Buffer.from(ci.data),
    }));
    const pre = keys.map((k) => Number(this.balance(k)));
    const effect = this.onTx?.(tx, ixs, keys) ?? {};
    if (!effect.err) {
      for (const ix of ixs) {
        if (ix.programId.equals(ComputeBudgetProgram.programId)) continue;
        if (ix.programId.equals(SystemProgram.programId) && ix.data.readUInt32LE(0) === 2) {
          const lamports = ix.data.readBigUInt64LE(4);
          const from = ix.keys[0]!.pubkey;
          const to = ix.keys[1]!.pubkey;
          if (this.balance(from) < lamports) throw Object.assign(new Error('Transaction simulation failed: insufficient lamports'), { name: 'SendTransactionError' });
          this.balances.set(from.toBase58(), this.balance(from) - lamports);
          this.balances.set(to.toBase58(), this.balance(to) + lamports);
          this.transfers.push({ from: from.toBase58(), to: to.toBase58(), lamports, sig });
        }
      }
    }
    const post = keys.map((k) => Number(this.balance(k)));
    this.slot += 1;
    this.landed.set(sig, { sig, tx, slot: this.slot, blockTime: this.time, keys, pre, post, effect });
  }

  /** Advance block height past every outstanding blockhash. */
  expireAll(): void {
    this.height += 1000;
  }

  rpc(): RpcLike {
    const self = this;
    const impl = {
      async getLatestBlockhash() {
        return { blockhash: bs58.encode(Buffer.alloc(32, (self.height % 250) + 1)), lastValidBlockHeight: self.height + 150 };
      },
      async getBlockHeight() {
        return self.height;
      },
      async getSlot() {
        return self.slot;
      },
      async sendRawTransaction(raw: Uint8Array | Buffer) {
        self.sends++;
        if (self.faults.throwBeforeSend) {
          self.faults.throwBeforeSend--;
          throw new Error('process killed before send');
        }
        if (self.faults.dropSends) {
          self.faults.dropSends--;
          return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]!);
        }
        self.apply(raw);
        if (self.faults.throwAfterSend) {
          self.faults.throwAfterSend--;
          throw new Error('process killed after send');
        }
        return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]!);
      },
      async getSignatureStatuses(sigs: string[]) {
        if (self.faults.statusThrows) {
          self.faults.statusThrows--;
          throw new Error('process killed while confirming');
        }
        return {
          context: { slot: self.slot },
          value: sigs.map((s) => {
            const l = self.landed.get(s);
            return l ? { slot: l.slot, confirmations: null, err: (l.effect.err as never) ?? null, confirmationStatus: 'confirmed' as const } : null;
          }),
        };
      },
      async getTransaction(sig: string): Promise<VersionedTransactionResponse | null> {
        const l = self.landed.get(sig);
        if (!l) return null;
        const tb = (rows?: TokenBal[]) => (rows ?? []).map((r) => ({ accountIndex: r.accountIndex, mint: r.mint, owner: r.owner, uiTokenAmount: { amount: r.amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' } }));
        return {
          slot: l.slot,
          blockTime: l.blockTime,
          transaction: { message: l.tx.message, signatures: [l.sig] },
          meta: {
            err: (l.effect.err as never) ?? null,
            fee: 5000,
            preBalances: l.pre,
            postBalances: l.post,
            innerInstructions: l.effect.innerInstructions ?? [],
            logMessages: l.effect.logs ?? [],
            preTokenBalances: tb(l.effect.preTokenBalances),
            postTokenBalances: tb(l.effect.postTokenBalances),
            loadedAddresses: { writable: [], readonly: [] },
          },
        } as unknown as VersionedTransactionResponse;
      },
      async getAccountInfo(k: PublicKey) {
        return self.accounts.get(k.toBase58()) ?? null;
      },
      async getMultipleAccountsInfo(ks: PublicKey[]) {
        return ks.map((k) => self.accounts.get(k.toBase58()) ?? null);
      },
      async getSignaturesForAddress(k: PublicKey, opts?: { limit?: number; before?: string }) {
        const all = self.signatures.get(k.toBase58()) ?? [];
        const start = opts?.before ? all.findIndex((s) => s.signature === opts.before) + 1 : 0;
        return all.slice(start, start + (opts?.limit ?? 1000)).map((s) => ({ ...s, memo: null, confirmationStatus: 'confirmed' as const }));
      },
      async getProgramAccounts(program: PublicKey) {
        return { context: { slot: self.slot }, value: self.programAccounts.get(program.toBase58()) ?? [] };
      },
      async getAddressLookupTable() {
        return { context: { slot: self.slot }, value: null };
      },
      async simulateTransaction() {
        throw new Error('not simulated in tests');
      },
      async getMinimumBalanceForRentExemption() {
        return 890880;
      },
      async getBalance(k: PublicKey) {
        return Number(self.balance(k));
      },
    };
    return impl as unknown as RpcLike;
  }
}

export function unreachableRpc(): RpcLike {
  const fail = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8899');
  };
  return new Proxy({}, { get: () => fail }) as unknown as RpcLike;
}
