import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { launchConfig } from '@argon/core';
import { pumpSdk } from '../src/sdk.js';
import { decodePumpIx, PUMP_PROGRAM_ID } from '../src/programs.js';
import { buildNativeLaunchIxs, launchLookupAddresses } from '../src/pump.js';
import type { Db } from '../src/db.js';
import { LaunchNotAllowedError, TxTooLargeError } from '../src/errors.js';
import { FakeChain } from './helpers/fakeChain.js';
import { encodeAccount } from './helpers/events.js';
import { makeClient, testDb, testEnv, testKeys } from './helpers/env.js';
import { fixtureFeeConfig, fixtureGlobal } from './fixtures/pump.js';

const { GLOBAL_PDA, feeSharingConfigPda, creatorVaultPda, bondingCurvePda } = pumpSdk;
const CFG = launchConfig('Ar-36', 'ring'); // devBuySol 0.25
const URI = 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

async function chainWithGlobal(): Promise<FakeChain> {
  const chain = new FakeChain();
  const g = fixtureGlobal();
  chain.accounts.set(GLOBAL_PDA.toBase58(), { data: await encodeAccount('pump', 'global', g as unknown as Record<string, unknown>), owner: PUMP_PROGRAM_ID, lamports: 1, executable: false });
  return chain;
}

function decompile(tx: VersionedTransaction, alt?: AddressLookupTableAccount | null): TransactionInstruction[] {
  const msg = tx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: alt ? [alt] : [] });
  return msg.compiledInstructions.map((ci) => ({
    programId: keys.get(ci.programIdIndex)!,
    keys: ci.accountKeyIndexes.map((i) => ({ pubkey: keys.get(i)!, isSigner: msg.isAccountSigner(i), isWritable: msg.isAccountWritable(i) })),
    data: Buffer.from(ci.data),
  }));
}

/** An owner-created lookup table (as scripts/devnet-spike.ts makes) holding the static launch accounts. */
async function lookupTableFor(): Promise<AddressLookupTableAccount> {
  const sample = await buildNativeLaunchIxs({
    global: fixtureGlobal(),
    feeConfig: fixtureFeeConfig(),
    mint: Keypair.generate().publicKey,
    payer: Keypair.generate().publicKey,
    name: 'x',
    symbol: 'x',
    uri: 'x',
    devBuyLamports: 100_000_000n,
    buybackWallet: Keypair.generate().publicKey,
    treasuryWallet: Keypair.generate().publicKey,
  });
  // Static accounts only: drop per-launch PDAs by keeping keys that repeat across two samples.
  const other = await buildNativeLaunchIxs({
    global: fixtureGlobal(),
    feeConfig: fixtureFeeConfig(),
    mint: Keypair.generate().publicKey,
    payer: Keypair.generate().publicKey,
    name: 'x',
    symbol: 'x',
    uri: 'x',
    devBuyLamports: 100_000_000n,
    buybackWallet: Keypair.generate().publicKey,
    treasuryWallet: Keypair.generate().publicKey,
  });
  const a = new Set(launchLookupAddresses(other.instructions, PublicKey.default, PublicKey.default).map((k) => k.toBase58()));
  const addrs = launchLookupAddresses(sample.instructions, PublicKey.default, PublicKey.default).filter((k) => a.has(k.toBase58()));
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: addrs },
  });
}

