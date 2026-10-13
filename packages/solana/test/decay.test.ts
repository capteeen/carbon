import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { AccountLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { launchConfig, type DecayRule } from '@argon/core';
import { daughterName, verifyAllocationProof } from '@qsd/protocol';
import { pumpSdk } from '../src/sdk.js';
import { decodePumpIx, PUMP_PROGRAM_ID } from '../src/programs.js';
import { collapseAtMs, decayReadout, DecayWatcher, type DecayTarget } from '../src/decay.js';
import { lastTradeAt, searchCoins, walletHistory } from '../src/reads.js';
import { takeHolderSnapshot } from '../src/snapshot.js';
import { PinataUploader } from '../src/metadata.js';
import { ChainConfigError, ChainUnavailableError } from '../src/errors.js';
import type { Db } from '../src/db.js';
import { FakeChain, unreachableRpc } from './helpers/fakeChain.js';
import { encodeAccount, eventLogs } from './helpers/events.js';
import { makeClient, testDb, testEnv, testKeys } from './helpers/env.js';
import { fixtureGlobal } from './fixtures/pump.js';

const { GLOBAL_PDA, bondingCurvePda } = pumpSdk;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const QUIET = launchConfig('Ar-41', 'ring').decay;
const CLOCK = launchConfig('Ar-39', 'ring').decay;

describe('decay timing (deterministic)', () => {
  const born = 1_800_000_000_000;
  it('Ar-41 collapses 20 minutes after the last trade; a new trade resets it', () => {
    expect(QUIET).toEqual({ kind: 'quiet', quietSec: 1200 });
    expect(collapseAtMs(QUIET, born, null)).toBe(born + 20 * MIN);
    expect(collapseAtMs(QUIET, born, born + 5 * MIN)).toBe(born + 25 * MIN);
    const r = decayReadout(QUIET, born, born + 5 * MIN, born + 15 * MIN);
    expect(r.remainingMs).toBe(10 * MIN);
    expect(r.progress).toBeCloseTo(0.5);
    expect(r.halfLifeCurve).toBeCloseTo(1 - 2 ** (-600 / 6577), 6);
    expect(decayReadout(QUIET, born, born + 5 * MIN, born + 26 * MIN)).toMatchObject({ remainingMs: 0, progress: 1 });
  });
  it('Ar-39 collapses exactly 7 days after birth, whatever the trading', () => {
    expect(CLOCK).toEqual({ kind: 'clock', clockSec: 604_800 });
    expect(collapseAtMs(CLOCK, born, born + 6 * DAY)).toBe(born + 7 * DAY);
    const r = decayReadout(CLOCK, born, null, born + 3.5 * DAY);
    expect(r).toMatchObject({ remainingMs: 3.5 * DAY, progress: 0.5, halfLifeCurve: null });
  });
  it('stable isotopes never collapse', () => {
    const none: DecayRule = { kind: 'none' };
    expect(collapseAtMs(none, born, null)).toBeNull();
    expect(decayReadout(none, born, null, born + 999 * DAY).collapseAt).toBeNull();
  });
});

/** A token account owned by `owner` holding `amount` of `mint`, acquired in a synthetic tx at `acquiredAt` (unix s). */
function holder(chain: FakeChain, mint: PublicKey, owner: PublicKey, amount: bigint, acquiredAt: number) {
  const address = Keypair.generate().publicKey;
  const data = Buffer.alloc(AccountLayout.span + 10);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  const list = chain.programAccounts.get(TOKEN_2022_PROGRAM_ID.toBase58()) ?? [];
  list.push({ pubkey: address, account: { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false } as AccountInfo<Buffer> });
  chain.programAccounts.set(TOKEN_2022_PROGRAM_ID.toBase58(), list);
  const sig = chain.synthetic([Keypair.generate().publicKey, address], { postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), owner: owner.toBase58(), amount }] }, { blockTime: acquiredAt });
  chain.signatures.set(address.toBase58(), [{ signature: sig, blockTime: acquiredAt, err: null, slot: 1 }]);
  return address;
}

