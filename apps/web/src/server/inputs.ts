/**
 * The web side of the worker's tables (schema: apps/worker/src/migrations/001_worker.sql).
 * The web app writes signed launcher inputs and reads tx requests and assets.
 */
import { getCore } from './core';

export type UserInputKind = 'narrative' | 'revision' | 'signed_tx';

/** Inserts a signed input. Returns false when that question was already answered. */
export async function insertUserInput(i: {
  launchId: string;
  kind: UserInputKind;
  ref: string;
  payload: unknown;
  wallet: string;
  signature: string;
}): Promise<boolean> {
  const { bus } = await getCore();
  const r = await bus.pool.query(
    `INSERT INTO carbon_user_inputs (launch_id, kind, ref, payload, wallet, signature, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) ON CONFLICT (launch_id, kind, ref) DO NOTHING`,
    [i.launchId, i.kind, i.ref, JSON.stringify(i.payload), i.wallet, i.signature, Date.now()],
  );
  return r.rowCount === 1;
}

export async function answeredRefs(launchId: string): Promise<{ kind: UserInputKind; ref: string }[]> {
  const { bus } = await getCore();
  const r = await bus.pool.query<{ kind: UserInputKind; ref: string }>('SELECT kind, ref FROM carbon_user_inputs WHERE launch_id = $1', [launchId]);
  return r.rows;
}

export interface TxRequest {
  requestId: string;
  launchId: string;
  txBase64: string;
  mint: string;
  payer: string;
  status: 'pending' | 'signed' | 'expired';
  createdAt: number;
}

export async function pendingTxRequest(launchId: string): Promise<TxRequest | null> {
  const { bus } = await getCore();
  const r = await bus.pool.query<{ request_id: string; launch_id: string; tx_base64: string; mint: string; payer: string; status: TxRequest['status']; created_at: string }>(
    "SELECT * FROM carbon_tx_requests WHERE launch_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [launchId],
  );
  const row = r.rows[0];
  return row
    ? { requestId: row.request_id, launchId: row.launch_id, txBase64: row.tx_base64, mint: row.mint, payer: row.payer, status: row.status, createdAt: Number(row.created_at) }
    : null;
}

export async function getTxRequest(requestId: string): Promise<TxRequest | null> {
  const { bus } = await getCore();
  const r = await bus.pool.query<{ request_id: string; launch_id: string; tx_base64: string; mint: string; payer: string; status: TxRequest['status']; created_at: string }>(
    'SELECT * FROM carbon_tx_requests WHERE request_id = $1',
    [requestId],
  );
  const row = r.rows[0];
  return row
    ? { requestId: row.request_id, launchId: row.launch_id, txBase64: row.tx_base64, mint: row.mint, payer: row.payer, status: row.status, createdAt: Number(row.created_at) }
    : null;
}

export async function getAsset(launchId: string, name: string): Promise<{ mime: string; bytes: Buffer; sha256: string } | null> {
  const { bus } = await getCore();
  const r = await bus.pool.query<{ mime: string; bytes: Buffer; sha256: string }>(
    'SELECT mime, bytes, sha256 FROM carbon_assets WHERE launch_id = $1 AND name = $2',
    [launchId, name],
  );
  return r.rows[0] ?? null;
}
