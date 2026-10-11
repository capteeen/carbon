/**
 * POST /api/approvals/<approvalId>  { decision: 'grant' | 'reject', reason?, signature }
 * One tap: the launcher wallet signs messages.approval({approvalId, decision}).
 * The signature is verified (ed25519) against the launch's launcherWallet BEFORE
 * approvals.decide is called; decide re-checks that `by` is the launcher wallet.
 */
import { messages } from '@/lib/signing';
import { getCore } from '@/server/core';
import { HttpError, UUID_RE, handle, json, readJson, requireLauncher, str } from '@/server/http';
import { approvalLaunchId } from '@/server/readmodel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ approvalId: string }> }): Promise<Response> {
  return handle(async () => {
    const { approvalId } = await ctx.params;
    if (!UUID_RE.test(approvalId)) throw new HttpError(400, 'bad approval id');
    const body = await readJson(req);
    const decision = str(body, 'decision', 8);
    if (decision !== 'grant' && decision !== 'reject') throw new HttpError(400, "decision must be 'grant' or 'reject'");
    const signature = str(body, 'signature', 128);
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 280) : undefined;
    const launchId = await approvalLaunchId(approvalId);
    if (!launchId) throw new HttpError(404, 'unknown approval');
    const created = await requireLauncher(launchId, messages.approval({ approvalId, decision }), signature);
    const { approvals } = await getCore();
    await approvals.decide(approvalId, decision === 'grant', created.payload.launcherWallet, reason);
    return json({ ok: true, approvalId, decision });
  });
}