describe('launch transaction (native fee sharing)', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  it('createLaunchWallet is idempotent, returns the sharing-config PDA, and stores the mint key sealed', async () => {
    const keys = testKeys();
    const client = makeClient({ env: testEnv(keys), rpc: (await chainWithGlobal()).rpc(), db });
    const a = await client.createLaunchWallet('L-idem');
    const b = await client.createLaunchWallet('L-idem');
    expect(b).toEqual(a);
    expect(Object.keys(a)).toEqual(['address']);
    const row = (await db.query(`SELECT mint, mint_secret, creator_secret FROM sol_launches WHERE launch_id='L-idem'`)).rows[0]!;
    expect(a.address).toBe(feeSharingConfigPda(new PublicKey(row.mint)).toBase58());
    expect(row.mint_secret).toMatch(/^v1:/);
    expect(row.creator_secret).toBeNull(); // native mode holds no per-launch creator key
    // concurrent first calls agree
    const [x, y] = await Promise.all([client.createLaunchWallet('L-race'), client.createLaunchWallet('L-race')]);
    expect(x).toEqual(y);
  });

  it('refuses without the approval hook, when the hook refuses, or when devBuySol differs from the config', async () => {
    const keys = testKeys();
    const chain = await chainWithGlobal();
    const payer = Keypair.generate().publicKey.toBase58();
    const args = { launchId: 'L-gate', payer, name: 'Argon Gate', symbol: 'GATE', metadataUri: URI, devBuySol: CFG.devBuySol, approvalId: 'appr-1' };
    const noHook = makeClient({ env: testEnv(keys), rpc: chain.rpc(), db });
    await noHook.createLaunchWallet('L-gate');
    await expect(noHook.buildLaunchTx(args)).rejects.toBeInstanceOf(LaunchNotAllowedError);
    const refusing = makeClient({
      env: testEnv(keys),
      rpc: chain.rpc(),
      db,
      assertLaunchAllowed: async () => {
        throw new LaunchNotAllowedError('approval not consumed');
      },
    });
    await expect(refusing.buildLaunchTx(args)).rejects.toThrow(/approval not consumed/);
    const ok = makeClient({ env: testEnv(keys), rpc: chain.rpc(), db, assertLaunchAllowed: async () => undefined });
    await expect(ok.buildLaunchTx({ ...args, devBuySol: 5 })).rejects.toThrow(/differs from the config/);
    await expect(ok.buildLaunchTx({ ...args, approvalId: '' })).rejects.toBeInstanceOf(LaunchNotAllowedError);
  });

  it('builds ONE v0 transaction: create_v2 → fee sharing → 50/30/20 shares → dev buy, creator = payer, partially signed by the mint', async () => {
    const keys = testKeys();
    const env = testEnv(keys, { ARGON_LOOKUP_TABLE: Keypair.generate().publicKey.toBase58() });
    const chain = await chainWithGlobal();
    const seen: [string, string][] = [];
    const client = makeClient({ env, rpc: chain.rpc(), db, assertLaunchAllowed: async (l, a) => void seen.push([l, a]) });
    const user = Keypair.generate();
    await client.createLaunchWallet('L-native');

    const args = { launchId: 'L-native', payer: user.publicKey.toBase58(), name: 'Argon One', symbol: 'ONE', metadataUri: URI, devBuySol: CFG.devBuySol, approvalId: 'appr-n' };
    // Without a lookup table the native launch does not fit one packet.
    const noAlt = makeClient({ env: { ...env, ARGON_LOOKUP_TABLE: undefined }, rpc: chain.rpc(), db, assertLaunchAllowed: async () => undefined });
    await expect(noAlt.buildLaunchTx(args)).rejects.toBeInstanceOf(TxTooLargeError);
    // Configured but not on chain: refused, never guessed.
    await expect(client.buildLaunchTx(args)).rejects.toThrow(/ARGON_LOOKUP_TABLE account not found/);
    chain.lookupTable = await lookupTableFor();

    const { txBase64, mint } = await client.buildLaunchTx({ launchId: 'L-native', payer: user.publicKey.toBase58(), name: 'Argon One', symbol: 'ONE', metadataUri: URI, devBuySol: CFG.devBuySol, approvalId: 'appr-n' });
    expect(seen).toContainEqual(['L-native', 'appr-n']);
    const raw = Buffer.from(txBase64, 'base64');
    expect(raw.length).toBeLessThanOrEqual(1232);
    const tx = VersionedTransaction.deserialize(raw);
    expect(tx.version).toBe(0);
    const mintKey = new PublicKey(mint);
    // signers: exactly the payer (fee payer, first) and the mint
    const n = tx.message.header.numRequiredSignatures;
    expect(n).toBe(2);
    expect(tx.message.staticAccountKeys[0]!.equals(user.publicKey)).toBe(true);
    expect(tx.message.staticAccountKeys.slice(0, n).map((k) => k.toBase58()).sort()).toEqual([user.publicKey.toBase58(), mint].sort());
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true); // user signs client-side
    expect(tx.signatures[1]!.some((b) => b !== 0)).toBe(true); // mint partially signed

    const ixs = decompile(tx, chain.lookupTable);
    const pump = ixs.map(decodePumpIx).filter((d) => d !== null);
    expect(pump.map((d) => `${d!.program}.${d!.name}`)).toEqual(['pump.createV2', 'fees.createFeeSharingConfig', 'fees.updateFeeShares', 'pump.buy']);
    const [create, cfg, upd, buy] = pump as NonNullable<(typeof pump)[number]>[];

    // create_v2: creator arg = payer = user; mint is a signer
    expect((create!.data['creator'] as PublicKey).equals(user.publicKey)).toBe(true);
    expect(create!.account('user').equals(user.publicKey)).toBe(true);
    expect(create!.account('mint').equals(mintKey)).toBe(true);
    expect(create!.data['isMayhemMode']).toBe(false);
    expect(create!.data['uri']).toBe(URI);
    const createIx = ixs.find((ix) => ix.programId.equals(PUMP_PROGRAM_ID))!;
    expect(createIx.keys[0]!.isSigner && createIx.keys[0]!.isWritable).toBe(true);

    // sharing config paid by the creator; update_fee_shares by the same authority
    expect(cfg!.account('payer').equals(user.publicKey)).toBe(true);
    expect(cfg!.account('sharingConfig').equals(feeSharingConfigPda(mintKey))).toBe(true);
    expect(upd!.account('authority').equals(user.publicKey)).toBe(true);
    const shares = upd!.data['shareholders'] as { address: PublicKey; shareBps: number }[];
    expect(shares.map((s) => [s.address.toBase58(), s.shareBps])).toEqual([
      [user.publicKey.toBase58(), 5000],
      [keys.buyback.publicKey.toBase58(), 3000],
      [keys.treasury.publicKey.toBase58(), 2000],
    ]);
    expect(shares.reduce((s, x) => s + x.shareBps, 0)).toBe(10_000);

    // dev buy: on this mint, by the user, paying into the sharing config's creator vault, capped at devBuySol
    expect(buy!.account('mint').equals(mintKey)).toBe(true);
    expect(buy!.account('user').equals(user.publicKey)).toBe(true);
    expect(buy!.account('creatorVault').equals(creatorVaultPda(feeSharingConfigPda(mintKey)))).toBe(true);
    expect(buy!.account('bondingCurve').equals(bondingCurvePda(mintKey))).toBe(true);
    expect(String(buy!.data['maxSolCost'])).toBe('250000000');
    expect(BigInt(String(buy!.data['amount']))).toBeGreaterThan(0n);
    // token account under Token-2022 (create_v2 coins)
    expect(ixs.some((ix) => ix.keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID)))).toBe(true);

    // submit: user signs; tampering is refused; confirmation wipes the mint secret
    const tampered = VersionedTransaction.deserialize(raw);
    tampered.message.recentBlockhash = bs58.encode(Buffer.alloc(32, 9));
    tampered.sign([user]);
    await expect(client.submitLaunchTx('L-native', Buffer.from(tampered.serialize()).toString('base64'))).rejects.toThrow(/differs/);
    tx.sign([user]);
    const res = await client.submitLaunchTx('L-native', Buffer.from(tx.serialize()).toString('base64'));
    expect(res.ca).toBe(mint);
    expect(chain.landed.has(res.txSig)).toBe(true);
    expect(res.event).toEqual({
      kind: 'launch.deployed',
      payload: { ca: mint, txSig: res.txSig, creatorWallet: feeSharingConfigPda(mintKey).toBase58(), devBuySol: 0.25, network: 'devnet' },
    });
    const row = (await db.query(`SELECT mint_secret, mint_wiped_at, state FROM sol_launches WHERE launch_id='L-native'`)).rows[0]!;
    expect(row.mint_secret).toBeNull();
    expect(row.mint_wiped_at).not.toBeNull();
    expect(row.state).toBe('confirmed');
    // resubmitting is idempotent
    const again = await client.submitLaunchTx('L-native', Buffer.from(tx.serialize()).toString('base64'));
    expect(again.txSig).toBe(res.txSig);
    expect(chain.sends).toBe(1);
  });

  it('wallet mode: creator = per-launch wallet (not the payer), no fee-sharing instructions, fits without a lookup table', async () => {
    const keys = testKeys();
    const chain = await chainWithGlobal();
    const client = makeClient({ env: testEnv(keys, { ARGON_FEE_MODE: 'wallet' }), rpc: chain.rpc(), db, assertLaunchAllowed: async () => undefined });
    const user = Keypair.generate();
    const { address } = await client.createLaunchWallet('L-wallet');
    const row = (await db.query(`SELECT creator, creator_secret FROM sol_launches WHERE launch_id='L-wallet'`)).rows[0]!;
    expect(row.creator).toBe(address);
    expect(row.creator_secret).toMatch(/^v1:/);
    const { txBase64 } = await client.buildLaunchTx({ launchId: 'L-wallet', payer: user.publicKey.toBase58(), name: 'Argon Two', symbol: 'TWO', metadataUri: URI, devBuySol: CFG.devBuySol, approvalId: 'a' });
    const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
    expect(tx.message.addressTableLookups.length).toBe(0);
    const pump = decompile(tx).map(decodePumpIx).filter((d) => d !== null);
    expect(pump.map((d) => d!.name)).toEqual(['createV2', 'buy']);
    expect((pump[0]!.data['creator'] as PublicKey).toBase58()).toBe(address);
    expect(pump[1]!.account('creatorVault').equals(creatorVaultPda(new PublicKey(address)))).toBe(true);
    // the per-launch wallet is not a signer of the launch
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
    expect(signers).not.toContain(address);
  });
});
