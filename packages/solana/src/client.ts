/**
 * CarbonChainClient: the ChainClient port (packages/core/src/ports.ts).
 *
 * Two fee modes (CARBON_FEE_MODE):
 *   native (default)  pump.fun native fee sharing, set once in the launch tx;
 *                     creator = payer = the launcher's wallet; claims are the
 *                     permissionless distribute crank; receipts come from the
 *                     on-chain DistributeCreatorFeesEvent + balance deltas.
 *   wallet (fallback) per-launch creator keypair held encrypted by Carbon;
 *                     claims collect to it; the 50/30/20 split is executed
 *                     from the durable split_ledger.
 *
 * This client never writes to the event bus. Every money movement returns
 * an `event` ({kind, payload}) for the calling agent to append.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ChainClient, EventPayloads, LaunchConfig, PumpCoinInfo, SplitReceipt } from '@carbon/core';
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import BN from 'bn.js';
import { assertAllowed } from './allowlist.js';
import { assertGenesisMatches, assertNetworkAllowed, ENV, readNetworkFlags, type EnvLike, type SolanaConfig } from './config.js';
import { ensureSchema, withLock, type Db } from './db.js';
import { ChainConfigError, ChainUnavailableError, LaunchNotAllowedError, LedgerError, NetworkGuardError, TradeNotAllowedError, TxFailedError, TxTooLargeError } from './errors.js';
import { decodeTxEvents, lamportDelta, tokenDelta } from './events.js';
import { PinataUploader, MAX_URI_LENGTH, type FetchLike } from './metadata.js';
import { buildCarbonBuyIxs, buildClaimIxs, buildCrankIxs, buildNativeLaunchIxs, buildWalletLaunchIxs, fetchLaunchState, solToLamports, type BuiltLaunch } from './pump.js';
import * as reads from './reads.js';
import { rpcCall, type RpcLike } from './rpc.js';
import { takeHolderSnapshot, type SnapshotRequest, type SnapshotResult } from './snapshot.js';
import { compileAndSign, DEFAULT_POLL, driveTxRow, PACKET_DATA_SIZE, waitForFinal, type PollOptions, type SignedTx } from './tx.js';
import { keyLabel, openKeypair, sealKeypair } from './vault.js';
import { pumpSdk } from './sdk.js';

export type EventData<K extends keyof EventPayloads> = { kind: K; payload: EventPayloads[K] };

/**
 * Injected by the caller: resolves only if `approvalId` is a granted AND
 * already-consumed 'launch' approval for `launchId`, and the latest Sentinel
 * report for the launch passed. It must only check; it never consumes.
 */
export type AssertLaunchAllowed = (launchId: string, approvalId: string) => Promise<void>;

export interface ChainClientDeps {
  config: SolanaConfig;
  rpc: RpcLike;
  db: Db;
  assertLaunchAllowed?: AssertLaunchAllowed;
  /** The launch's config-table row (devBuySol cap, buybackSolPerTick cap, decay rule). */
  launchConfig?: (launchId: string) => Promise<LaunchConfig>;
  fetch?: FetchLike;
  poll?: PollOptions;
  /** Used only for the mainnet re-check at construction (defaults to process.env). */
  env?: EnvLike;
}

interface LaunchRow {
  launch_id: string;
  mode: 'native' | 'wallet';
  network: string;
  mint: string;
  mint_secret: string | null;
  creator: string | null;
  creator_secret: string | null;
  sharing_config: string | null;
  launcher_wallet: string | null;
  name: string | null;
  symbol: string | null;
  metadata_uri: string | null;
  dev_buy_lamports: string | null;
  approval_id: string | null;
  message_hash: string | null;
  tx_sig: string | null;
  raw_tx: string | null;
  lvbh: string | null;
  fee_recipient: string | null;
  state: 'wallet' | 'built' | 'sent' | 'confirmed';
  born_at_ms: string | null;
  foreign_scan_until: string | null;
}

/** A confirmed claim (or distribution) in the chain ledger. */
export interface ClaimRecord {
  claimId: string;
  lamports: bigint;
  txSig: string;
  /** 'carbon': Carbon's crank/claim; 'foreign': a third party cranked the distribution. */
  origin: 'carbon' | 'foreign';
}

const LEGS = ['launcher', 'carbon-buyback', 'treasury'] as const;
type Leg = (typeof LEGS)[number];

export class CarbonChainClient implements ChainClient {
  readonly network: 'devnet' | 'mainnet-beta';
  readonly feeMode: 'native' | 'wallet';
  private readonly cfg: SolanaConfig;
  private readonly rpc: RpcLike;
  private readonly db: Db;
  private readonly deps: ChainClientDeps;
  private readonly poll: PollOptions;
  private readonly pinata: PinataUploader;
  private readonly fetchImpl: FetchLike;
  /** The genesis-hash check started at construction; null after an RPC failure (retried on next use). */
  private clusterCheck: Promise<void> | null = null;

  constructor(deps: ChainClientDeps) {
    const env = deps.env ?? process.env;
    // Network guard, again at construction: a hand-built config cannot bypass it. The
    // flags are read exactly as loadSolanaConfig, the worker and the web app read them.
    this.network = assertNetworkAllowed(deps.config.network, readNetworkFlags(env).mainnetEnabled, deps.config.rpcUrl);
    this.cfg = deps.config;
    this.feeMode = deps.config.feeMode;
    this.rpc = deps.rpc;
    this.db = deps.db;
    this.deps = deps;
    this.poll = deps.poll ?? DEFAULT_POLL;
    this.fetchImpl = deps.fetch ?? fetch;
    this.pinata = new PinataUploader(() => this.cfg.secrets.requirePinata(), this.cfg.ipfsGateway, this.fetchImpl);
    // The cluster is decided by the RPC's genesis hash, not by URL text (AG-011). The check
    // starts now; every build/send awaits it, so nothing moves before it has passed.
    this.startClusterCheck();
  }

  private startClusterCheck(): Promise<void> {
    const p = (async () => {
      if (typeof this.rpc.getGenesisHash !== 'function') throw new ChainUnavailableError('RPC has no getGenesisHash; the cluster cannot be verified');
      const hash = await rpcCall('getGenesisHash', () => this.rpc.getGenesisHash());
      assertGenesisMatches(this.network, hash);
    })();
    this.clusterCheck = p;
    p.catch((e: unknown) => {
      // An unreachable RPC is retried on the next use; a wrong cluster stays refused.
      if (!(e instanceof NetworkGuardError) && this.clusterCheck === p) this.clusterCheck = null;
    });
    return p;
  }