/** A trade on the coin's bonding curve at `at` (unix s). */
function trade(chain: FakeChain, mint: PublicKey, at: number) {
  const curve = bondingCurvePda(mint);
  const sig = chain.synthetic([Keypair.generate().publicKey, curve], { logs: eventLogs(PUMP_PROGRAM_ID, 'pump', 'tradeEvent', { mint, isBuy: true, solAmount: new BN(1) }) }, { blockTime: at });
  const list = chain.signatures.get(curve.toBase58()) ?? [];
  list.unshift({ signature: sig, blockTime: at, err: null, slot: 1 });
  chain.signatures.set(curve.toBase58(), list);
}

describe('chain reads', () => {
  it('lastTradeAt returns the newest trade on the curve and skips non-trades', async () => {
    const chain = new FakeChain();
    const mint = Keypair.generate().publicKey;
    expect(await lastTradeAt(chain.rpc(), mint.toBase58())).toBeNull();
    trade(chain, mint, 1_800_000_100);
    const other = chain.synthetic([Keypair.generate().publicKey], {}, { blockTime: 1_800_000_500 });
    chain.signatures.get(bondingCurvePda(mint).toBase58())!.unshift({ signature: other, blockTime: 1_800_000_500, err: null, slot: 2 });
    expect(await lastTradeAt(chain.rpc(), mint.toBase58())).toBe(1_800_000_100_000);
  });

  it('holder snapshots read balances and holding starts from chain data', async () => {
    const chain = new FakeChain();
    const mint = Keypair.generate().publicKey;
    const [a, b, late] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    holder(chain, mint, a, 700n, 1000);
    holder(chain, mint, b, 300n, 1500);
    holder(chain, mint, late, 50n, 3000); // acquired after collapse
    holder(chain, mint, bondingCurvePda(mint), 10_000n, 900); // the market, not a holder
    const snap = await takeHolderSnapshot(chain.rpc(), { mint: mint.toBase58(), collapseAt: 2000, quietPeriodStart: 1200 });
    expect(snap.holders.map((h) => [h.wallet, h.balance, h.firstAcquiredAt, h.heldThroughQuietPeriod]).sort()).toEqual(
      [
        [a.toBase58(), 700n, 1000, true],
        [b.toBase58(), 300n, 1500, false],
      ].sort(),
    );
  });

  it('every read throws ChainUnavailableError when RPC or pump.fun is unreachable', async () => {
    const down = async () => {
      throw new Error('getaddrinfo ENOTFOUND frontend-api-v3.pump.fun');
    };
    const mint = Keypair.generate().publicKey.toBase58();
    await expect(lastTradeAt(unreachableRpc(), mint)).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(takeHolderSnapshot(unreachableRpc(), { mint, collapseAt: 1, quietPeriodStart: 1 })).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(searchCoins(down, 'https://api', 'argon')).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(walletHistory(unreachableRpc(), down, 'https://api', mint)).rejects.toBeInstanceOf(ChainUnavailableError);
    const http500 = async () => new Response('x', { status: 500 });
    await expect(searchCoins(http500, 'https://api', 'argon')).rejects.toThrow(/HTTP 500/);
    const badShape = async () => Response.json({ nope: 1 });
    await expect(searchCoins(badShape, 'https://api', 'argon')).rejects.toThrow(/unexpected response shape/);
  });

  it('parses coin search rows and wallet history from fixture responses', async () => {
    const m = Keypair.generate().publicKey.toBase58();
    const urls: string[] = [];
    const api = async (url: string) => {
      urls.push(url);
      return url.includes('/coins/search') ? Response.json([{ mint: m, name: 'Argon', symbol: 'C', created_timestamp: 5 }]) : Response.json([{ mint: m }, { mint: m }]);
    };
    expect(await searchCoins(api, 'https://api', ' argon ')).toEqual([{ mint: m, name: 'Argon', symbol: 'C', createdAt: 5 }]);
    expect(urls[0]).toContain('searchTerm=argon');
    const chain = new FakeChain();
    const w = Keypair.generate().publicKey;
    chain.signatures.set(w.toBase58(), [
      { signature: 's2', blockTime: 2000, err: null, slot: 2 },
      { signature: 's1', blockTime: 1000, err: null, slot: 1 },
    ]);
    expect(await walletHistory(chain.rpc(), api, 'https://api', w.toBase58())).toEqual({ txCount: 2, firstSeen: 1_000_000, launches: 2, truncated: false });
  });
});

