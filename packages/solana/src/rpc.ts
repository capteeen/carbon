/**
 * The slice of @solana/web3.js `Connection` this package uses. Production
 * passes a real Connection; tests pass a fixture-backed double from test/.
 */
import type { Connection } from '@solana/web3.js';
import { ChainUnavailableError, errorMessage } from './errors.js';

export type RpcLike = Pick<
  Connection,
  | 'getAccountInfo'
  | 'getMultipleAccountsInfo'
  | 'getLatestBlockhash'
  | 'getBlockHeight'
  | 'sendRawTransaction'
  | 'getSignatureStatuses'
  | 'getTransaction'
  | 'getSignaturesForAddress'
  | 'getProgramAccounts'
  | 'getAddressLookupTable'
  | 'simulateTransaction'
  | 'getMinimumBalanceForRentExemption'
  | 'getBalance'
  | 'getSlot'
  | 'getGenesisHash'
>;

/** The pump SDKs type their argument as Connection but only call RpcLike methods on it. */
export function asConnection(rpc: RpcLike): Connection {
  return rpc as unknown as Connection;
}

/** Run an RPC call; any failure becomes a ChainUnavailableError naming the call. */
export async function rpcCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ChainUnavailableError) throw e;
    throw new ChainUnavailableError(`${what}: ${errorMessage(e)}`, { cause: e });
  }
}