  /** Resolves once the RPC is verified (by genesis hash) to serve this client's network. */
  verifyCluster(): Promise<void> {
    return this.clusterCheck ?? this.startClusterCheck();
  }

  toJSON(): Record<string, string> {
    return { network: this.network, feeMode: this.feeMode };
  }

  async init(): Promise<void> {
    await ensureSchema(this.db);
    await this.verifyCluster();
  }

  private get vaultKey(): Uint8Array {
    return this.cfg.secrets.vaultKey;
  }

  private async launchRow(launchId: string): Promise<LaunchRow> {
    const r = await this.db.query<LaunchRow>('SELECT *, dev_buy_lamports::text, lvbh::text, born_at_ms::text FROM sol_launches WHERE launch_id = $1', [launchId]);
    const row = r.rows[0];
    if (!row) throw new LedgerError(`no chain record for launch ${launchId}; call createLaunchWallet first`);
    return row;
  }

  // ───────────────────────────── launch ─────────────────────────────

  /**
   * Idempotent per launchId. native: generates the mint keypair (sealed at
   * rest) and returns the coin's sharing-config PDA, the on-chain fee
   * recipient. wallet: also generates the per-launch creator keypair and
   * returns its address. Secrets are never returned or logged.
   */
  async createLaunchWallet(launchId: string): Promise<{ address: string }> {
    if (!launchId) throw new LedgerError('launchId required');
    return withLock(this.db, `sol:launch:${launchId}`, async () => {
      const existing = await this.db.query<LaunchRow>('SELECT * FROM sol_launches WHERE launch_id = $1', [launchId]);
      const row = existing.rows[0];
      if (row) return { address: row.fee_recipient! };
      const mint = Keypair.generate();
      const mode = this.feeMode;
      let creator: Keypair | null = null;
      let feeRecipient: PublicKey;
      if (mode === 'native') {
        feeRecipient = pumpSdk.feeSharingConfigPda(mint.publicKey);
      } else {
        creator = Keypair.generate();
        feeRecipient = creator.publicKey;
      }
      await this.db.query(
        `INSERT INTO sol_launches (launch_id, mode, network, mint, mint_secret, creator, creator_secret, sharing_config, fee_recipient, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'wallet')`,
        [
          launchId,
          mode,
          this.network,
          mint.publicKey.toBase58(),
          sealKeypair(this.vaultKey, mint, keyLabel.mint(launchId)),
          creator?.publicKey.toBase58() ?? null,
          creator ? sealKeypair(this.vaultKey, creator, keyLabel.creator(launchId)) : null,
          mode === 'native' ? feeRecipient.toBase58() : null,
          feeRecipient.toBase58(),
        ],
      );
      return { address: feeRecipient.toBase58() };
    });
  }