describe('metadata upload (Pinata)', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const cids = ['bafkreiimageimageimageimageimageimageimageimageimageima', 'bafkreijsonjsonjsonjsonjsonjsonjsonjsonjsonjsonjsonjsonj'];
  it('uploads image then JSON and returns gateway URIs', async () => {
    const seen: { auth: string | null; name: unknown }[] = [];
    let i = 0;
    const f = async (_url: string, init?: RequestInit) => {
      seen.push({ auth: new Headers(init?.headers).get('authorization'), name: (init?.body as FormData).get('name') });
      return Response.json({ data: { cid: cids[i++] } });
    };
    const up = new PinataUploader(() => 'jwt', 'https://ipfs.io/ipfs', f);
    const r = await up.uploadMetadata({ name: 'Argon·2', symbol: 'C', description: 'd', image: png });
    expect(r).toEqual({ imageUri: `https://ipfs.io/ipfs/${cids[0]}`, metadataUri: `https://ipfs.io/ipfs/${cids[1]}` });
    expect(seen.map((s) => s.name)).toEqual(['image.png', 'metadata.json']);
    expect(seen[0]!.auth).toBe('Bearer jwt');
  });
  it('refuses URIs over 200 characters, bad names and non-images, and reports outages', async () => {
    const ok = async () => Response.json({ data: { cid: cids[0] } });
    await expect(new PinataUploader(() => 'jwt', `https://${'g'.repeat(190)}.example/ipfs`, ok).uploadJson({ name: 'a', symbol: 'a', description: '' }, 'x')).rejects.toBeInstanceOf(ChainConfigError);
    const up = new PinataUploader(() => 'jwt', 'https://ipfs.io/ipfs', ok);
    await expect(up.uploadJson({ name: 'x'.repeat(33), symbol: 'a', description: '' }, 'x')).rejects.toThrow(/1-32/);
    await expect(up.uploadImage(Uint8Array.from([1, 2, 3]))).rejects.toThrow(/PNG/);
    const down = new PinataUploader(() => 'jwt', 'https://ipfs.io/ipfs', async () => new Response('', { status: 401 }));
    await expect(down.uploadImage(png)).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe('DecayWatcher: collapse → snapshot → daughter → allocation → airdrops (wallet fee mode)', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  it('runs the whole collapse durably and resumes airdrops after a kill without double-sending', async () => {
    const keys = testKeys();
    const chain = new FakeChain();
    chain.accounts.set(GLOBAL_PDA.toBase58(), { data: await encodeAccount('pump', 'global', fixtureGlobal() as never), owner: PUMP_PROGRAM_ID, lamports: 1, executable: false });
    const DAUGHTER_UNITS = 35_000_000_000_000n;
    let airdropSends = 0;
    chain.onTx = (_tx, ixs) => {
      const create = ixs.map((ix) => decodePumpIx(ix)).find((d) => d?.name === 'createV2');
      if (create) {
        expect(create.data['name']).toBe(daughterName('Argon', 2));
        return { postTokenBalances: [{ accountIndex: 0, mint: create.account('mint').toBase58(), owner: keys.crank.publicKey.toBase58(), amount: DAUGHTER_UNITS }] };
      }
      if (ixs.some((ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID)) && ++airdropSends === 2) chain.faults.throwAfterSend = 1; // kill right after the 2nd airdrop lands
    };
    const pinata = async () => Response.json({ data: { cid: 'bafkreidaughterdaughterdaughterdaughterdaughterdaugh' } });
    const client = makeClient({ env: testEnv(keys, { ARGON_FEE_MODE: 'wallet' }), rpc: chain.rpc(), db, fetch: pinata, config: launchConfig('Ar-41', 'ring') });

    const mother = Keypair.generate().publicKey;
    const bornAtMs = 1_800_000_000_000;
    trade(chain, mother, 1_800_000_300); // last trade 5 min after birth
    const holders = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    holder(chain, mother, holders[0]!, 600n, 1_800_000_050);
    holder(chain, mother, holders[1]!, 300n, 1_800_000_100);
    holder(chain, mother, holders[2]!, 100n, 1_800_000_400); // acquired after the last trade: not held through the quiet period
    holder(chain, mother, keys.crank.publicKey, 5n, 1_800_000_010); // Argon's own wallet: excluded

    let now = bornAtMs + 24 * MIN; // 19 minutes after the last trade
    const watcher = new DecayWatcher({ client, db, now: () => now });
    const target: DecayTarget = { launchId: 'M1', ca: mother.toBase58(), rule: QUIET, bornAtMs, name: 'Argon', symbol: 'CBN', description: 'mother', imageUri: 'https://ipfs.io/ipfs/img', launcherWallet: Keypair.generate().publicKey.toBase58(), generation: 1, devBuySol: 0.25 };

    let r = await watcher.tick(target);
    expect(r.state).toBe('watching');
    expect(r.readout.remainingMs).toBe(MIN);

    now += 2 * MIN;
    r = await watcher.tick(target);
    expect(r).toMatchObject({ state: 'snapshotted', awaitingSnapshotAck: true, events: [{ kind: 'holders.snapshot', payload: { holderCount: 3 } }] });
    expect(chain.sends).toBe(0); // nothing moves until the caller has appended the snapshot
    await watcher.ackSnapshot('M1', 'evt-snap');

    r = await watcher.tick(target); // daughter launch + allocation + airdrops; killed after airdrop #2
    expect(r.error).toMatch(/killed after send/);
    expect(r.state).toBe('allocated');
    const daughter = (await db.query(`SELECT daughter_mint, merkle_root FROM sol_decay WHERE launch_id='M1'`)).rows[0]!;
    expect(r.events.map((e) => e.kind)).toEqual(['decay.collapsed', 'daughter.launched', 'airdrop.sent']);
    expect(r.events[0]!.payload).toEqual({ at: bornAtMs + 25 * MIN, reason: 'quiet', snapshotEventId: 'evt-snap' });
    expect(r.events[1]!.payload).toMatchObject({ motherCa: mother.toBase58(), daughterCa: daughter.daughter_mint, allocationRoot: daughter.merkle_root });
    for (const [key, id] of [['collapsed', 'e1'], ['daughter', 'e2']] as const) await watcher.ack('M1', key, id);

    r = await watcher.tick(target); // resume: the 2nd airdrop is found by signature, the 3rd is sent
    expect(r.state).toBe('done');
    expect(r.events.map((e) => e.kind)).toEqual(['airdrop.sent', 'airdrop.sent', 'airdrop.sent']);
    expect(chain.tokenTransfers).toHaveLength(3);
    const sent = chain.tokenTransfers.reduce((s, t) => s + t.amount, 0n);
    expect(sent).toBeLessThanOrEqual(DAUGHTER_UNITS);
    expect(DAUGHTER_UNITS - sent).toBeLessThan(10n); // only rounding dust stays with the crank

    for (const h of holders) {
      const p = await watcher.proofFor('M1', h.toBase58());
      expect(p).not.toBeNull();
      expect(verifyAllocationProof(p!.root, { wallet: h.toBase58(), units: BigInt(p!.units) }, p!.proof)).toBe(true);
    }
    expect(await watcher.proofFor('M1', keys.crank.publicKey.toBase58())).toBeNull();

    for (const e of r.events) await watcher.ack('M1', `airdrop:${(e.payload as { wallet: string }).wallet}`, 'x');
    const again = await watcher.tick(target);
    expect(again).toMatchObject({ state: 'done', events: [] });
    expect(chain.tokenTransfers).toHaveLength(3);
  });
});
