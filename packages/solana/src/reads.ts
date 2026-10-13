/**
 * Read paths for Sentinel and the decay watcher: coin search (pump.fun
 * frontend API), wallet history (RPC + pump.fun API), last trade time (RPC).
 * Every failure is a ChainUnavailableError; nothing is ever estimated.
 *
 * pump.fun frontend API endpoints used (not verified live from the build
 * sandbox, where pump.fun is blocked):
 *   GET {api}/coins/search?searchTerm=&offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=true
 *   GET {api}/coins/user-created-coins/{address}?offset=0&limit=1000&includeNsfw=true
 * Rows are validated field by field; a response of any other shape throws.
 */
import type { PumpCoinInfo } from '@argon/core';
import { PublicKey, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import { ChainUnavailableError, errorMessage } from './errors.js';
import { decodeTxEvents } from './events.js';
import type { FetchLike } from './metadata.js';
import { rpcCall, type RpcLike } from './rpc.js';
import { pumpSdk } from './sdk.js';

const { bondingCurvePda, canonicalPumpPoolPda } = pumpSdk;

async function getJson(fetchImpl: FetchLike, url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new ChainUnavailableError(`${what}: ${errorMessage(e)}`, { cause: e });
  }
  if (!res.ok) throw new ChainUnavailableError(`${what} returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new ChainUnavailableError(`${what}: response is not JSON`, { cause: e });
  }
}

function rowsOf(body: unknown, what: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object' && Array.isArray((body as { coins?: unknown }).coins)) return (body as { coins: unknown[] }).coins;
  throw new ChainUnavailableError(`${what}: unexpected response shape`);
}

export function parseCoinRow(r: unknown): PumpCoinInfo | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o['mint'] !== 'string' || typeof o['name'] !== 'string' || typeof o['symbol'] !== 'string') return null;
  try {
    new PublicKey(o['mint']);
  } catch {
    return null;
  }
  const info: PumpCoinInfo = { mint: o['mint'], name: o['name'], symbol: o['symbol'] };
  if (typeof o['image_uri'] === 'string') info.imageUri = o['image_uri'];
  if (typeof o['created_timestamp'] === 'number') info.createdAt = o['created_timestamp'];
  return info;
}

export async function searchCoins(fetchImpl: FetchLike, apiUrl: string, query: string): Promise<PumpCoinInfo[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `${apiUrl}/coins/search?searchTerm=${encodeURIComponent(q)}&offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=true`;
  const rows = rowsOf(await getJson(fetchImpl, url, 'pump.fun coin search'), 'pump.fun coin search');
  const out: PumpCoinInfo[] = [];
  for (const r of rows) {
    const c = parseCoinRow(r);
    if (!c) throw new ChainUnavailableError('pump.fun coin search: row without mint/name/symbol');
    out.push(c);
  }
  return out;
}

export interface WalletHistory {
  txCount: number;
  firstSeen: number | null;
  launches: number;
  /** True when the wallet has more signatures than were paged; txCount is then a lower bound and firstSeen is null. */
  truncated: boolean;
}

export const HISTORY_PAGE = 1000;
export const HISTORY_MAX_PAGES = 10;

export async function walletHistory(rpc: RpcLike, fetchImpl: FetchLike, apiUrl: string, address: string): Promise<WalletHistory> {
  const key = new PublicKey(address);
  let before: string | undefined;
  let count = 0;
  let oldest: number | null = null;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= HISTORY_MAX_PAGES) {
      truncated = true;
      break;
    }
    const sigs: ConfirmedSignatureInfo[] = await rpcCall('getSignaturesForAddress', () => rpc.getSignaturesForAddress(key, { limit: HISTORY_PAGE, ...(before ? { before } : {}) }, 'confirmed'));
    count += sigs.length;
    const last = sigs[sigs.length - 1];
    if (last) {
      before = last.signature;
      if (typeof last.blockTime === 'number') oldest = last.blockTime * 1000;
    }
    if (sigs.length < HISTORY_PAGE) break;
  }
  const created = rowsOf(
    await getJson(fetchImpl, `${apiUrl}/coins/user-created-coins/${key.toBase58()}?offset=0&limit=1000&includeNsfw=true`, 'pump.fun created coins'),
    'pump.fun created coins',
  );
  return { txCount: count, firstSeen: truncated ? null : oldest, launches: created.length, truncated };
}

const TRADE_EVENTS = new Set(['tradeEvent', 'TradeEvent', 'buyEvent', 'BuyEvent', 'sellEvent', 'SellEvent']);

function isTradeOf(tx: VersionedTransactionResponse, mint: PublicKey): boolean {
  if (tx.meta?.err) return false;
  return decodeTxEvents(tx).some((e) => {
    if (!TRADE_EVENTS.has(e.name)) return false;
    const m = (e.data['mint'] ?? e.data['baseMint']) as PublicKey | undefined;
    // pump-amm Buy/SellEvent carry the pool, not the mint; they are only scanned on the coin's own pool.
    return m === undefined ? e.program === 'amm' : m.equals(mint);
  });
}

export const TRADE_SCAN_LIMIT = 300;

/**
 * Unix ms of the most recent successful trade on the coin's bonding curve or
 * canonical PumpSwap pool. null when the coin has no trades at all. Throws if
 * the most recent TRADE_SCAN_LIMIT signatures contain no trade but more exist.
 */
export async function lastTradeAt(rpc: RpcLike, ca: string): Promise<number | null> {
  const mint = new PublicKey(ca);
  let best: number | null = null;
  for (const addr of [bondingCurvePda(mint), canonicalPumpPoolPda(mint)]) {
    let before: string | undefined;
    let scanned = 0;
    let found = false;
    for (;;) {
      const sigs = await rpcCall('getSignaturesForAddress', () => rpc.getSignaturesForAddress(addr, { limit: 100, ...(before ? { before } : {}) }, 'confirmed'));
      for (const s of sigs) {
        scanned++;
        if (s.err) continue;
        if (best !== null && typeof s.blockTime === 'number' && s.blockTime * 1000 <= best) {
          found = true;
          break;
        }
        const tx = await rpcCall('getTransaction', () => rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
        if (!tx || typeof tx.blockTime !== 'number') continue;
        if (isTradeOf(tx, mint)) {
          best = Math.max(best ?? 0, tx.blockTime * 1000);
          found = true;
          break;
        }
      }
      if (found || sigs.length < 100) break;
      if (scanned >= TRADE_SCAN_LIMIT) throw new ChainUnavailableError(`no trade in the last ${scanned} signatures of ${addr.toBase58()}; refusing to guess`);
      before = sigs[sigs.length - 1]!.signature;
    }
  }
  return best;
}
