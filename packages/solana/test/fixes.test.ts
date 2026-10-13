/**
 * Regression tests for the audit fixes in @argon/solana: AG-002 (one launch approval,
 * one set of launch values), AG-011 (cluster by genesis hash), AG-018 (exact flags),
 * AG-005/006/022 (buyback tranches: one receipt per buy, actual spend), AG-007 (claims
 * recoverable from the durable ledger), foreign distributions (native mode) and AG-025
 * (the decay clock starts at the create transaction's block time).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { launchConfig } from '@argon/core';
import { pumpSdk } from '../src/sdk.js';
import { decodePumpIx, PUMP_PROGRAM_ID } from '../src/programs.js';
import { assertGenesisMatches, GENESIS_HASH, loadSolanaConfig } from '../src/config.js';
import { DecayWatcher } from '../src/decay.js';
import type { Db } from '../src/db.js';
import { LaunchNotAllowedError, LedgerError, NetworkGuardError } from '../src/errors.js';
import { FakeChain, type Effect } from './helpers/fakeChain.js';
import { encodeAccount, eventLogs } from './helpers/events.js';
import { makeClient, testDb, testEnv, testKeys, type TestKeys } from './helpers/env.js';
import { fixtureGlobal } from './fixtures/pump.js';

const { GLOBAL_PDA, bondingCurvePda, feeSharingConfigPda } = pumpSdk;
const URI = 'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const CFG = launchConfig('Ar-36', 'ring');

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await testDb());
});
afterAll(async () => close());

let n = 0;
const id = (p: string) => `${p}-${++n}`;

async function chainWithGlobal(): Promise<FakeChain> {
  const chain = new FakeChain();
  chain.accounts.set(GLOBAL_PDA.toBase58(), { data: await encodeAccount('pump', 'global', fixtureGlobal() as never), owner: PUMP_PROGRAM_ID, lamports: 1, executable: false });
  return chain;
}

describe('AG-002: a launch approval authorises exactly one set of launch values', () => {
  async function setup() {
    const keys = testKeys();
    const chain = await chainWithGlobal();
    const client = makeClient({ env: testEnv(keys, { ARGON_FEE_MODE: 'wallet' }), rpc: chain.rpc(), db, assertLaunchAllowed: async () => undefined });
    const launchId = id('L-bind');
    await client.createLaunchWallet(launchId);
    const payer = Keypair.generate().publicKey.toBase58();
    const args = { launchId, payer, name: 'Frost Lattice', symbol: 'FRST', metadataUri: URI, devBuySol: CFG.devBuySol, approvalId: id('appr') };
    return { client, args, chain };
  }

  it('an identical rebuild under the same approval is allowed while unsubmitted', async () => {
    const { client, args, chain } = await setup();
    await client.buildLaunchTx(args);
    chain.height += 1; // a fresh blockhash
    await expect(client.buildLaunchTx(args)).resolves.toMatchObject({ mint: expect.any(String) });
  });

  it('a rebuild with any different value under the same approval is refused', async () => {
    const { client, args } = await setup();
    await client.buildLaunchTx(args);
    for (const change of [{ name: 'Other' }, { symbol: 'OTHR' }, { metadataUri: `${URI}?v=2` }, { payer: Keypair.generate().publicKey.toBase58() }]) {
      await expect(client.buildLaunchTx({ ...args, ...change }), JSON.stringify(change)).rejects.toThrow(/already authorised a launch transaction with different values/);
    }
    const row = (await db.query('SELECT name, symbol FROM sol_launches WHERE launch_id=$1', [args.launchId])).rows[0]!;
    expect(row).toEqual({ name: 'Frost Lattice', symbol: 'FRST' });
  });

  it('a new approval may rebind new values; the superseded approval cannot build again', async () => {
    const { client, args } = await setup();
    await client.buildLaunchTx(args);
    const second = { ...args, name: 'Second Name', approvalId: id('appr') };
    await client.buildLaunchTx(second);
    await expect(client.buildLaunchTx(args)).rejects.toThrow(/superseded/);
    await expect(client.buildLaunchTx({ ...second, symbol: 'ELSE' })).rejects.toBeInstanceOf(LaunchNotAllowedError);
  });

  it('an approval whose build failed is not bound (the user can retry it unchanged)', async () => {
    const { client, args, chain } = await setup();
    chain.accounts.delete(GLOBAL_PDA.toBase58());
    await expect(client.buildLaunchTx(args)).rejects.toThrow();
    chain.accounts.set(GLOBAL_PDA.toBase58(), { data: await encodeAccount('pump', 'global', fixtureGlobal() as never), owner: PUMP_PROGRAM_ID, lamports: 1, executable: false });
    await expect(client.buildLaunchTx({ ...args, name: 'Fixed Name' })).resolves.toMatchObject({ mint: expect.any(String) });
  });
});

describe('AG-011 / AG-018: the cluster comes from the genesis hash; flags are exact', () => {
  it('genesis hash decides the cluster, not the URL', () => {
    expect(assertGenesisMatches('devnet', GENESIS_HASH.devnet)).toBe('devnet');
    expect(() => assertGenesisMatches('devnet', GENESIS_HASH['mainnet-beta'])).toThrow(/serves mainnet-beta/);
    expect(() => assertGenesisMatches('devnet', GENESIS_HASH.testnet)).toThrow(NetworkGuardError);
    expect(() => assertGenesisMatches('devnet', 'unknownhash')).toThrow(/unknown cluster/);
    expect(() => assertGenesisMatches('mainnet-beta', GENESIS_HASH.devnet)).toThrow(NetworkGuardError);
  });

  it('a devnet client on an RPC whose genesis is mainnet refuses every build and send, before touching the ledger', async () => {
    const keys = testKeys();
    const chain = await chainWithGlobal();
    chain.genesisHash = GENESIS_HASH['mainnet-beta'];
    const client = makeClient({ env: testEnv(keys), rpc: chain.rpc(), db, assertLaunchAllowed: async () => undefined });
    await expect(client.verifyCluster()).rejects.toBeInstanceOf(NetworkGuardError);
    const launchId = id('L-mainnet-rpc');
    await client.createLaunchWallet(launchId);
    const args = { launchId, payer: Keypair.generate().publicKey.toBase58(), name: 'X', symbol: 'X', metadataUri: URI, devBuySol: CFG.devBuySol, approvalId: 'a' };
    await expect(client.buildLaunchTx(args)).rejects.toBeInstanceOf(NetworkGuardError);
    await expect(client.claimCreatorFees(launchId)).rejects.toBeInstanceOf(NetworkGuardError);
    await expect(client.runSplit(launchId, 'c')).rejects.toBeInstanceOf(NetworkGuardError);
    await expect(client.buyArgon(1n, 's')).rejects.toBeInstanceOf(NetworkGuardError);
    await expect(client.airdropUnits(launchId, Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), 1n)).rejects.toBeInstanceOf(NetworkGuardError);
    await expect(client.init()).rejects.toBeInstanceOf(NetworkGuardError);
    expect(chain.sends).toBe(0);
  });

  it('an unreachable RPC is retried on next use instead of being trusted', async () => {
    const keys = testKeys();
    const chain = await chainWithGlobal();
    let calls = 0;
    const rpc = chain.rpc();
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(rpc)), rpc, {
      async getGenesisHash() {
        calls++;
        if (calls === 1) throw new Error('connect ECONNREFUSED');
        return GENESIS_HASH.devnet;
      },
    });
    const client = makeClient({ env: testEnv(keys), rpc: flaky, db });
    await expect(client.verifyCluster()).rejects.toThrow(/ECONNREFUSED/);
    await expect(client.verifyCluster()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('a devnet config whose RPC URL does not name devnet is refused; padded flags are refused', () => {
    const k = testKeys();
    expect(() => loadSolanaConfig(testEnv(k, { ARGON_RPC_URL: 'https://rpc.ankr.com/solana' }))).toThrow(NetworkGuardError);
    expect(loadSolanaConfig(testEnv(k, { ARGON_RPC_URL: 'https://rpc.ankr.com/solana_devnet' })).network).toBe('devnet');
    expect(() => loadSolanaConfig(testEnv(k, { ARGON_NETWORK: 'mainnet-beta', ARGON_MAINNET_ENABLED: ' true' }))).toThrow(NetworkGuardError);
    expect(() => loadSolanaConfig(testEnv(k, { ARGON_NETWORK: ' mainnet-beta', ARGON_MAINNET_ENABLED: 'true' }))).toThrow(NetworkGuardError);
    expect(loadSolanaConfig(testEnv(k, { ARGON_NETWORK: 'mainnet-beta', ARGON_MAINNET_ENABLED: 'true' })).network).toBe('mainnet-beta');
  });
});

describe('AG-005 / AG-006: buyback tranches, one buy per acknowledgement, actual spend', () => {
  const LEG = 25_000_000n; // 0.025 SOL leg; RING Ar-36 cap is 0.01 SOL per buy

  async function setup(keys: TestKeys = testKeys()) {
    const chain = await chainWithGlobal();
    const g = fixtureGlobal();
    chain.accounts.set(bondingCurvePda(keys.argonMint.publicKey).toBase58(), {
      data: await encodeAccount('pump', 'bondingCurve', {
        virtualTokenReserves: g.initialVirtualTokenReserves,
        virtualSolReserves: g.initialVirtualSolReserves,
        realTokenReserves: g.initialRealTokenReserves,
        realSolReserves: new BN(0),
        tokenTotalSupply: g.tokenTotalSupply,
        complete: false,
        creator: Keypair.generate().publicKey,
      }),
      owner: PUMP_PROGRAM_ID,
      lamports: 1,
      executable: false,
    });
    chain.accounts.set(keys.argonMint.publicKey.toBase58(), { data: Buffer.alloc(82), owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false });
    const buys: bigint[] = [];
    chain.onTx = (_tx, ixs: TransactionInstruction[]): Effect | void => {
      const buy = ixs.find((ix) => decodePumpIx(ix)?.name === 'buy');
      if (!buy) return;
      const max = BigInt(String(decodePumpIx(buy)!.data['maxSolCost']));
      buys.push(max - 200_000n + 125_000n);
      return {
        logs: eventLogs(PUMP_PROGRAM_ID, 'pump', 'tradeEvent', { mint: keys.argonMint.publicKey, isBuy: true, user: keys.buyback.publicKey, solAmount: new BN((max - 200_000n).toString()), fee: new BN(95_000), creatorFee: new BN(30_000) }),
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: keys.argonMint.publicKey.toBase58(), owner: keys.buyback.publicKey.toBase58(), amount: 1_000n }],
      };
    };
    const client = makeClient({ env: testEnv(keys), rpc: chain.rpc(), db, config: CFG });
    const launchId = id('B');
    await client.createLaunchWallet(launchId);
    await db.query(`UPDATE sol_launches SET state='confirmed', launcher_wallet=$2 WHERE launch_id=$1`, [launchId, Keypair.generate().publicKey.toBase58()]);
    const claimId = id('c');
    const splitId = `split_${claimId}`;
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, lamports) VALUES ($1,$2,'native','confirmed','fixture',1)`, [claimId, launchId]);
    await db.query(`INSERT INTO sol_splits (split_id, claim_id, launch_id, mode, total) VALUES ($1,$2,$3,'native',1)`, [splitId, claimId, launchId]);
    await db.query(`INSERT INTO split_ledger (claim_id, leg, launch_id, address, lamports, state, tx_sig) VALUES ($1,'argon-buyback',$2,$3,$4,'confirmed','fixture')`, [claimId, launchId, keys.buyback.publicKey.toBase58(), LEG.toString()]);
    return { client, chain, buys, splitId };
  }

  it('lamportsIn is what the trade spent; the next buy waits for the acknowledgement, then draws only what is left', async () => {
    const { client, chain, buys, splitId } = await setup();
    const a = await client.buyArgon(LEG, splitId);
    expect(a.lamportsIn).toBe(10_000_000n - 75_000n);
    expect(a.event.payload.lamportsIn).toBe(a.lamportsIn.toString());
    // Not acknowledged yet (the receipt may not be in the log): every call returns THIS buy.
    chain.height += 1;
    expect((await client.buyArgon(LEG, splitId)).txSig).toBe(a.txSig);
    expect(await client.recordedBuyback(splitId)).toMatchObject({ txSig: a.txSig, state: 'confirmed' });
    expect(buys).toHaveLength(1);

    await client.ackBuyback(splitId, a.txSig);
    expect(await client.recordedBuyback(splitId)).toBeNull();
    const b = await client.buyArgon(LEG, splitId);
    expect(b.txSig).not.toBe(a.txSig);
    await client.ackBuyback(splitId, b.txSig);
    chain.height += 1;
    const c = await client.buyArgon(LEG, splitId);
    await client.ackBuyback(splitId, c.txSig);
    // 25m leg: 10m, 10m, then what is left after what the first two ACTUALLY spent.
    const left = LEG - a.lamportsIn - b.lamportsIn;
    expect(buys).toHaveLength(3);
    expect(buys[2]).toBe(left - 200_000n + 125_000n);
    const spent = a.lamportsIn + b.lamportsIn + c.lamportsIn;
    expect(spent).toBeLessThanOrEqual(LEG);
  });

  it('a new tranche that would repeat an earlier transaction (same blockhash, same amount) is not broadcast', async () => {
    const { client, chain, splitId } = await setup();
    const a = await client.buyArgon(LEG, splitId);
    await client.ackBuyback(splitId, a.txSig);
    const sends = chain.sends;
    await expect(client.buyArgon(LEG, splitId)).rejects.toBeInstanceOf(LedgerError);
    expect(chain.sends).toBe(sends);
    chain.height += 1; // next tick: new blockhash, the open tranche resumes
    const b = await client.buyArgon(LEG, splitId);
    expect(b.txSig).not.toBe(a.txSig);
  });
});

describe('AG-007 and foreign distributions: every claim is in the durable ledger', () => {
  async function nativeLaunch() {
    const keys = testKeys();
    const chain = await chainWithGlobal();
    const client = makeClient({ env: testEnv(keys), rpc: chain.rpc(), db });
    const launchId = id('N');
    await client.createLaunchWallet(launchId);
    const launcher = Keypair.generate().publicKey;
    const mint = new PublicKey((await db.query(`SELECT mint FROM sol_launches WHERE launch_id=$1`, [launchId])).rows[0]!.mint);
    await db.query(`UPDATE sol_launches SET state='confirmed', launcher_wallet=$2 WHERE launch_id=$1`, [launchId, launcher.toBase58()]);
    return { keys, chain, client, launchId, launcher, mint };
  }

  /** A distribute_creator_fees landed by someone else on the coin's sharing config. */
  function foreignDistribution(s: Awaited<ReturnType<typeof nativeLaunch>>, total: bigint): string {
    const legs: [PublicKey, number, bigint][] = [
      [s.launcher, 5000, total / 2n],
      [s.keys.buyback.publicKey, 3000, (total * 3n) / 10n],
      [s.keys.treasury.publicKey, 2000, total - total / 2n - (total * 3n) / 10n],
    ];
    const cranker = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const sharing = feeSharingConfigPda(s.mint);
    const sig = s.chain.synthetic(
      [cranker, ...legs.map((l) => l[0]), vault, sharing],
      {
        logs: eventLogs(PUMP_PROGRAM_ID, 'pump', 'distributeCreatorFeesEvent', {
          mint: s.mint,
          sharingConfig: sharing,
          admin: s.launcher,
          shareholders: legs.map(([address, shareBps]) => ({ address, shareBps })),
          distributed: new BN(total.toString()),
          quoteMint: PublicKey.default,
        }),
      },
      { pre: [1_000_000_000n, 10n, 10n, 10n, total + 890_880n, 0n], post: [999_995_000n, 10n + legs[0]![2], 10n + legs[1]![2], 10n + legs[2]![2], 890_880n, 0n] },
    );
    const list = s.chain.signatures.get(sharing.toBase58()) ?? [];
    list.unshift({ signature: sig, blockTime: s.chain.time, err: null, slot: s.chain.slot });
    s.chain.signatures.set(sharing.toBase58(), list);
    return sig;
  }

  it('a third-party crank becomes a confirmed foreign claim with a split receipt read from the chain, found once', async () => {
    const s = await nativeLaunch();
    const unrelated = s.chain.synthetic([Keypair.generate().publicKey], {});
    s.chain.signatures.set(feeSharingConfigPda(s.mint).toBase58(), [{ signature: unrelated, blockTime: 1, err: null, slot: 1 }]);
    const sig = foreignDistribution(s, 1_000_000n);
    const found = await s.client.scanForeignDistributions(s.launchId);
    expect(found).toEqual([{ claimId: `foreign_${sig}`, lamports: 1_000_000n, txSig: sig, origin: 'foreign' }]);
    expect(await s.client.scanForeignDistributions(s.launchId)).toEqual([]); // the cursor moved past it
    expect(await s.client.confirmedClaims(s.launchId)).toEqual(found);
    const r = await s.client.runSplit(s.launchId, `foreign_${sig}`);
    expect(r.totalLamports).toBe('1000000');
    expect(r.legs.map((l) => [l.to, l.lamports, l.txSig, l.status])).toEqual([
      ['launcher', '500000', sig, 'confirmed'],
      ['argon-buyback', '300000', sig, 'confirmed'],
      ['treasury', '200000', sig, 'confirmed'],
    ]);
    expect(s.chain.sends).toBe(0);
    // A second foreign crank later is found too.
    const sig2 = foreignDistribution(s, 2_000_000n);
    expect((await s.client.scanForeignDistributions(s.launchId)).map((c) => c.txSig)).toEqual([sig2]);
  });

  // AG-033: more than one tick's worth of signatures (10 × 100) since the last scan.
  it('[AG-033] a distribution buried under more than 1000 newer signatures is still found; the cursor never skips unread signatures', async () => {
    const s = await nativeLaunch();
    const sharing = feeSharingConfigPda(s.mint).toBase58();
    const old = foreignDistribution(s, 5_000n); // the oldest entry
    const filler = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({ signature: `${tag}${i}`, blockTime: 1, err: { InstructionError: [0, 'x'] } as unknown as null, slot: 1 }));
    // 2500 failed transactions land on top of it before the next scan
    s.chain.signatures.set(sharing, [...filler(2500, 'fillA'), ...s.chain.signatures.get(sharing)!]);
    const first = await s.client.scanForeignDistributions(s.launchId);
    expect(first).toEqual([]); // read 1000, not yet down to it
    const cur1 = (await db.query(`SELECT foreign_scan_until, foreign_scan_head, foreign_scan_before FROM sol_launches WHERE launch_id=$1`, [s.launchId])).rows[0]!;
    expect(cur1.foreign_scan_until).toBeNull(); // the cursor did not jump past the unread 1500
    expect(cur1.foreign_scan_head).toBe('fillA0');
    // meanwhile a newer one arrives on top
    const newer = foreignDistribution(s, 7_000n);
    const found: string[] = [];
    for (let i = 0; i < 5; i++) found.push(...(await s.client.scanForeignDistributions(s.launchId)).map((c) => c.txSig));
    expect(found.sort()).toEqual([old, newer].sort());
    expect(new Set((await s.client.confirmedClaims(s.launchId)).map((c) => c.txSig))).toEqual(new Set([old, newer]));
    const cur2 = (await db.query(`SELECT foreign_scan_until, foreign_scan_head, foreign_scan_before FROM sol_launches WHERE launch_id=$1`, [s.launchId])).rows[0]!;
    expect(cur2).toEqual({ foreign_scan_until: newer, foreign_scan_head: null, foreign_scan_before: null });
  });

  it('[AG-033] a fetch failure mid-scan leaves the cursor where it was (the page is re-read next tick)', async () => {
    const s = await nativeLaunch();
    const sig = foreignDistribution(s, 9_000n);
    const rpc = s.chain.rpc() as unknown as { getTransaction: (...a: unknown[]) => Promise<unknown> };
    const client = makeClient({
      env: testEnv(s.keys),
      db,
      rpc: new Proxy(rpc, { get: (t, k) => (k === 'getTransaction' ? () => Promise.reject(new Error('rpc down')) : Reflect.get(t, k, t)) }) as never,
    });
    await expect(client.scanForeignDistributions(s.launchId)).rejects.toThrow();
    const cur = (await db.query(`SELECT foreign_scan_until, foreign_scan_head, foreign_scan_before FROM sol_launches WHERE launch_id=$1`, [s.launchId])).rows[0]!;
    expect(cur).toEqual({ foreign_scan_until: null, foreign_scan_head: null, foreign_scan_before: null });
    expect((await s.client.scanForeignDistributions(s.launchId)).map((c) => c.txSig)).toEqual([sig]);
  });

  // AG-034: a claim broadcast before a crash stays 'sent'. Settling it is bookkeeping:
  // confirmedClaims resolves it by signature, with no new transaction (and so no approval).
  it('[AG-034] a claim left "sent" by a crash is listed once it landed, without claimCreatorFees and without a new transaction', async () => {
    const s = await nativeLaunch();
    const sig = foreignDistribution(s, 3_000_000n); // the landed distribution (Argon's own crank)
    s.chain.signatures.delete(feeSharingConfigPda(s.mint).toBase58()); // not visible to the foreign scan
    const claimId = id('sent');
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, raw_tx, lvbh) VALUES ($1,$2,'native','sent',$3,$4,$5)`, [
      claimId,
      s.launchId,
      sig,
      Buffer.from('signed-bytes').toString('base64'),
      s.chain.height + 150,
    ]);
    const sends = s.chain.sends;
    expect(await s.client.confirmedClaims(s.launchId)).toEqual([{ claimId, lamports: 3_000_000n, txSig: sig, origin: 'argon' }]);
    expect(s.chain.sends).toBe(sends); // nothing built, signed or sent
    const r = await s.client.runSplit(s.launchId, claimId);
    expect(r.legs.every((l) => l.status === 'confirmed' && l.txSig === sig)).toBe(true);
  });

  it('[AG-034] a "sent" claim that never landed and expired goes back to pending (a new claim stays a new, gated action)', async () => {
    const s = await nativeLaunch();
    const claimId = id('lost');
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, raw_tx, lvbh) VALUES ($1,$2,'native','sent',$3,$4,$5)`, [
      claimId,
      s.launchId,
      'never-landed-signature',
      Buffer.from('signed-bytes').toString('base64'),
      s.chain.height + 150,
    ]);
    s.chain.expireAll();
    expect(await s.client.confirmedClaims(s.launchId)).toEqual([]);
    const row = (await db.query(`SELECT state, tx_sig FROM sol_claims WHERE claim_id=$1`, [claimId])).rows[0]!;
    expect(row).toEqual({ state: 'pending', tx_sig: null });
  });

  it("Argon's own claims are never mistaken for foreign ones", async () => {
    const s = await nativeLaunch();
    const sig = foreignDistribution(s, 777n);
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig, lamports) VALUES ($1,$2,'native','confirmed',$3,777)`, [id('own'), s.launchId, sig]);
    expect(await s.client.scanForeignDistributions(s.launchId)).toEqual([]);
    expect((await s.client.confirmedClaims(s.launchId)).map((c) => c.origin)).toEqual(['argon']);
  });

  it('a claim that confirmed before its amount was recorded is measured from the chain and listed', async () => {
    const s = await nativeLaunch();
    const sig = foreignDistribution(s, 4242n);
    const claimId = id('crashed');
    await db.query(`INSERT INTO sol_claims (claim_id, launch_id, mode, state, tx_sig) VALUES ($1,$2,'native','confirmed',$3)`, [claimId, s.launchId, sig]);
    expect(await s.client.confirmedClaims(s.launchId)).toEqual([{ claimId, lamports: 4242n, txSig: sig, origin: 'argon' }]);
  });
});

describe('AG-025: the decay clock starts at the create transaction block time', () => {
  it('the watcher uses the recorded block time over the caller’s event time', async () => {
    const keys = testKeys();
    const chain = await chainWithGlobal();
    const client = makeClient({ env: testEnv(keys), rpc: chain.rpc(), db, config: launchConfig('Ar-39', 'chain') });
    const launchId = id('D');
    await client.createLaunchWallet(launchId);
    const born = 1_800_000_000_000;
    await db.query(`UPDATE sol_launches SET state='confirmed', born_at_ms=$2 WHERE launch_id=$1`, [launchId, born]);
    expect(await client.launchBornAtMs(launchId)).toBe(born);
    const rule = launchConfig('Ar-39', 'chain').decay;
    const watcher = new DecayWatcher({ client, db, now: () => born + 1000 });
    const r = await watcher.tick({ launchId, ca: Keypair.generate().publicKey.toBase58(), rule, bornAtMs: born + 90_000, name: 'M', symbol: 'M', description: 'm', imageUri: 'u', launcherWallet: Keypair.generate().publicKey.toBase58(), generation: 1, devBuySol: 0.1 });
    expect(r.readout.collapseAt).toBe(born + 7 * 24 * 3600_000);
    expect(await client.launchBornAtMs('no-such-launch')).toBeNull();
  });
});
