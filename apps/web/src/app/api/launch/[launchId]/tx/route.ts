/**
 * Launch transaction relay between the worker (chain.buildLaunchTx → carbon_tx_requests)
 * and the launcher's wallet in the browser.
 *   GET  → the pending unsigned tx (base64, partially signed by the mint key), or 204.
 *   POST { requestId, signedTx } → checked (same message, launcher signature valid),
 *        then handed to the worker, which calls chain.submitLaunchTx.
 */
import { getCore } from '@/server/core';
import { HttpError, UUID_RE, handle, json, readJson, str } from '@/server/http';
import { getTxRequest, insertUserInput, pendingTxRequest } from '@/server/inputs';
import { launchCreated } from '@/server/readmodel';
import { checkSignedLaunchTx } from '@/server/tx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ launchId: string }> };

export function GET(_req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { launchId } = await ctx.params;
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'bad launch id');
    const r = await pendingTxRequest(launchId);
    if (!r) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    return json({ requestId: r.requestId, txBase64: r.txBase64, mint: r.mint, payer: r.payer, createdAt: r.createdAt });
  });
}

export function POST(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const { launchId } = await ctx.params;
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'bad launch id');
    const body = await readJson(req, 256 * 1024);
    const requestId = str(body, 'requestId', 64);
    const signedTx = str(body, 'signedTx', 200_000);
    const created = await launchCreated(launchId);
    if (!created) throw new HttpError(404, 'unknown launch');
    const r = await getTxRequest(requestId);
    if (!r || r.launchId !== launchId) throw new HttpError(404, 'unknown transaction request');
    if (r.status !== 'pending') throw new HttpError(409, 'transaction request is no longer pending');
    if (r.payer !== created.payload.launcherWallet) throw new HttpError(409, 'transaction payer is not the launcher wallet');
    const check = checkSignedLaunchTx(r.txBase64, signedTx, created.payload.launcherWallet);
    if (!check.ok) throw new HttpError(400, check.reason);
    const inserted = await insertUserInput({
      launchId,
      kind: 'signed_tx',
      ref: requestId,
      payload: { signedTx },
      wallet: created.payload.launcherWallet,
      signature: 'tx',
    });
    if (!inserted) throw new HttpError(409, 'already signed');
    const { bus } = await getCore();
    await bus.pool.query("UPDATE carbon_tx_requests SET status = 'signed' WHERE request_id = $1 AND status = 'pending'", [requestId]);
    return json({ ok: true }, 202);
  });
}