  private async compileLaunch(payer: PublicKey, ixs: TransactionInstruction[], mint: Keypair): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await rpcCall('getLatestBlockhash', () => this.rpc.getLatestBlockhash('confirmed'));
    const compile = (alts: AddressLookupTableAccount[]) => {
      const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
      const tx = new VersionedTransaction(msg);
      try {
        tx.sign([mint]); // partial: the payer (user's wallet) signs client-side
        return tx.serialize().length <= PACKET_DATA_SIZE ? tx : null;
      } catch {
        return null; // serialization overruns the packet
      }
    };
    const plain = compile([]);
    if (plain) return { tx: plain, lastValidBlockHeight };
    if (!this.cfg.lookupTable) throw new TxTooLargeError(`launch transaction does not fit one packet; create the lookup table (scripts/devnet-spike.ts) and set ${ENV.LOOKUP_TABLE}`);
    const alt = await rpcCall('getAddressLookupTable', () => this.rpc.getAddressLookupTable(this.cfg.lookupTable!));
    if (!alt.value) throw new ChainUnavailableError(`${ENV.LOOKUP_TABLE} account not found`);
    const withAlt = compile([alt.value]);
    if (!withAlt) throw new TxTooLargeError('launch transaction does not fit one packet even with the lookup table');
    return { tx: withAlt, lastValidBlockHeight };
  }

  async buildLaunchTx(args: { launchId: string; payer: string; name: string; symbol: string; metadataUri: string; devBuySol: number; approvalId: string }): Promise<{ txBase64: string; mint: string }> {
    if (!this.deps.assertLaunchAllowed) throw new LaunchNotAllowedError('buildLaunchTx requires an assertLaunchAllowed hook (consumed approval + passing Sentinel score)');
    if (!args.approvalId) throw new LaunchNotAllowedError('approvalId required');
    await this.deps.assertLaunchAllowed(args.launchId, args.approvalId);
    if (!this.deps.launchConfig) throw new LaunchNotAllowedError('buildLaunchTx requires the launch config (devBuySol cap)');
    const lc = await this.deps.launchConfig(args.launchId);
    if (args.devBuySol !== lc.devBuySol) throw new LaunchNotAllowedError(`devBuySol ${args.devBuySol} differs from the config row's ${lc.devBuySol}`);
    if (args.metadataUri.length > MAX_URI_LENGTH) throw new LaunchNotAllowedError(`metadata uri longer than ${MAX_URI_LENGTH}`);
    if (!args.name || args.name.length > 32 || !args.symbol || args.symbol.length > 10) throw new LaunchNotAllowedError('name must be 1-32 and symbol 1-10 characters');
    const payer = new PublicKey(args.payer);
    const devBuyLamports = solToLamports(lc.devBuySol);
    await this.verifyCluster();

    return withLock(this.db, `sol:launch:${args.launchId}`, async () => {
      const row = await this.launchRow(args.launchId);
      if (row.state === 'sent' || row.state === 'confirmed') throw new LedgerError(`launch ${args.launchId} already submitted`);
      if (!row.mint_secret) throw new LedgerError('mint key missing');
      const binding = { ...args, payer: payer.toBase58(), devBuyLamports };
      const firstBuild = await this.checkApprovalBinding(row, binding);
      const mint = openKeypair(this.vaultKey, row.mint_secret, keyLabel.mint(args.launchId));
      const { global, feeConfig } = await fetchLaunchState(this.rpc);
      const base = { global, feeConfig, mint: mint.publicKey, payer, name: args.name, symbol: args.symbol, uri: args.metadataUri, devBuyLamports };
      let built: BuiltLaunch;
      if (row.mode === 'native') {
        built = await buildNativeLaunchIxs({ ...base, buybackWallet: this.cfg.buybackWallet, treasuryWallet: this.cfg.treasuryWallet });
      } else {
        built = await buildWalletLaunchIxs({ ...base, creator: new PublicKey(row.creator!) });
      }
      if (built.feeRecipient.toBase58() !== row.fee_recipient) throw new LedgerError('fee recipient changed between wallet creation and build');
      assertAllowed(built.instructions, built.purpose);
      const { tx, lastValidBlockHeight } = await this.compileLaunch(payer, built.instructions, mint);
      const messageHash = createHash('sha256').update(tx.message.serialize()).digest('hex');
      if (firstBuild) {
        await this.db.query(
          `INSERT INTO sol_launch_approvals (approval_id, launch_id, name, symbol, metadata_uri, dev_buy_lamports, payer) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [binding.approvalId, binding.launchId, binding.name, binding.symbol, binding.metadataUri, binding.devBuyLamports.toString(), binding.payer],
        );
      }
      await this.db.query(
        `UPDATE sol_launches SET launcher_wallet=$2, name=$3, symbol=$4, metadata_uri=$5, dev_buy_lamports=$6, approval_id=$7, message_hash=$8, lvbh=$9, state='built', updated_at=now() WHERE launch_id=$1`,
        [args.launchId, payer.toBase58(), args.name, args.symbol, args.metadataUri, devBuyLamports.toString(), args.approvalId, messageHash, lastValidBlockHeight],
      );
      return { txBase64: Buffer.from(tx.serialize()).toString('base64'), mint: mint.publicKey.toBase58() };
    });
  }

  /**
   * AG-002: a launch approval authorises exactly one launch transaction. The first
   * build binds approvalId → (name, symbol, metadata URI, dev buy, payer); a rebuild
   * under the same approval is allowed only with identical values and only while it is
   * the launch's current, unsubmitted approval. Called under the launch lock; returns
   * true when this approval has never built (the binding is written with the build).
   */
  private async checkApprovalBinding(row: LaunchRow, a: { launchId: string; approvalId: string; name: string; symbol: string; metadataUri: string; payer: string; devBuyLamports: bigint }): Promise<boolean> {
    const r = await this.db.query<{ launch_id: string; name: string; symbol: string; metadata_uri: string; dev_buy_lamports: string; payer: string }>(
      'SELECT launch_id, name, symbol, metadata_uri, dev_buy_lamports::text, payer FROM sol_launch_approvals WHERE approval_id=$1',
      [a.approvalId],
    );
    const b = r.rows[0];
    if (!b) return true;
    if (b.launch_id !== a.launchId) throw new LaunchNotAllowedError('approval belongs to another launch');
    if (b.name !== a.name || b.symbol !== a.symbol || b.metadata_uri !== a.metadataUri || BigInt(b.dev_buy_lamports) !== a.devBuyLamports || b.payer !== a.payer) {
      throw new LaunchNotAllowedError('this approval already authorised a launch transaction with different values; the user must approve the new values');
    }
    if (row.approval_id !== a.approvalId) throw new LaunchNotAllowedError('this approval was superseded by a later launch approval');
    return false;
  }

  async submitLaunchTx(launchId: string, signedTxBase64: string): Promise<{ txSig: string; ca: string; bornAtMs: number | null; event: EventData<'launch.deployed'> }> {
    await this.verifyCluster();
    return withLock(this.db, `sol:launch:${launchId}`, async () => {
      let row = await this.launchRow(launchId);
      if (row.state === 'wallet') throw new LedgerError('launch transaction was never built');
      if (row.state === 'built') {
        const tx = VersionedTransaction.deserialize(Buffer.from(signedTxBase64, 'base64'));
        const hash = createHash('sha256').update(tx.message.serialize()).digest('hex');
        if (hash !== row.message_hash) throw new LaunchNotAllowedError('signed transaction differs from the one Carbon built');
        const n = tx.message.header.numRequiredSignatures;
        if (tx.signatures.length !== n || tx.signatures.some((s) => s.every((b) => b === 0))) throw new LaunchNotAllowedError('transaction is missing a signature');
        const sig = bs58.encode(tx.signatures[0]!);
        const raw = tx.serialize();
        await this.db.query(`UPDATE sol_launches SET state='sent', tx_sig=$2, raw_tx=$3, updated_at=now() WHERE launch_id=$1 AND state='built'`, [launchId, sig, Buffer.from(raw).toString('base64')]);
        await rpcCall('sendRawTransaction', () => this.rpc.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 })).catch(async (e) => {
          if (e instanceof ChainUnavailableError && /simulation failed|SendTransactionError/i.test(e.message)) {
            await this.db.query(`UPDATE sol_launches SET state='built', tx_sig=NULL, raw_tx=NULL WHERE launch_id=$1 AND tx_sig=$2`, [launchId, sig]);
            throw new TxFailedError(`launch transaction rejected in preflight: ${e.message}`);
          }
          throw e;
        });
        row = await this.launchRow(launchId);
      }
      if (row.state === 'sent') {
        const r = await waitForFinal(this.rpc, row.tx_sig!, Uint8Array.from(Buffer.from(row.raw_tx!, 'base64')), Number(row.lvbh), this.poll);
        if (r.status !== 'confirmed') {
          await this.db.query(`UPDATE sol_launches SET state='built', tx_sig=NULL, raw_tx=NULL, updated_at=now() WHERE launch_id=$1 AND tx_sig=$2`, [launchId, row.tx_sig]);
          throw new TxFailedError(`launch transaction ${r.status}${r.err ? `: ${r.err}` : ''}; rebuild and sign again`);
        }
        const landed = await rpcCall('getTransaction', () => this.rpc.getTransaction(row.tx_sig!, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
        const bornAt = landed?.blockTime ? landed.blockTime * 1000 : null;
        // The launch is confirmed: wipe the mint secret.
        await this.db.query(`UPDATE sol_launches SET state='confirmed', mint_secret=NULL, mint_wiped_at=now(), raw_tx=NULL, born_at_ms=$2, updated_at=now() WHERE launch_id=$1`, [launchId, bornAt]);
        row = await this.launchRow(launchId);
      }
      const devBuySol = Number(row.dev_buy_lamports ?? '0') / 1e9;
      return {
        txSig: row.tx_sig!,
        ca: row.mint,
        bornAtMs: row.born_at_ms === null ? null : Number(row.born_at_ms),
        event: { kind: 'launch.deployed', payload: { ca: row.mint, txSig: row.tx_sig!, creatorWallet: row.fee_recipient!, devBuySol, network: this.network } },
      };
    });
  }

  uploadMetadata(args: { name: string; symbol: string; description: string; image: Uint8Array; twitter?: string; website?: string }): Promise<{ metadataUri: string; imageUri: string }> {
    return this.pinata.uploadMetadata(args);
  }

  /** Metadata JSON for an image that is already hosted (daughter coins reuse the mother's image). */
  uploadMetadataJson(meta: { name: string; symbol: string; description: string; twitter?: string; website?: string }, imageUri: string): Promise<string> {
    return this.pinata.uploadJson(meta, imageUri);
  }

  // ───────────────────────────── reads ─────────────────────────────

  searchCoins(query: string): Promise<PumpCoinInfo[]> {
    return reads.searchCoins(this.fetchImpl, this.cfg.pumpApiUrl, query);
  }

  walletHistory(address: string): Promise<reads.WalletHistory> {
    return reads.walletHistory(this.rpc, this.fetchImpl, this.cfg.pumpApiUrl, address);
  }

  lastTradeAt(ca: string): Promise<number | null> {
    return reads.lastTradeAt(this.rpc, ca);
  }

  holderSnapshot(req: SnapshotRequest): Promise<SnapshotResult> {
    return takeHolderSnapshot(this.rpc, { ...req, excludeOwners: [...(req.excludeOwners ?? []), this.cfg.buybackWallet.toBase58(), this.cfg.treasuryWallet.toBase58()] });
  }

  // ───────────────────────────── claims ─────────────────────────────

  private crank(): Keypair {
    return this.cfg.secrets.requireCrank();
  }

  private async fetchTx(sig: string): Promise<VersionedTransactionResponse> {
    const tx = await rpcCall('getTransaction', () => this.rpc.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
    if (!tx || !tx.meta) throw new ChainUnavailableError(`transaction ${sig} not available yet`);
    return tx;
  }

  private async buildClaimTx(row: LaunchRow): Promise<{ ixs: TransactionInstruction[]; signed: () => Promise<SignedTx> } | null> {
    const crank = this.crank();
    const mint = new PublicKey(row.mint);
    let ixs: TransactionInstruction[];
    if (row.mode === 'native') {
      const r = await buildCrankIxs(this.rpc, mint, crank.publicKey);
      if (!r.canDistribute) return null;
      ixs = r.instructions;
      assertAllowed(ixs, { kind: 'crank', mint });
    } else {
      const creator = new PublicKey(row.creator!);
      const r = await buildClaimIxs(this.rpc, mint, creator, crank.publicKey);
      if (r.pending === 0n) return null;
      ixs = r.instructions;
      assertAllowed(ixs, { kind: 'claim', mint, creator });
    }
    return {
      ixs,
      signed: () => compileAndSign({ rpc: this.rpc, payer: crank.publicKey, instructions: ixs, signers: [crank], priorityFeeMicroLamports: this.cfg.priorityFeeMicroLamports, computeUnits: 400_000 }),
    };
  }

  /** The lamports a confirmed claim moved, read from the program events in the transaction. */
  private claimedLamports(mode: 'native' | 'wallet', tx: VersionedTransactionResponse, mint: PublicKey): bigint {
    const events = decodeTxEvents(tx);
    if (mode === 'native') {
      const ev = events.find((e) => /^distributeCreatorFeesEvent$/i.test(e.name) && (e.data['mint'] as PublicKey).equals(mint));
      if (!ev) throw new ChainUnavailableError('distribution transaction has no DistributeCreatorFeesEvent for this mint');
      return BigInt((ev.data['distributed'] as BN).toString());
    }
    let total = 0n;
    let seen = false;
    for (const e of events) {
      if (/^collectCreatorFeeEvent$/i.test(e.name)) {
        total += BigInt((e.data['creatorFee'] as BN).toString());
        seen = true;
      } else if (/^collectCoinCreatorFeeEvent$/i.test(e.name)) {
        total += BigInt((e.data['coinCreatorFee'] as BN).toString());
        seen = true;
      }
    }
    if (!seen) throw new ChainUnavailableError('claim transaction has no collect event');
    return total;
  }

  /** A claim that confirmed on chain before its amount was recorded (crash in between): record it now. */
  private async finishUnmeasuredClaims(row: LaunchRow): Promise<void> {
    const r = await this.db.query<{ claim_id: string; tx_sig: string }>(
      `SELECT claim_id, tx_sig FROM sol_claims WHERE launch_id=$1 AND state='confirmed' AND lamports IS NULL AND tx_sig IS NOT NULL ORDER BY created_at`,
      [row.launch_id],
    );
    for (const c of r.rows) {
      const tx = await this.fetchTx(c.tx_sig);
      const lamports = this.claimedLamports(row.mode, tx, new PublicKey(row.mint));
      await this.db.query(`UPDATE sol_claims SET lamports=$2 WHERE claim_id=$1 AND lamports IS NULL`, [c.claim_id, lamports.toString()]);
    }
  }

  /**
   * Every confirmed claim of the launch, oldest first, from the durable ledger. A claim
   * row exists (with its signature) before its transaction is broadcast, so a crash
   * between the claim landing and the caller's fee.claimed append is recovered by
   * reconciling this list against the log (AG-007).
   */
  async confirmedClaims(launchId: string): Promise<ClaimRecord[]> {
    await this.verifyCluster();
    return withLock(this.db, `sol:claim:${launchId}`, async () => {
      const row = await this.launchRow(launchId);
      await this.finishUnmeasuredClaims(row);
      const r = await this.db.query<{ claim_id: string; lamports: string; tx_sig: string; origin: string }>(
        `SELECT claim_id, lamports::text, tx_sig, origin FROM sol_claims WHERE launch_id=$1 AND state='confirmed' AND lamports IS NOT NULL AND tx_sig IS NOT NULL ORDER BY created_at, claim_id`,
        [launchId],
      );
      return r.rows.map((c) => ({ claimId: c.claim_id, lamports: BigInt(c.lamports), txSig: c.tx_sig, origin: c.origin === 'foreign' ? 'foreign' : 'carbon' }));
    });
  }

  /**
   * Native mode: distribute_creator_fees is permissionless, so anyone can crank the
   * coin's sharing config before Carbon does. Scans the sharing config's signatures
   * (newest first, back to the last scanned one) for successful transactions that are
   * not Carbon's own claims and carry a DistributeCreatorFeesEvent for this mint, and
   * records each as a confirmed 'foreign' claim, so it gets fee.claimed and a split
   * receipt like any other. Returns the claims it found.
   */
  async scanForeignDistributions(launchId: string): Promise<ClaimRecord[]> {
    await this.verifyCluster();
    return withLock(this.db, `sol:claim:${launchId}`, async () => {
      const row = await this.launchRow(launchId);
      if (row.mode !== 'native' || row.state !== 'confirmed' || !row.sharing_config) return [];
      const sharing = new PublicKey(row.sharing_config);
      const mint = new PublicKey(row.mint);
      const known = new Set(
        (await this.db.query<{ tx_sig: string }>('SELECT tx_sig FROM sol_claims WHERE launch_id=$1 AND tx_sig IS NOT NULL', [launchId])).rows.map((r) => r.tx_sig),
      );
      const fresh: { signature: string; err: unknown }[] = [];
      let before: string | undefined;
      for (let page = 0; page < FOREIGN_SCAN_PAGES; page++) {
        const sigs = await rpcCall('getSignaturesForAddress', () => this.rpc.getSignaturesForAddress(sharing, { limit: FOREIGN_SCAN_PAGE, ...(before ? { before } : {}) }, 'confirmed'));
        let reached = false;
        for (const sg of sigs) {
          if (sg.signature === row.foreign_scan_until) {
            reached = true;
            break;
          }
          fresh.push(sg);
        }
        if (reached || sigs.length < FOREIGN_SCAN_PAGE) break;
        before = sigs[sigs.length - 1]!.signature;
      }
      const found: ClaimRecord[] = [];
      for (const sg of [...fresh].reverse()) {
        if (sg.err || known.has(sg.signature)) continue;
        const tx = await this.fetchTx(sg.signature); // throws while unavailable: the cursor does not move
        if (tx.meta?.err) continue;
        const ev = decodeTxEvents(tx).find((e) => /^distributeCreatorFeesEvent$/i.test(e.name) && (e.data['mint'] as PublicKey | undefined)?.equals(mint));
        if (!ev) continue;
        const lamports = BigInt((ev.data['distributed'] as BN).toString());
        if (lamports <= 0n) continue;
        const claimId = `foreign_${sg.signature}`;
        await this.db.query(
          `INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, lamports, origin) VALUES ($1,$2,'native','confirmed',$3,$4,'foreign') ON CONFLICT (claim_id) DO NOTHING`,
          [claimId, launchId, sg.signature, lamports.toString()],
        );
        found.push({ claimId, lamports, txSig: sg.signature, origin: 'foreign' });
      }
      if (fresh[0]) await this.db.query('UPDATE sol_launches SET foreign_scan_until=$2 WHERE launch_id=$1', [launchId, fresh[0].signature]);
      return found;
    });
  }

  async claimCreatorFees(launchId: string): Promise<{ claimId: string; lamports: bigint; txSig: string; event: EventData<'fee.claimed'> } | null> {
    await this.verifyCluster();
    return withLock(this.db, `sol:claim:${launchId}`, async () => {
      const row = await this.launchRow(launchId);
      if (row.state !== 'confirmed') throw new LedgerError(`launch ${launchId} is not confirmed on chain`);
      await this.finishUnmeasuredClaims(row);
      const open = await this.db.query<{ claim_id: string; state: string }>(`SELECT claim_id, state FROM sol_claims WHERE launch_id=$1 AND state <> 'confirmed' ORDER BY created_at LIMIT 1`, [launchId]);
      let claimId = open.rows[0]?.claim_id;
      if (!claimId) {
        // Only open a claim when there is something to claim.
        const probe = await this.buildClaimTx(row);
        if (!probe) return null;
        claimId = randomUUID();
        await this.db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state) VALUES ($1,$2,$3,'pending')`, [claimId, launchId, row.mode]);
      }
      let sig: string;
      try {
        ({ sig } = await driveTxRow(this.db, this.rpc, { table: 'sol_claims', key: { claim_id: claimId } }, async () => {
          const b = await this.buildClaimTx(row);
          if (!b) throw new NothingToClaim();
          return b.signed();
        }, this.poll));
      } catch (e) {
        if (e instanceof NothingToClaim) {
          // Someone else cranked it first (claims are permissionless): nothing was sent by us.
          await this.db.query(`DELETE FROM sol_claims WHERE claim_id=$1 AND state='pending'`, [claimId]);
          return null;
        }
        throw e;
      }
      const tx = await this.fetchTx(sig);
      const lamports = this.claimedLamports(row.mode, tx, new PublicKey(row.mint));
      await this.db.query(`UPDATE sol_claims SET lamports=$2 WHERE claim_id=$1`, [claimId, lamports.toString()]);
      return { claimId, lamports, txSig: sig, event: { kind: 'fee.claimed', payload: { claimId, lamports: lamports.toString(), txSig: sig } } };
    });
  }

  // ───────────────────────────── split ─────────────────────────────

  private legAddress(leg: Leg, launcher: string): string {
    return leg === 'launcher' ? launcher : leg === 'carbon-buyback' ? this.cfg.buybackWallet.toBase58() : this.cfg.treasuryWallet.toBase58();
  }

  /** 50/30/20 of `total` with floors; the treasury leg takes the remainder so legs always sum to total. */
  static splitAmounts(total: bigint): Record<Leg, bigint> {
    const launcher = (total * 5000n) / 10000n;
    const buyback = (total * 3000n) / 10000n;
    return { launcher, 'carbon-buyback': buyback, treasury: total - launcher - buyback };
  }

  async runSplit(launchId: string, claimId: string): Promise<SplitReceipt> {
    await this.verifyCluster();
    return withLock(this.db, `sol:split:${claimId}`, async () => {
      const row = await this.launchRow(launchId);
      const c = await this.db.query<{ state: string; lamports: string | null; tx_sig: string | null; launch_id: string; mode: string }>(
        'SELECT state, lamports::text, tx_sig, launch_id, mode FROM sol_claims WHERE claim_id=$1',
        [claimId],
      );
      const claim = c.rows[0];
      if (!claim || claim.launch_id !== launchId) throw new LedgerError(`claim ${claimId} not found for launch ${launchId}`);
      if (claim.state !== 'confirmed' || claim.lamports === null) throw new LedgerError(`claim ${claimId} is not confirmed`);
      const total = BigInt(claim.lamports);
      const splitId = `split_${claimId}`;
      await this.db.query(`INSERT INTO sol_splits (split_id, claim_id, launch_id, mode, total) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (split_id) DO NOTHING`, [splitId, claimId, launchId, claim.mode, total.toString()]);
      const launcher = row.launcher_wallet!;

      if (claim.mode === 'native') {
        // The distribution already paid every leg atomically: record what the chain shows.
        const tx = await this.fetchTx(claim.tx_sig!);
        const ev = decodeTxEvents(tx).find((e) => /^distributeCreatorFeesEvent$/i.test(e.name));
        if (!ev) throw new ChainUnavailableError('distribution transaction has no DistributeCreatorFeesEvent');
        const holders = ev.data['shareholders'] as { address: PublicKey }[];
        for (const h of holders) {
          const addr = h.address.toBase58();
          const leg = LEGS.find((l) => this.legAddress(l, launcher) === addr);
          if (!leg) throw new LedgerError(`sharing config pays ${addr}, which is not a Carbon split leg (admin_cto?)`);
          const paid = lamportDelta(tx, h.address);
          await this.db.query(
            `INSERT INTO split_ledger (claim_id, leg, launch_id, address, lamports, state, tx_sig) VALUES ($1,$2,$3,$4,$5,'confirmed',$6) ON CONFLICT (claim_id, leg) DO NOTHING`,
            [claimId, leg, launchId, addr, paid.toString(), claim.tx_sig],
          );
        }
      } else {
        const amounts = CarbonChainClient.splitAmounts(total);
        for (const leg of LEGS) {
          await this.db.query(
            `INSERT INTO split_ledger (claim_id, leg, launch_id, address, lamports, state) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (claim_id, leg) DO NOTHING`,
            [claimId, leg, launchId, this.legAddress(leg, launcher), amounts[leg].toString(), amounts[leg] === 0n ? 'confirmed' : 'pending'],
          );
        }
        const creator = openKeypair(this.vaultKey, row.creator_secret!, keyLabel.creator(launchId));
        const crank = this.crank();
        const recipients = LEGS.map((l) => new PublicKey(this.legAddress(l, launcher)));
        for (const leg of LEGS) {
          const lr = await this.db.query<{ address: string; lamports: string; state: string }>(`SELECT address, lamports::text, state FROM split_ledger WHERE claim_id=$1 AND leg=$2`, [claimId, leg]);
          const l = lr.rows[0]!;
          if (l.state === 'confirmed') continue;
          await driveTxRow(this.db, this.rpc, { table: 'split_ledger', key: { claim_id: claimId, leg } }, async () => {
            const ix = SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: new PublicKey(l.address), lamports: BigInt(l.lamports) });
            assertAllowed([ix], { kind: 'split', from: creator.publicKey, recipients });
            return compileAndSign({ rpc: this.rpc, payer: crank.publicKey, instructions: [ix], signers: [crank, creator], priorityFeeMicroLamports: this.cfg.priorityFeeMicroLamports });
          }, this.poll);
        }
      }
      return this.readReceipt(splitId);
    });
  }

  /** The split.receipt payload as recorded in the ledger. */
  async readReceipt(splitId: string): Promise<SplitReceipt> {
    const s = await this.db.query<{ claim_id: string; total: string; created_at: Date }>('SELECT claim_id, total::text, created_at FROM sol_splits WHERE split_id=$1', [splitId]);
    const split = s.rows[0];
    if (!split) throw new LedgerError(`split ${splitId} not found`);
    const legs = await this.db.query<{ leg: Leg; address: string; lamports: string; tx_sig: string | null; state: 'pending' | 'sent' | 'confirmed'; updated_at: Date }>(
      'SELECT leg, address, lamports::text, tx_sig, state, updated_at FROM split_ledger WHERE claim_id=$1',
      [split.claim_id],
    );
    const ordered = LEGS.map((l) => legs.rows.find((r) => r.leg === l)).filter((r): r is NonNullable<typeof r> => !!r);
    const at = Math.max(split.created_at.getTime(), ...ordered.map((r) => r.updated_at.getTime()));
    return {
      splitId,
      claimId: split.claim_id,
      totalLamports: split.total,
      legs: ordered.map((r) => ({ to: r.leg, address: r.address, lamports: r.lamports, txSig: r.tx_sig, status: r.state })),
      at,
    };
  }

  // ───────────────────────────── buyback ─────────────────────────────

  /**
   * Buy $CARBON with the buyback leg of one split. Idempotent per splitId: one
   * ledger row, at most one confirmed buy. Spend = min(requested, the leg's
   * confirmed lamports, the launch config's buybackSolPerTick).
   */
  /**
   * The open (not yet acknowledged) buy of a split, if any: the caller resumes it with
   * buyCarbon (no new request) and acknowledges it with ackBuyback once its receipt is
   * in the public log. txSig is null while nothing has been signed.
   */
  async recordedBuyback(splitId: string): Promise<{ tranche: number; lamports: bigint; state: 'pending' | 'sent' | 'confirmed'; txSig: string | null } | null> {
    const r = await this.db.query<{ tranche: number; lamports_in: string; state: 'pending' | 'sent' | 'confirmed'; tx_sig: string | null }>(
      'SELECT tranche, lamports_in::text, state, tx_sig FROM sol_buybacks WHERE split_id=$1 AND acked=false ORDER BY tranche DESC LIMIT 1',
      [splitId],
    );
    const b = r.rows[0];
    return b ? { tranche: Number(b.tranche), lamports: BigInt(b.lamports_in), state: b.state, txSig: b.tx_sig } : null;
  }

  /** The caller appended the buyback.executed receipt for this buy: the split may buy again. */
  async ackBuyback(splitId: string, txSig: string): Promise<void> {
    await this.db.query(`UPDATE sol_buybacks SET acked=true, updated_at=now() WHERE split_id=$1 AND tx_sig=$2 AND state='confirmed'`, [splitId, txSig]);
  }

  /**
   * Buy $CARBON with the buyback leg of one split, in tranches of at most the launch's
   * per-tick cap. Idempotent: while a split's latest buy is not acknowledged (ackBuyback,
   * after its receipt is appended) every call resumes and returns THAT buy, whatever
   * amount is asked; only an acknowledged split starts a new tranche, from what the leg
   * has left after the SOL earlier tranches actually spent. lamportsIn is what the
   * confirmed trade spent (the on-chain trade event: SOL in + protocol fee + creator
   * fee), never the requested maximum (AG-006).
   */
  async buyCarbon(lamports: bigint, splitId: string): Promise<{ txSig: string; carbonOut: bigint; lamportsIn: bigint; event: EventData<'buyback.executed'> }> {
    const carbonMint = this.cfg.carbonMint;
    if (!carbonMint) throw new ChainConfigError(`${ENV.CARBON_MINT} is required for $CARBON buybacks`);
    await this.verifyCluster();
    return withLock(this.db, `sol:buyback:${splitId}`, async () => {
      const s = await this.db.query<{ claim_id: string; launch_id: string }>('SELECT claim_id, launch_id FROM sol_splits WHERE split_id=$1', [splitId]);
      const split = s.rows[0];
      if (!split) throw new LedgerError(`split ${splitId} not found`);
      let open = await this.recordedBuyback(splitId);
      if (!open) {
        const leg = await this.db.query<{ lamports: string; state: string }>(`SELECT lamports::text, state FROM split_ledger WHERE claim_id=$1 AND leg='carbon-buyback'`, [split.claim_id]);
        const l = leg.rows[0];
        if (!l || l.state !== 'confirmed') throw new LedgerError(`buyback leg of ${splitId} is not confirmed`);
        if (!this.deps.launchConfig) throw new ChainConfigError('buyCarbon requires the launch config (buybackSolPerTick cap)');
        const cap = solToLamports((await this.deps.launchConfig(split.launch_id)).buybackSolPerTick);
        const done = await this.db.query<{ spent: string; n: string }>(
          'SELECT COALESCE(SUM(lamports_spent), 0)::text AS spent, COALESCE(MAX(tranche), 0)::text AS n FROM sol_buybacks WHERE split_id=$1',
          [splitId],
        );
        const remaining = BigInt(l.lamports) - BigInt(done.rows[0]!.spent);
        const amount = [lamports, remaining, cap].reduce((a, b) => (b < a ? b : a));
        if (amount <= 0n) throw new TradeNotAllowedError(`no buyback budget for ${splitId} (requested ${lamports}, leg left ${remaining}, per-tick cap ${cap})`);
        const tranche = Number(done.rows[0]!.n) + 1;
        await this.db.query(`INSERT INTO sol_buybacks (split_id, tranche, launch_id, lamports_in, state) VALUES ($1,$2,$3,$4,'pending')`, [splitId, tranche, split.launch_id, amount.toString()]);
        open = { tranche, lamports: amount, state: 'pending', txSig: null };
      }
      const tranche = String(open.tranche);
      const maxLamports = open.lamports;
      const buyer = this.cfg.secrets.requireBuyback();
      const { sig } = await driveTxRow(this.db, this.rpc, { table: 'sol_buybacks', key: { split_id: splitId, tranche } }, async () => {
        const built = await buildCarbonBuyIxs(this.rpc, carbonMint, buyer.publicKey, maxLamports);
        assertAllowed(built.instructions, { kind: 'buyback', carbonMint, buyer: buyer.publicKey, maxLamports });
        await this.db.query('UPDATE sol_buybacks SET venue=$3 WHERE split_id=$1 AND tranche=$2', [splitId, tranche, built.venue]);
        const signed = await compileAndSign({ rpc: this.rpc, payer: buyer.publicKey, instructions: built.instructions, signers: [buyer], priorityFeeMicroLamports: this.cfg.priorityFeeMicroLamports, computeUnits: 300_000 });
        // Same blockhash + same amount = the same signature as an earlier tranche: the chain would
        // treat it as that transaction again. Wait for a new blockhash instead of reusing it.
        const dup = await this.db.query('SELECT 1 FROM sol_buybacks WHERE tx_sig=$1', [signed.sig]);
        if (dup.rowCount) throw new LedgerError(`buy for ${splitId} would repeat an earlier transaction; retried with a new blockhash next tick`);
        return signed;
      }, this.poll);
      const tx = await this.fetchTx(sig);
      const carbonOut = tokenDelta(tx, buyer.publicKey, carbonMint);
      const spent = spentFromTradeEvents(tx, carbonMint);
      await this.db.query('UPDATE sol_buybacks SET carbon_out=$3, lamports_spent=$4 WHERE split_id=$1 AND tranche=$2', [splitId, tranche, carbonOut.toString(), spent.toString()]);
      return {
        txSig: sig,
        carbonOut,
        lamportsIn: spent,
        event: { kind: 'buyback.executed', payload: { lamportsIn: spent.toString(), carbonOut: carbonOut.toString(), txSig: sig, funding: 'fee-split', splitId } },
      };
    });
  }

  // ───────────────────────────── decay: daughter + airdrop ─────────────────────────────

  /**
   * Carbon-paid daughter launch. Payer (and, in native mode, creator) is the
   * crank key; the fee split keeps the mother's launcher at 50%. The dev buy
   * (the daughter's own, capped by the mother's devBuySol) lands in the crank
   * wallet and is the pool the airdrop distributes. Durable: the signature is
   * stored before broadcast and a re-run resumes by signature.
   */
  async launchDaughter(a: { daughterLaunchId: string; name: string; symbol: string; description: string; imageUri: string; launcherWallet: string; devBuySol: number }): Promise<{ mint: string; txSig: string; unitsReceived: bigint; feeRecipient: string }> {
    const crank = this.crank();
    await this.verifyCluster();
    await this.createLaunchWallet(a.daughterLaunchId);
    return withLock(this.db, `sol:launch:${a.daughterLaunchId}`, async () => {
      let row = await this.launchRow(a.daughterLaunchId);
      if (row.state === 'wallet' || row.state === 'built') {
        const metadataUri = row.metadata_uri ?? (await this.pinata.uploadJson({ name: a.name, symbol: a.symbol, description: a.description }, a.imageUri));
        const devBuyLamports = solToLamports(a.devBuySol);
        await this.db.query(`UPDATE sol_launches SET metadata_uri=$2, name=$3, symbol=$4, launcher_wallet=$5, dev_buy_lamports=$6 WHERE launch_id=$1`, [a.daughterLaunchId, metadataUri, a.name, a.symbol, a.launcherWallet, devBuyLamports.toString()]);
        const mint = openKeypair(this.vaultKey, row.mint_secret!, keyLabel.mint(a.daughterLaunchId));
        const { global, feeConfig } = await fetchLaunchState(this.rpc);
        const base = { global, feeConfig, mint: mint.publicKey, payer: crank.publicKey, name: a.name, symbol: a.symbol, uri: metadataUri, devBuyLamports };
        const built =
          row.mode === 'native'
            ? await buildNativeLaunchIxs({ ...base, buybackWallet: this.cfg.buybackWallet, treasuryWallet: this.cfg.treasuryWallet, shareLauncher: new PublicKey(a.launcherWallet) })
            : await buildWalletLaunchIxs({ ...base, creator: new PublicKey(row.creator!) });
        assertAllowed(built.instructions, built.purpose);
        const { tx, lastValidBlockHeight } = await this.compileLaunch(crank.publicKey, built.instructions, mint);
        tx.sign([crank]);
        const sig = bs58.encode(tx.signatures[0]!);
        const raw = tx.serialize();
        await this.db.query(`UPDATE sol_launches SET state='sent', tx_sig=$2, raw_tx=$3, lvbh=$4, updated_at=now() WHERE launch_id=$1 AND state IN ('wallet','built')`, [a.daughterLaunchId, sig, Buffer.from(raw).toString('base64'), lastValidBlockHeight]);
        await this.rpc.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 }).catch(async (e: unknown) => {
          if (e instanceof Error && (e.name === 'SendTransactionError' || /simulation failed/i.test(e.message))) {
            await this.db.query(`UPDATE sol_launches SET state='built', tx_sig=NULL, raw_tx=NULL WHERE launch_id=$1 AND tx_sig=$2`, [a.daughterLaunchId, sig]);
            throw new TxFailedError(`daughter launch rejected in preflight: ${e.message}`);
          }
          throw e;
        });
        row = await this.launchRow(a.daughterLaunchId);
      }
      if (row.state === 'sent') {
        const r = await waitForFinal(this.rpc, row.tx_sig!, Uint8Array.from(Buffer.from(row.raw_tx!, 'base64')), Number(row.lvbh), this.poll);
        if (r.status !== 'confirmed') {
          await this.db.query(`UPDATE sol_launches SET state='built', tx_sig=NULL, raw_tx=NULL, updated_at=now() WHERE launch_id=$1 AND tx_sig=$2`, [a.daughterLaunchId, row.tx_sig]);
          throw new TxFailedError(`daughter launch ${r.status}${r.err ? `: ${r.err}` : ''}`);
        }
        const landed = await this.fetchTx(row.tx_sig!);
        await this.db.query(`UPDATE sol_launches SET state='confirmed', mint_secret=NULL, mint_wiped_at=now(), raw_tx=NULL, born_at_ms=$2, updated_at=now() WHERE launch_id=$1`, [a.daughterLaunchId, landed.blockTime ? landed.blockTime * 1000 : null]);
        row = await this.launchRow(a.daughterLaunchId);
      }
      const tx = await this.fetchTx(row.tx_sig!);
      const unitsReceived = tokenDelta(tx, crank.publicKey, new PublicKey(row.mint));
      return { mint: row.mint, txSig: row.tx_sig!, unitsReceived, feeRecipient: row.fee_recipient! };
    });
  }

  /** One durable airdrop row: Token-2022 transfer of daughter units from the crank wallet. Idempotent per (daughterMint, wallet). */
  async airdropUnits(launchId: string, daughterMint: string, wallet: string, units: bigint): Promise<{ txSig: string; event: EventData<'airdrop.sent'> }> {
    if (units <= 0n) throw new LedgerError('airdrop units must be positive');
    const crank = this.crank();
    await this.verifyCluster();
    const mint = new PublicKey(daughterMint);
    await this.db.query(`INSERT INTO sol_airdrops (daughter_mint, wallet, launch_id, units, state) VALUES ($1,$2,$3,$4,'pending') ON CONFLICT (daughter_mint, wallet) DO NOTHING`, [daughterMint, wallet, launchId, units.toString()]);
    return withLock(this.db, `sol:airdrop:${daughterMint}:${wallet}`, async () => {
      const r = await this.db.query<{ units: string }>('SELECT units::text FROM sol_airdrops WHERE daughter_mint=$1 AND wallet=$2', [daughterMint, wallet]);
      const recorded = BigInt(r.rows[0]!.units); // the ledger's amount wins over the caller's on resume
      const { sig } = await driveTxRow(this.db, this.rpc, { table: 'sol_airdrops', key: { daughter_mint: daughterMint, wallet } }, async () => {
        const owner = new PublicKey(wallet);
        const src = getAssociatedTokenAddressSync(mint, crank.publicKey, true, TOKEN_2022_PROGRAM_ID);
        const dst = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
        const ixs = [
          createAssociatedTokenAccountIdempotentInstruction(crank.publicKey, dst, owner, mint, TOKEN_2022_PROGRAM_ID),
          createTransferCheckedInstruction(src, mint, dst, crank.publicKey, recorded, PUMP_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
        ];
        assertAllowed(ixs, { kind: 'airdrop', mint, from: crank.publicKey });
        return compileAndSign({ rpc: this.rpc, payer: crank.publicKey, instructions: ixs, signers: [crank], priorityFeeMicroLamports: this.cfg.priorityFeeMicroLamports });
      }, this.poll);
      return { txSig: sig, event: { kind: 'airdrop.sent', payload: { daughterCa: daughterMint, wallet, units: recorded.toString(), txSig: sig } } };
    });
  }

  /**
   * The launch's on-chain birth: the block time of its confirmed create transaction
   * (unix ms), or null when Carbon has no confirmed record of it. The C-14 clock starts here (AG-025).
   */
  async launchBornAtMs(launchId: string): Promise<number | null> {
    const r = await this.db.query<{ born_at_ms: string | null; state: string }>('SELECT born_at_ms::text, state FROM sol_launches WHERE launch_id=$1', [launchId]);
    const row = r.rows[0];
    return row && row.state === 'confirmed' && row.born_at_ms !== null ? Number(row.born_at_ms) : null;
  }

  /** Public key of the Carbon crank wallet (fee payer, daughter creator in native mode). */
  crankAddress(): string {
    return this.crank().publicKey.toBase58();
  }
}

/** pump.fun coins have 6 decimals. */
export const PUMP_DECIMALS = 6;

class NothingToClaim extends Error {}

const FOREIGN_SCAN_PAGE = 100;
const FOREIGN_SCAN_PAGES = 10;

/** SOL actually spent by the buy, from the trade event (curve: sol + protocol fee + creator fee; PumpSwap: user quote in). */
export function spentFromTradeEvents(tx: VersionedTransactionResponse, mint: PublicKey): bigint {
  for (const e of decodeTxEvents(tx)) {
    if (/^tradeEvent$/i.test(e.name) && (e.data['mint'] as PublicKey).equals(mint) && e.data['isBuy'] === true) {
      const n = (k: string) => BigInt(((e.data[k] as BN | undefined) ?? new BN(0)).toString());
      return n('solAmount') + n('fee') + n('creatorFee');
    }
    if (/^buyEvent$/i.test(e.name) && e.program === 'amm') {
      return BigInt((e.data['userQuoteAmountIn'] as BN).toString());
    }
  }
  throw new ChainUnavailableError('buyback transaction has no trade event');
}

export function createChainClient(deps: ChainClientDeps): CarbonChainClient {
  return new CarbonChainClient(deps);
}
