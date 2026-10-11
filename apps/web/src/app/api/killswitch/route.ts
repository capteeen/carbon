/**
 * POST /api/killswitch { launchId, reason?, issuedAt, signature }
 * Turns autopilot off for the launch for good (core enforces it, including
 * revoking unconsumed autopilot grants).
 */
import { isFresh, messages } from '@/lib/signing';
import { getCore } from '@/server/core';
import { HttpError, UUID_RE, handle, int, json, readJson, requireLauncher, str } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJson(req);
    const launchId = str(body, 'launchId', 64);
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'bad launch id');
    const issuedAt = int(body, 'issuedAt');
    if (!isFresh(issuedAt)) throw new HttpError(401, 'signature expired; sign again');
    const signature = str(body, 'signature', 128);
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 280) : undefined;
    const created = await requireLauncher(launchId, messages.killSwitch({ launchId, issuedAt }), signature);
    const { approvals } = await getCore();
    await approvals.killSwitch(launchId, created.payload.launcherWallet, reason);
    return json({ ok: true });
  });
}
