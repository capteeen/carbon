/**
 * THE one seam that constructs the ChainClient (@carbon/solana, Agent E).
 *
 * Until @carbon/solana is wired at integration, the client returned here refuses
 * every call with ChainUnavailableError. It never returns data, so nothing on
 * chain is ever faked: Sentinel scores chain inputs as "source unavailable" and
 * Treasurer stops before any launch.
 *
 * Integration (one place):
 *   import { createChainClient as createSolana, migrations as solanaMigrations } from '@carbon/solana';
 *   export function createChainClient(deps) { return createSolana({ db: deps.pool, assertApproval: deps.assertApproval }); }
 *   export const chainMigrations = solanaMigrations;
 */
import type { ApprovalAction, ChainClient, PumpCoinInfo, SplitReceipt } from '@carbon/core';
import type pg from 'pg';

export class ChainUnavailableError extends Error {
  constructor(what: string) {
    super(`chain unavailable: ${what} (the @carbon/solana client is not wired into the worker yet)`);
    this.name = 'ChainUnavailableError';
  }
}

/** Approval CHECK for chain calls that need one (never a second consume). */
export type AssertConsumed = (launchId: string, approvalId: string, action: ApprovalAction) => Promise<void>;

export interface ChainDeps {
  pool: pg.Pool;
  network: 'devnet' | 'mainnet-beta';
  assertApproval: AssertConsumed;
}

/** Decay support the ChainClient port does not have yet (proposed to the integrator). */
export interface DecayChain {
  /** Holder snapshot of the mother coin at the current slot (via @qsd/protocol). */
  snapshotHolders(launchId: string, ca: string): Promise<{ slot: number; holderCount: number; merkleRoot: string }>;
  /** Launch the daughter and airdrop it from the snapshot; idempotent per launchId. */
  launchDaughter(
    launchId: string,
    motherCa: string,
    snapshotEventId: string,
  ): Promise<{ daughterCa: string; txSig: string; allocationRoot: string; airdrops: { wallet: string; units: string; txSig: string }[] }>;
}

export function hasDecaySupport(c: ChainClient): c is ChainClient & DecayChain {
  const d = c as Partial<DecayChain>;
  return typeof d.snapshotHolders === 'function' && typeof d.launchDaughter === 'function';
}

class UnwiredChainClient implements ChainClient {
  constructor(readonly network: 'devnet' | 'mainnet-beta') {}
  private no(what: string): Promise<never> {
    return Promise.reject(new ChainUnavailableError(what));
  }
  createLaunchWallet(): Promise<{ address: string }> {
    return this.no('createLaunchWallet');
  }
  buildLaunchTx(): Promise<{ txBase64: string; mint: string }> {
    return this.no('buildLaunchTx');
  }
  submitLaunchTx(): Promise<{ txSig: string; ca: string }> {
    return this.no('submitLaunchTx');
  }
  uploadMetadata(): Promise<{ metadataUri: string; imageUri: string }> {
    return this.no('uploadMetadata');
  }
  searchCoins(): Promise<PumpCoinInfo[]> {
    return this.no('searchCoins');
  }
  walletHistory(): Promise<{ txCount: number; firstSeen: number | null; launches: number }> {
    return this.no('walletHistory');
  }
  claimCreatorFees(): Promise<{ claimId: string; lamports: bigint; txSig: string } | null> {
    return this.no('claimCreatorFees');
  }
  runSplit(): Promise<SplitReceipt> {
    return this.no('runSplit');
  }
  buyCarbon(): Promise<{ txSig: string; carbonOut: bigint }> {
    return this.no('buyCarbon');
  }
  lastTradeAt(): Promise<number | null> {
    return this.no('lastTradeAt');
  }
}

export function createChainClient(deps: ChainDeps): ChainClient {
  void deps.pool;
  void deps.assertApproval;
  return new UnwiredChainClient(deps.network);
}

/** Extra migrations the chain package needs (none until @carbon/solana is wired). */
export async function chainMigrations(_pool: pg.Pool): Promise<string[]> {
  return [];
}
