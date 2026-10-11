/**
 * POST /api/autopilot { launchId, actionClass: 'posts'|'replies'|'buybacks', enabled, issuedAt, signature }
 * Never for launches ('launch' is not a class). Core refuses enabling on DIAMOND
 * (every action gated) and after the kill switch. Each signed request is
 * single-use (a replayed signature is refused: AG-016).
 */
import { AUTOPILOT_CLASSES, type AutopilotClass } from '@carbon/core/contracts';
import { isFresh, messages } from '@/lib/signing';
import { getCore } from '@/server/core';
import { consumeSignedNonce } from '@/server/nonces';
import { HttpError, UUID_RE, bool, handle, int, json, readJson, requireLauncher, str } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJson(req);
    const launchId = str(body, 'launchId', 64);
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'bad launch id');
    const actionClass = str(body, 'actionClass', 16) as AutopilotClass;
    if (!AUTOPILOT_CLASSES.includes(actionClass)) throw new HttpError(400, 'autopilot classes are posts, replies and buybacks; launches are never autopiloted');
    const enabled = bool(body, 'enabled');
    const issuedAt = int(body, 'issuedAt');
    if (!isFresh(issuedAt)) throw new HttpError(401, 'signature expired; sign again');
    const signature = str(body, 'signature', 128);
    const text = messages.autopilot({ launchId, actionClass, enabled, issuedAt });
    const created = await requireLauncher(launchId, text, signature);
    await consumeSignedNonce('autopilot', launchId, created.payload.launcherWallet, text);
    const { approvals } = await getCore();
    await approvals.setAutopilot(launchId, actionClass, enabled, created.payload.launcherWallet);
    return json({ ok: true, actionClass, enabled });
  });
}
