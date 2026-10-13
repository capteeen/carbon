/**
 * Devnet spike: the five open checks from docs/fees-research.md, run against
 * the real devnet programs. DEVNET ONLY; refuses any other network.
 *
 *   ARGON_VAULT_KEY=… ARGON_CRANK_KEY=… ARGON_BUYBACK_WALLET=… ARGON_TREASURY_WALLET=… PINATA_JWT=… \
 *     pnpm --filter @argon/solana devnet-spike -- --image /path/to/coin.png [--name "Argon Spike"] [--symbol CSPK]
 *
 * The crank wallet (ARGON_CRANK_KEY) pays and acts as the launcher; fund it
 * with devnet SOL first. If ARGON_LOOKUP_TABLE is unset, the script creates
 * an address lookup table owned by the crank wallet and prints its address
 * for ARGON_LOOKUP_TABLE (the native launch does not fit one packet without it).
 *
 *   1. Program accounts 6EF8…, pAMM…, pfee… exist and are executable; Global and FeeConfig decode.
 *   2. create_v2 + create_fee_sharing_config + update_fee_shares + dev buy land in ONE transaction.
 *   3. A second update_fee_shares fails (simulated; the shares are locked).
 *   4. Whether v3 trades are live: a non-zero curve creator-fee bucket after the dev buy means the sweep is required.
 *   5. The bonding-curve creator bps from the pump fee_config at the new coin's market cap.
 *
 * Prints public keys, signatures and results only. Never prints a secret.
 */
import { readFileSync } from 'node:fs';
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from '@solana/web3.js';
import { loadSolanaConfig, ENV } from '../src/config.js';
import { pumpSdk } from '../src/sdk.js';
import { PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, decodePumpIx } from '../src/programs.js';
import { buildCrankIxs, buildNativeLaunchIxs, argonShares, fetchLaunchState, launchLookupAddresses, solToLamports } from '../src/pump.js';
import { assertAllowed } from '../src/allowlist.js';
import { PinataUploader } from '../src/metadata.js';
import { compileAndSign, waitForFinal, DEFAULT_POLL, PACKET_DATA_SIZE } from '../src/tx.js';
import { errorMessage } from '../src/errors.js';

const { PUMP_SDK, bondingCurvePda, bondingCurveMarketCap, calculateFeeTier } = pumpSdk;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const results: { check: string; ok: boolean | null; detail: string }[] = [];
function report(check: string, ok: boolean | null, detail: string): void {
  results.push({ check, ok, detail });
  console.log(`[${ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL'}] ${check}: ${detail}`);
}

async function send(conn: Connection, tx: VersionedTransaction, lastValidBlockHeight: number): Promise<string> {
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
  const r = await waitForFinal(conn, sig, raw, lastValidBlockHeight, DEFAULT_POLL);
  if (r.status !== 'confirmed') throw new Error(`${sig} ${r.status}${r.err ? `: ${r.err}` : ''}`);
  return sig;
}

