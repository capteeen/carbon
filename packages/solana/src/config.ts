/**
 * Environment for @carbon/solana, read once. Devnet by default; mainnet only
 * when CARBON_NETWORK=mainnet-beta AND CARBON_MAINNET_ENABLED=true.
 *
 * Secrets (vault key, crank key, buyback key, Pinata JWT) are stored as
 * non-enumerable properties, so JSON.stringify / util.inspect / spreads of the
 * config never contain them. Errors name the variable, never its value.
 */
import { inspect } from 'node:util';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ChainConfigError, NetworkGuardError } from './errors.js';

export type Network = 'devnet' | 'mainnet-beta';
export type FeeMode = 'native' | 'wallet';
export type EnvLike = Record<string, string | undefined>;

export const ENV = {
  NETWORK: 'CARBON_NETWORK',
  MAINNET_ENABLED: 'CARBON_MAINNET_ENABLED',
  RPC_URL: 'CARBON_RPC_URL',
  FEE_MODE: 'CARBON_FEE_MODE',
  VAULT_KEY: 'CARBON_VAULT_KEY',
  BUYBACK_WALLET: 'CARBON_BUYBACK_WALLET',
  TREASURY_WALLET: 'CARBON_TREASURY_WALLET',
  CRANK_KEY: 'CARBON_CRANK_KEY',
  BUYBACK_KEY: 'CARBON_BUYBACK_KEY',
  CARBON_MINT: 'CARBON_MINT',
  PINATA_JWT: 'PINATA_JWT',
  LOOKUP_TABLE: 'CARBON_LOOKUP_TABLE',
  PUMP_API_URL: 'PUMP_FRONTEND_API_URL',
  IPFS_GATEWAY: 'CARBON_IPFS_GATEWAY',
  PRIORITY_FEE: 'CARBON_PRIORITY_FEE_MICROLAMPORTS',
} as const;

export const DEFAULT_RPC_URL: Record<Network, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};
export const DEFAULT_PUMP_API_URL = 'https://frontend-api-v3.pump.fun';
export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export interface SolanaConfig {
  readonly network: Network;
  readonly rpcUrl: string;
  readonly feeMode: FeeMode;
  readonly buybackWallet: PublicKey;
  readonly treasuryWallet: PublicKey;
  /** $CARBON mint; required only by buyCarbon. */
  readonly carbonMint: PublicKey | null;
  /** Optional address lookup table for the launch transaction. */
  readonly lookupTable: PublicKey | null;
  readonly pumpApiUrl: string;
  readonly ipfsGateway: string;
  readonly priorityFeeMicroLamports: number;
  /** Non-enumerable. */
  readonly secrets: SolanaSecrets;
}

/** Holder for secrets. Every field is non-enumerable and inspect() prints only presence. */
export class SolanaSecrets {
  declare readonly vaultKey: Uint8Array;
  declare readonly crankKey: Keypair | null;
  declare readonly buybackKey: Keypair | null;
  declare readonly pinataJwt: string | null;
  constructor(v: { vaultKey: Uint8Array; crankKey: Keypair | null; buybackKey: Keypair | null; pinataJwt: string | null }) {
    for (const [k, val] of Object.entries(v)) Object.defineProperty(this, k, { value: val, enumerable: false, writable: false });
  }
  toJSON(): Record<string, string> {
    return { vaultKey: '[set]', crankKey: this.crankKey ? '[set]' : '[unset]', buybackKey: this.buybackKey ? '[set]' : '[unset]', pinataJwt: this.pinataJwt ? '[set]' : '[unset]' };
  }
  [inspect.custom](): string {
    return `SolanaSecrets ${JSON.stringify(this.toJSON())}`;
  }
  requireCrank(): Keypair {
    if (!this.crankKey) throw new ChainConfigError(`${ENV.CRANK_KEY} is required for this operation (Carbon fee payer for cranks, splits and decay)`);
    return this.crankKey;
  }
  requireBuyback(): Keypair {
    if (!this.buybackKey) throw new ChainConfigError(`${ENV.BUYBACK_KEY} is required for $CARBON buybacks`);
    return this.buybackKey;
  }
  requirePinata(): string {
    if (!this.pinataJwt) throw new ChainConfigError(`${ENV.PINATA_JWT} is required for metadata uploads`);
    return this.pinataJwt;
  }
}

