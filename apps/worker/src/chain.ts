/**
 * THE one seam that constructs the ChainClient: @carbon/solana's createChainClient.
 *
 * - assertLaunchAllowed only CHECKS (a consumed 'launch' approval for the launch
 *   and a passing latest Sentinel score). It never consumes: Treasurer already did.
 * - The chain client never writes events; agents (and the decay loop here) append them.
 * - If the chain config is missing (env not set), the worker still boots, and every
 *   chain call refuses with ChainUnavailableError naming the reason. Nothing is faked.
 */
import { getLaunchConfig, type ChainClient, type EventBus, type PumpCoinInfo, type SplitReceipt } from '@carbon/core';
import { ChainUnavailableError, createChainClient as createSolana, ensureSchema, loadSolanaConfig, type CarbonChainClient } from '@carbon/solana';
import { Connection } from '@solana/web3.js';
import type pg from 'pg';

export { ChainUnavailableError };

export interface ChainDeps {
  pool: pg.Pool;
  bus: EventBus;
  env?: NodeJS.ProcessEnv;
}

/** Check, never consume: approval consumed for this launch + action 'launch', and Sentinel's latest score passed. */
export function launchAllowedCheck(pool: pg.Pool, bus: EventBus) {
  return async (launchId: string, approvalId: string): Promise<void> => {
    const r = await pool.query<{ status: string }>("SELECT status FROM approvals WHERE id = $1 AND launch_id = $2 AND action = 'launch'", [approvalId, launchId]);
    if (r.rows[0]?.status !== 'consumed') throw new Error('launch approval is not consumed for this launch');
    const scores = await bus.list(launchId, { kinds: ['sentinel.score'] });
    const last = scores[scores.length - 1];
    const p = last?.payload as { passed?: boolean; hardFail?: boolean } | undefined;
    if (!p || p.passed !== true || p.hardFail === true) throw new Error('latest Sentinel score did not pass');
  };
}

/** A ChainClient that refuses every call, with the reason the real one could not be built. */
class UnavailableChainClient implements ChainClient {
  constructor(
    readonly network: 'devnet' | 'mainnet-beta',
    private readonly reason: string,
  ) {}
  private no(what: string): Promise<never> {
    return Promise.reject(new ChainUnavailableError(`${what}: ${this.reason}`));
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

export type WorkerChain = { kind: 'solana'; client: CarbonChainClient } | { kind: 'unavailable'; client: ChainClient; reason: string };

export function createChainClient(deps: ChainDeps): WorkerChain {
  const env = deps.env ?? process.env;
  try {
    const config = loadSolanaConfig(env);
    const client = createSolana({
      config,
      rpc: new Connection(config.rpcUrl, 'confirmed'),
      db: deps.pool,
      assertLaunchAllowed: launchAllowedCheck(deps.pool, deps.bus),
      launchConfig: (launchId) => getLaunchConfig(deps.bus, launchId),
      env,
    });
    return { kind: 'solana', client };
  } catch (err) {
    // Config errors name the missing variable, never a value.
    const reason = err instanceof Error ? err.message : 'chain configuration failed';
    const network = env.CARBON_NETWORK === 'mainnet-beta' && env.CARBON_MAINNET_ENABLED === 'true' ? 'mainnet-beta' : 'devnet';
    return { kind: 'unavailable', client: new UnavailableChainClient(network, reason), reason };
  }
}

/** The chain package's schema (sol_* tables). */
export async function chainMigrations(pool: pg.Pool): Promise<string[]> {
  await ensureSchema(pool);
  return ['solana/schema'];
}