async function main(): Promise<void> {
  const cfg = loadSolanaConfig(process.env);
  if (cfg.network !== 'devnet') throw new Error('devnet-spike runs on devnet only');
  const conn = new Connection(cfg.rpcUrl, 'confirmed');
  const crank = cfg.secrets.requireCrank();
  console.log(`network ${cfg.network}  rpc ${new URL(cfg.rpcUrl).host}  payer ${crank.publicKey.toBase58()}  balance ${(await conn.getBalance(crank.publicKey)) / 1e9} SOL`);

  // ── 1 ──
  const progs = await conn.getMultipleAccountsInfo([PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID]);
  const exec = progs.map((p) => !!p?.executable);
  const { global, feeConfig } = await fetchLaunchState(conn);
  report('1 programs + Global/FeeConfig decode', exec.every(Boolean) && feeConfig !== null, `executable pump=${exec[0]} amm=${exec[1]} fees=${exec[2]}; Global decoded; FeeConfig ${feeConfig ? `decoded (${feeConfig.feeTiers.length} tiers)` : 'MISSING'}`);
  if (!exec.every(Boolean)) return;

  // ── lookup table ──
  const mint = Keypair.generate();
  const devBuyLamports = solToLamports(0.01);
  const image = arg('image');
  if (!image) throw new Error('--image <path to a PNG/JPEG/WebP/GIF> is required (uploaded to Pinata for the coin metadata)');
  const pinata = new PinataUploader(() => cfg.secrets.requirePinata(), cfg.ipfsGateway);
  const { metadataUri } = await pinata.uploadMetadata({ name: arg('name') ?? 'Argon Spike', symbol: arg('symbol') ?? 'CSPK', description: 'Argon devnet spike: native fee-sharing launch check.', image: readFileSync(image) });
  const built = await buildNativeLaunchIxs({ global, feeConfig, mint: mint.publicKey, payer: crank.publicKey, name: arg('name') ?? 'Argon Spike', symbol: arg('symbol') ?? 'CSPK', uri: metadataUri, devBuyLamports, buybackWallet: cfg.buybackWallet, treasuryWallet: cfg.treasuryWallet });
  assertAllowed(built.instructions, built.purpose);

  let alt: AddressLookupTableAccount | null = null;
  if (cfg.lookupTable) {
    alt = (await conn.getAddressLookupTable(cfg.lookupTable)).value;
    if (!alt) throw new Error(`${ENV.LOOKUP_TABLE} not found on devnet`);
  } else {
    const addrs = launchLookupAddresses(built.instructions, mint.publicKey, crank.publicKey);
    const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: crank.publicKey, payer: crank.publicKey, recentSlot: await conn.getSlot('finalized') });
    let s = await compileAndSign({ rpc: conn, payer: crank.publicKey, instructions: [create], signers: [crank] });
    await send(conn, VersionedTransaction.deserialize(s.raw), s.lastValidBlockHeight);
    for (let i = 0; i < addrs.length; i += 20) {
      const extend = AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: crank.publicKey, payer: crank.publicKey, addresses: addrs.slice(i, i + 20) });
      s = await compileAndSign({ rpc: conn, payer: crank.publicKey, instructions: [extend], signers: [crank] });
      await send(conn, VersionedTransaction.deserialize(s.raw), s.lastValidBlockHeight);
    }
    // A table is usable one slot after its last extension.
    const after = await conn.getSlot('confirmed');
    while ((await conn.getSlot('confirmed')) <= after) await new Promise((r) => setTimeout(r, 500));
    alt = (await conn.getAddressLookupTable(table)).value;
    console.log(`created lookup table ${table.toBase58()} with ${addrs.length} addresses — set ${ENV.LOOKUP_TABLE}=${table.toBase58()}`);
  }

  // ── 2 ──
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: crank.publicKey, recentBlockhash: blockhash, instructions: built.instructions }).compileToV0Message(alt ? [alt] : []);
    const tx = new VersionedTransaction(msg);
    tx.sign([crank, mint]);
    const size = tx.serialize().length;
    if (size > PACKET_DATA_SIZE) throw new Error(`launch transaction is ${size} bytes`);
    const sig = await send(conn, tx, lastValidBlockHeight);
    const landed = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    report('2 one-transaction native launch', true, `mint ${mint.publicKey.toBase58()} sig ${sig} size ${size} B, ${landed?.meta?.computeUnitsConsumed ?? '?'} CU`);
  } catch (e) {
    report('2 one-transaction native launch', false, errorMessage(e));
    return;
  }

  // ── 3 ──
  const shares = argonShares(crank.publicKey, cfg.buybackWallet, cfg.treasuryWallet);
  const again = await PUMP_SDK.updateFeeShares({
    authority: crank.publicKey,
    mint: mint.publicKey,
    currentShareholders: shares.map((s) => s.address),
    newShareholders: [{ address: crank.publicKey, shareBps: 10_000 }],
    bondingCurveComplete: false,
  });
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const sim = new VersionedTransaction(new TransactionMessage({ payerKey: crank.publicKey, recentBlockhash: blockhash, instructions: [again] }).compileToV0Message());
  sim.sign([crank]);
  const simRes = await conn.simulateTransaction(sim, { sigVerify: false, commitment: 'confirmed' });
  report('3 second update_fee_shares is refused (lock)', simRes.value.err !== null, simRes.value.err ? `rejected: ${JSON.stringify(simRes.value.err)} ${(simRes.value.logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-2).join(' | ')}` : 'SIMULATION SUCCEEDED: shares are NOT locked');

  // ── 4 ──
  const curveInfo = await conn.getAccountInfo(bondingCurvePda(mint.publicKey));
  const curve = curveInfo ? PUMP_SDK.decodeBondingCurve(curveInfo) : null;
  const bucket = curve ? BigInt(curve.creatorFee.toString()) : 0n;
  let crankHasSweep = false;
  try {
    const crankIxs = await buildCrankIxs(conn, mint.publicKey, crank.publicKey);
    crankHasSweep = crankIxs.instructions.some((ix) => decodePumpIx(ix)?.name === 'sweepCreatorFee');
  } catch (e) {
    console.log(`  (crank build: ${errorMessage(e)})`);
  }
  report('4 v3 trades / sweep before distribute', null, `curve creator-fee bucket after dev buy = ${bucket} lamports → ${bucket > 0n ? 'v3 bucket LIVE: sweep required' : 'bucket empty: v3 not observed'}; SDK crank includes sweep: ${crankHasSweep}`);

  // ── 5 ──
  if (feeConfig && curve) {
    const marketCap = bondingCurveMarketCap({ mintSupply: curve.tokenTotalSupply, virtualQuoteReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves });
    const fees = calculateFeeTier({ feeTiers: feeConfig.feeTiers, marketCap });
    report('5 curve creator bps from fee_config', null, `tier at market cap ${marketCap.toString()} lamports: creator ${fees.creatorFeeBps.toString()} bps, protocol ${fees.protocolFeeBps.toString()} bps, lp ${fees.lpFeeBps.toString()} bps; Global.creatorFeeBasisPoints ${global.creatorFeeBasisPoints.toString()}`);
  } else {
    report('5 curve creator bps from fee_config', false, 'fee_config or curve missing');
  }
}

main()
  .catch((e) => {
    console.error(`devnet-spike failed: ${errorMessage(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = results.filter((r) => r.ok === false).length;
    console.log(`\n${results.length} checks run, ${failed} failed.`);
    if (failed) process.exitCode = 1;
  });