function opt(env: EnvLike, name: string): string | undefined {
  const v = env[name];
  return v !== undefined && v.trim().length > 0 ? v.trim() : undefined;
}

function req(env: EnvLike, name: string, what: string): string {
  const v = opt(env, name);
  if (v === undefined) throw new ChainConfigError(`${name} is required (${what})`);
  return v;
}

function pubkey(env: EnvLike, name: string, required: true): PublicKey;
function pubkey(env: EnvLike, name: string, required: false): PublicKey | null;
function pubkey(env: EnvLike, name: string, required: boolean): PublicKey | null {
  const v = required ? req(env, name, 'base58 public key') : opt(env, name);
  if (v === undefined) return null;
  try {
    return new PublicKey(v);
  } catch {
    throw new ChainConfigError(`${name} is not a valid base58 public key`);
  }
}

/** 32-byte key as 64 hex chars or base64. */
export function parseVaultKey(raw: string, name: string = ENV.VAULT_KEY): Uint8Array {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Uint8Array.from(Buffer.from(s, 'hex'));
  if (/^[A-Za-z0-9+/]{43}=?$/.test(s)) {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return Uint8Array.from(b);
  }
  throw new ChainConfigError(`${name} must be 32 bytes as 64 hex characters or base64`);
}

/** A 64-byte ed25519 secret key as base58 or a JSON array (solana-keygen format). */
export function parseSecretKey(raw: string, name: string): Keypair {
  const s = raw.trim();
  let bytes: Uint8Array | null = null;
  try {
    if (s.startsWith('[')) {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr) && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) bytes = Uint8Array.from(arr as number[]);
    } else {
      bytes = bs58.decode(s);
    }
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length !== 64) throw new ChainConfigError(`${name} must be a 64-byte secret key (base58 or JSON byte array)`);
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new ChainConfigError(`${name} is not a valid ed25519 secret key`);
  }
}

/**
 * The network guard. Throws NetworkGuardError unless the network is devnet,
 * or mainnet-beta with CARBON_MAINNET_ENABLED=true. Also refuses a devnet
 * config pointed at a mainnet RPC (and the reverse).
 */
export function assertNetworkAllowed(network: string, mainnetEnabledRaw: string | undefined, rpcUrl: string): Network {
  if (network !== 'devnet' && network !== 'mainnet-beta') {
    throw new NetworkGuardError(`${ENV.NETWORK} must be 'devnet' or 'mainnet-beta'`);
  }
  if (network === 'mainnet-beta' && mainnetEnabledRaw !== 'true') {
    throw new NetworkGuardError(`refusing to construct a mainnet client: ${ENV.NETWORK}=mainnet-beta requires ${ENV.MAINNET_ENABLED}=true`);
  }
  const u = rpcUrl.toLowerCase();
  if (network === 'devnet' && u.includes('mainnet')) {
    throw new NetworkGuardError(`${ENV.RPC_URL} names mainnet while ${ENV.NETWORK}=devnet`);
  }
  if (network === 'mainnet-beta' && (u.includes('devnet') || u.includes('testnet'))) {
    throw new NetworkGuardError(`${ENV.RPC_URL} names devnet/testnet while ${ENV.NETWORK}=mainnet-beta`);
  }
  return network;
}

