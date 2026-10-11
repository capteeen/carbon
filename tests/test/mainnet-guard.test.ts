/**
 * SPEC §2: "Devnet by default. Mainnet only behind an env flag the owner sets."
 * ARCHITECTURE: mainnet only when CARBON_NETWORK=mainnet-beta AND CARBON_MAINNET_ENABLED=true.
 * Every place that decides the network: @carbon/solana (config + client construction),
 * the worker's chain seam, the web app's displayed network, and the browser wallet RPC.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { CarbonChainClient, NetworkGuardError, assertNetworkAllowed, loadSolanaConfig } from '@carbon/solana';
import { network as webNetwork } from '@/server/env';
import { createChainClient as workerChain } from '../../apps/worker/src/chain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function base(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CARBON_VAULT_KEY: randomBytes(32).toString('hex'),
    CARBON_BUYBACK_WALLET: Keypair.generate().publicKey.toBase58(),
    CARBON_TREASURY_WALLET: Keypair.generate().publicKey.toBase58(),
    ...extra,
  };
}

const MATRIX: [string | undefined, string | undefined, 'devnet' | 'mainnet-beta' | 'refused'][] = [
  [undefined, undefined, 'devnet'],
  ['devnet', 'true', 'devnet'],
  ['mainnet-beta', undefined, 'refused'],
  ['mainnet-beta', 'false', 'refused'],
  ['mainnet-beta', 'TRUE', 'refused'],
  ['mainnet-beta', '1', 'refused'],
  ['mainnet-beta', 'yes', 'refused'],
  ['mainnet', 'true', 'refused'],
  ['testnet', 'true', 'refused'],
  [undefined, 'true', 'devnet'],
  ['mainnet-beta', 'true', 'mainnet-beta'],
];

describe('mainnet only with CARBON_NETWORK=mainnet-beta AND CARBON_MAINNET_ENABLED=true', () => {
  for (const [net, enabled, want] of MATRIX) {
    it(`CARBON_NETWORK=${net ?? '(unset)'} CARBON_MAINNET_ENABLED=${enabled ?? '(unset)'} → ${want}`, () => {
      const env = base({ CARBON_NETWORK: net, CARBON_MAINNET_ENABLED: enabled });
      if (want === 'refused') {
        expect(() => loadSolanaConfig(env)).toThrow(NetworkGuardError);
        const w = workerChain({ pool: {} as never, bus: {} as never, env: env as NodeJS.ProcessEnv });
        expect(w.kind).toBe('unavailable');
        expect(w.client.network).toBe('devnet');
      } else {
        expect(loadSolanaConfig(env).network).toBe(want);
        expect(workerChain({ pool: {} as never, bus: {} as never, env: env as NodeJS.ProcessEnv }).client.network).toBe(want);
      }
      // what the web app shows must agree with what the chain client would do
      const shown = webNetwork(env as NodeJS.ProcessEnv);
      if (want === 'refused') expect(shown).toBe('devnet');
      else expect(shown).toBe(want);
    });
  }

  // Fails safe, but inconsistent: loadSolanaConfig trims the flag (" true" → mainnet-beta)
  // while CarbonChainClient re-checks the raw env value and refuses, so the worker boots
  // with the chain "unavailable" and the web app shows devnet.
  it('[AG-018] a whitespace-padded flag never yields a mainnet client (config and client disagree, but fail safe)', () => {
    const env = base({ CARBON_NETWORK: 'mainnet-beta', CARBON_MAINNET_ENABLED: ' true' });
    expect(loadSolanaConfig(env).network).toBe('mainnet-beta');
    const w = workerChain({ pool: {} as never, bus: {} as never, env: env as NodeJS.ProcessEnv });
    expect(w.kind).toBe('unavailable');
    expect(webNetwork(env as NodeJS.ProcessEnv)).toBe('devnet');
  });

  it('a hand-built config cannot bypass the guard: CarbonChainClient re-checks at construction', () => {
    const cfg = loadSolanaConfig(base());
    const forged = Object.assign(Object.create(Object.getPrototypeOf(cfg)), cfg, { network: 'mainnet-beta' });
    Object.defineProperty(forged, 'secrets', { value: cfg.secrets });
    expect(() => new CarbonChainClient({ config: forged, rpc: {} as never, db: {} as never, env: {} })).toThrow(NetworkGuardError);
  });

  it('a devnet config pointed at an RPC URL that names mainnet is refused', () => {
    expect(() => loadSolanaConfig(base({ CARBON_RPC_URL: 'https://api.mainnet-beta.solana.com' }))).toThrow(NetworkGuardError);
    expect(() => assertNetworkAllowed('devnet', undefined, 'https://mainnet.helius-rpc.com/?api-key=x')).toThrow(NetworkGuardError);
  });

  // The guard only string-matches "mainnet" in CARBON_RPC_URL. Plenty of mainnet RPC URLs do
  // not contain it (e.g. https://rpc.ankr.com/solana, https://solana-rpc.publicnode.com,
  // private/self-hosted nodes). With neither flag set, such a URL yields a client that
  // labels itself devnet and moves real SOL. A genesis-hash check (getGenesisHash) would close it.
  it.fails('[AG-011] without the two flags, an RPC endpoint that is mainnet but does not say so in its URL is refused', () => {
    expect(() => loadSolanaConfig(base({ CARBON_RPC_URL: 'https://rpc.ankr.com/solana' }))).toThrow(NetworkGuardError);
  });

  it('the browser wallet connection defaults to devnet and the explorer links follow the launch’s own network', () => {
    const providers = readFileSync(path.join(ROOT, 'apps/web/src/components/Providers.tsx'), 'utf8');
    expect(providers).toMatch(/clusterApiUrl\('devnet'\)/);
    expect(providers).not.toMatch(/mainnet/);
  });
});
