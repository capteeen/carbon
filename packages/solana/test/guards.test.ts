import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { createTransferCheckedInstruction, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import BN from 'bn.js';
import { pumpSdk } from '../src/sdk.js';
import { assertAllowed, type TxPurpose } from '../src/allowlist.js';
import { assertNetworkAllowed, describeConfig, loadSolanaConfig } from '../src/config.js';
import { NetworkGuardError, TradeNotAllowedError, ChainConfigError, KeyVaultError } from '../src/errors.js';
import { buildNativeLaunchIxs, argonShares } from '../src/pump.js';
import { openKeypair, sealKeypair } from '../src/vault.js';
import { ArgonChainClient } from '../src/client.js';
import { FakeChain } from './helpers/fakeChain.js';
import { testEnv, testKeys } from './helpers/env.js';
import { fixtureFeeConfig, fixtureGlobal } from './fixtures/pump.js';

const { PUMP_SDK } = pumpSdk;
const pk = () => Keypair.generate().publicKey;

describe('network guard', () => {
  const k = testKeys();
  it('defaults to devnet and the devnet RPC', () => {
    const cfg = loadSolanaConfig(testEnv(k));
    expect(cfg.network).toBe('devnet');
    expect(cfg.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(cfg.feeMode).toBe('native');
  });
  it('refuses mainnet without ARGON_MAINNET_ENABLED=true', () => {
    expect(() => loadSolanaConfig(testEnv(k, { ARGON_NETWORK: 'mainnet-beta' }))).toThrow(NetworkGuardError);
    expect(() => loadSolanaConfig(testEnv(k, { ARGON_NETWORK: 'mainnet-beta', ARGON_MAINNET_ENABLED: 'yes' }))).toThrow(NetworkGuardError);
    expect(() => loadSolanaConfig(testEnv(k, { ARGON_MAINNET_ENABLED: 'true' }))).not.toThrow(); // flag alone stays devnet
    expect(loadSolanaConfig(testEnv(k, { ARGON_MAINNET_ENABLED: 'true' })).network).toBe('devnet');
  });
  it('allows mainnet only with both, and refuses mismatched RPC URLs', () => {
    const cfg = loadSolanaConfig(testEnv(k, { ARGON_NETWORK: 'mainnet-beta', ARGON_MAINNET_ENABLED: 'true' }));
    expect(cfg.network).toBe('mainnet-beta');
    expect(() => loadSolanaConfig(testEnv(k, { ARGON_RPC_URL: 'https://api.mainnet-beta.solana.com' }))).toThrow(NetworkGuardError);
    expect(() => assertNetworkAllowed('mainnet-beta', 'true', 'https://api.devnet.solana.com')).toThrow(NetworkGuardError);
    expect(() => assertNetworkAllowed('testnet', 'true', 'https://x')).toThrow(NetworkGuardError);
  });
  it('the client re-checks at construction: a hand-built mainnet config without the flag is refused', () => {
    const env = testEnv(k, { ARGON_NETWORK: 'mainnet-beta', ARGON_MAINNET_ENABLED: 'true' });
    const cfg = loadSolanaConfig(env);
    const deps = { config: cfg, rpc: new FakeChain().rpc(), db: {} as never };
    expect(() => new ArgonChainClient({ ...deps, env: { ...env, ARGON_MAINNET_ENABLED: undefined } })).toThrow(NetworkGuardError);
    expect(new ArgonChainClient({ ...deps, env }).network).toBe('mainnet-beta');
  });
  it('never exposes secrets through JSON, inspect, spread or errors', () => {
    const env = testEnv(k);
    const cfg = loadSolanaConfig(env);
    const crankB58 = env['ARGON_CRANK_KEY']!;
    for (const s of [JSON.stringify(cfg), inspect(cfg, { depth: 5 }), JSON.stringify({ ...cfg }), JSON.stringify(describeConfig(cfg)), inspect(cfg.secrets)]) {
      expect(s).not.toContain(crankB58);
      expect(s).not.toContain(env['ARGON_VAULT_KEY']!);
      expect(s).not.toContain('test-jwt-not-a-secret');
    }
    try {
      loadSolanaConfig({ ...env, ARGON_CRANK_KEY: crankB58.slice(0, 40) });
    } catch (e) {
      expect(e).toBeInstanceOf(ChainConfigError);
      expect(String(e)).not.toContain(crankB58.slice(0, 40));
    }
  });
  it('refuses a buyback key that does not match the buyback wallet', () => {
    expect(() => loadSolanaConfig(testEnv(k, { ARGON_BUYBACK_KEY: bs58.encode(Keypair.generate().secretKey) }))).toThrow(/does not belong/);
  });
});

describe('vault (AES-256-GCM)', () => {
  it('round-trips a keypair and binds the blob to its label and key', () => {
    const key = new Uint8Array(32).fill(7);
    const kp = Keypair.generate();
    const blob = sealKeypair(key, kp, 'carbon/launch/A/mint');
    expect(blob).not.toContain(bs58.encode(kp.secretKey));
    expect(openKeypair(key, blob, 'carbon/launch/A/mint').publicKey.equals(kp.publicKey)).toBe(true);
    expect(() => openKeypair(key, blob, 'carbon/launch/B/mint')).toThrow(KeyVaultError);
    expect(() => openKeypair(new Uint8Array(32).fill(8), blob, 'carbon/launch/A/mint')).toThrow(KeyVaultError);
    const tampered = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => openKeypair(key, tampered, 'carbon/launch/A/mint')).toThrow(KeyVaultError);
  });
});

describe('trade allowlist', () => {
  const mint = pk();
  const argonMint = pk();
  const user = pk();
  const buyback = pk();
  const treasury = pk();
  const launchPurpose = (shares = argonShares(user, buyback, treasury)): Extract<TxPurpose, { kind: 'launch' }> => ({ kind: 'launch', mint, creator: user, payer: user, devBuyMaxLamports: 250_000_000n, shares });

  const buyIx = (m: PublicKey, u: PublicKey, maxCost: bigint) =>
    PUMP_SDK.getBuyInstructionRaw({ user: u, mint: m, creator: pk(), amount: new BN(1000), solAmount: new BN(maxCost.toString()), feeRecipient: pk(), buybackFeeRecipient: pk(), tokenProgram: TOKEN_2022_PROGRAM_ID });

  it('shares are exactly 5000/3000/2000, sum to 10000, and must be distinct wallets', () => {
    const s = argonShares(user, buyback, treasury);
    expect(s.map((x) => x.bps)).toEqual([5000, 3000, 2000]);
    expect(s.reduce((a, x) => a + x.bps, 0)).toBe(10_000);
    expect(() => argonShares(user, user, treasury)).toThrow(/differ/);
  });

  it('accepts the built native launch and rejects altered shares, mints and creators', async () => {
    const built = await buildNativeLaunchIxs({ global: fixtureGlobal(), feeConfig: fixtureFeeConfig(), mint, payer: user, name: 'A', symbol: 'A', uri: 'u', devBuyLamports: 250_000_000n, buybackWallet: buyback, treasuryWallet: treasury });
    expect(() => assertAllowed(built.instructions, built.purpose)).not.toThrow();
    const wrongShares = launchPurpose([
      { address: user, bps: 6000 },
      { address: buyback, bps: 2000 },
      { address: treasury, bps: 2000 },
    ]);
    expect(() => assertAllowed(built.instructions, wrongShares)).toThrow(/bps/);
    expect(() => assertAllowed(built.instructions, { ...launchPurpose(), mint: pk() })).toThrow(TradeNotAllowedError);
    expect(() => assertAllowed(built.instructions, { ...launchPurpose(), creator: pk() })).toThrow(TradeNotAllowedError);
    expect(() => assertAllowed(built.instructions, { ...launchPurpose(), devBuyMaxLamports: 100_000_000n })).toThrow(/exceeds the config cap/);
  });

  it('refuses every sell, buys of other mints, and buys outside launch/buyback', async () => {
    const sell = await PUMP_SDK.getSellInstructionRaw({ user, mint, creator: pk(), amount: new BN(1), solAmount: new BN(1), feeRecipient: pk(), buybackFeeRecipient: pk(), tokenProgram: TOKEN_2022_PROGRAM_ID } as never);
    expect(() => assertAllowed([sell], launchPurpose())).toThrow(/sell.*not on the allowlist/i);
    expect(() => assertAllowed([sell], { kind: 'buyback', argonMint: mint, buyer: user, maxLamports: 10n ** 12n })).toThrow(TradeNotAllowedError);
    const otherMint = await buyIx(pk(), user, 1000n);
    expect(() => assertAllowed([otherMint], launchPurpose())).toThrow(/dev buy mint/);
    expect(() => assertAllowed([otherMint], { kind: 'buyback', argonMint, buyer: user, maxLamports: 10_000n })).toThrow(/\$ARGON/);
    const argonBuy = await buyIx(argonMint, user, 10_000n);
    expect(() => assertAllowed([argonBuy], { kind: 'buyback', argonMint, buyer: user, maxLamports: 10_000n })).not.toThrow();
    expect(() => assertAllowed([argonBuy], { kind: 'buyback', argonMint, buyer: user, maxLamports: 9_999n })).toThrow(/exceeds/);
    expect(() => assertAllowed([argonBuy], { kind: 'crank', mint: argonMint })).toThrow(TradeNotAllowedError);
    expect(() => assertAllowed([argonBuy], { kind: 'split', from: user, recipients: [buyback] })).toThrow(TradeNotAllowedError);
  });

  it('refuses unknown programs and split transfers to anyone but the three legs', () => {
    const jupiter = new TransactionInstruction({ programId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), keys: [], data: Buffer.from([1]) });
    expect(() => assertAllowed([jupiter], { kind: 'buyback', argonMint, buyer: user, maxLamports: 1n })).toThrow(/not on the allowlist/);
    const from = pk();
    const ok = SystemProgram.transfer({ fromPubkey: from, toPubkey: buyback, lamports: 5 });
    const evil = SystemProgram.transfer({ fromPubkey: from, toPubkey: pk(), lamports: 5 });
    expect(() => assertAllowed([ok], { kind: 'split', from, recipients: [user, buyback, treasury] })).not.toThrow();
    expect(() => assertAllowed([evil], { kind: 'split', from, recipients: [user, buyback, treasury] })).toThrow(/not a split recipient/);
    expect(() => assertAllowed([ok], { kind: 'crank', mint })).toThrow(TradeNotAllowedError);
    const create = SystemProgram.createAccount({ fromPubkey: from, newAccountPubkey: pk(), lamports: 1, space: 0, programId: SystemProgram.programId });
    expect(() => assertAllowed([create], { kind: 'split', from, recipients: [buyback] })).toThrow(/system instruction 0/);
  });

  it('airdrops move only the daughter mint from the crank wallet', () => {
    const crank = pk();
    const t = createTransferCheckedInstruction(pk(), mint, pk(), crank, 10n, 6, [], TOKEN_2022_PROGRAM_ID);
    expect(() => assertAllowed([t], { kind: 'airdrop', mint, from: crank })).not.toThrow();
    expect(() => assertAllowed([t], { kind: 'airdrop', mint: pk(), from: crank })).toThrow(/airdrop mint/);
    expect(() => assertAllowed([t], { kind: 'split', from: crank, recipients: [] })).toThrow(TradeNotAllowedError);
    const wsol = createTransferCheckedInstruction(pk(), NATIVE_MINT, pk(), crank, 10n, 9, [], TOKEN_2022_PROGRAM_ID);
    expect(() => assertAllowed([wsol], { kind: 'airdrop', mint, from: crank })).toThrow();
  });
});