export function loadSolanaConfig(env: EnvLike = process.env): SolanaConfig {
  const networkRaw = opt(env, ENV.NETWORK) ?? 'devnet';
  const rpcUrlCandidate = opt(env, ENV.RPC_URL) ?? DEFAULT_RPC_URL[networkRaw === 'mainnet-beta' ? 'mainnet-beta' : 'devnet'];
  const network = assertNetworkAllowed(networkRaw, opt(env, ENV.MAINNET_ENABLED), rpcUrlCandidate);
  if (!/^https?:\/\//.test(rpcUrlCandidate)) throw new ChainConfigError(`${ENV.RPC_URL} must be an http(s) URL`);

  const feeModeRaw = opt(env, ENV.FEE_MODE) ?? 'native';
  if (feeModeRaw !== 'native' && feeModeRaw !== 'wallet') throw new ChainConfigError(`${ENV.FEE_MODE} must be 'native' or 'wallet'`);

  const vaultKey = parseVaultKey(req(env, ENV.VAULT_KEY, '32-byte key for secrets at rest'));
  const crankRaw = opt(env, ENV.CRANK_KEY);
  const buybackRaw = opt(env, ENV.BUYBACK_KEY);
  const crankKey = crankRaw ? parseSecretKey(crankRaw, ENV.CRANK_KEY) : null;
  const buybackKey = buybackRaw ? parseSecretKey(buybackRaw, ENV.BUYBACK_KEY) : null;

  const buybackWallet = pubkey(env, ENV.BUYBACK_WALLET, true);
  const treasuryWallet = pubkey(env, ENV.TREASURY_WALLET, true);
  if (buybackWallet.equals(treasuryWallet)) throw new ChainConfigError(`${ENV.BUYBACK_WALLET} and ${ENV.TREASURY_WALLET} must differ (pump-fees refuses duplicate shareholders)`);
  if (buybackKey && !buybackKey.publicKey.equals(buybackWallet)) {
    throw new ChainConfigError(`${ENV.BUYBACK_KEY} does not belong to ${ENV.BUYBACK_WALLET}`);
  }

  const feeRaw = opt(env, ENV.PRIORITY_FEE) ?? '0';
  const priorityFeeMicroLamports = Number(feeRaw);
  if (!Number.isSafeInteger(priorityFeeMicroLamports) || priorityFeeMicroLamports < 0 || priorityFeeMicroLamports > 10_000_000) {
    throw new ChainConfigError(`${ENV.PRIORITY_FEE} must be an integer between 0 and 10000000`);
  }

  const secrets = new SolanaSecrets({ vaultKey, crankKey, buybackKey, pinataJwt: opt(env, ENV.PINATA_JWT) ?? null });
  const cfg = {
    network,
    rpcUrl: rpcUrlCandidate,
    feeMode: feeModeRaw,
    buybackWallet,
    treasuryWallet,
    carbonMint: pubkey(env, ENV.CARBON_MINT, false),
    lookupTable: pubkey(env, ENV.LOOKUP_TABLE, false),
    pumpApiUrl: (opt(env, ENV.PUMP_API_URL) ?? DEFAULT_PUMP_API_URL).replace(/\/+$/, ''),
    ipfsGateway: opt(env, ENV.IPFS_GATEWAY) ?? DEFAULT_IPFS_GATEWAY,
    priorityFeeMicroLamports,
  } as Omit<SolanaConfig, 'secrets'>;
  Object.defineProperty(cfg, 'secrets', { value: secrets, enumerable: false, writable: false });
  return cfg as SolanaConfig;
}

/** Loggable view of a config: no secrets. */
export function describeConfig(cfg: SolanaConfig): Record<string, unknown> {
  return {
    network: cfg.network,
    rpcUrl: cfg.rpcUrl.replace(/([?&]api[-_]?key=)[^&]+/i, '$1[redacted]'),
    feeMode: cfg.feeMode,
    buybackWallet: cfg.buybackWallet.toBase58(),
    treasuryWallet: cfg.treasuryWallet.toBase58(),
    carbonMint: cfg.carbonMint?.toBase58() ?? null,
    lookupTable: cfg.lookupTable?.toBase58() ?? null,
    secrets: cfg.secrets.toJSON(),
  };
}
