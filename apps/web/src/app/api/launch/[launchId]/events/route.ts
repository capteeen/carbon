/**
 * GET /api/launch/<launchId>/events: one launch's complete public event log
 * (the same events /api/events/<launchId> streams). The home page loads it to
 * recompute a molecule's bonds over its full log.
 */
import { HttpError, handle, json } from '@/server/http';
import { getLaunchEvents } from '@/server/readmodel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LAUNCH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function GET(_req: Request, ctx: { params: Promise<{ launchId: string }> }): Promise<Response> {
  return handle(async () => {
    const { launchId } = await ctx.params;
    if (!LAUNCH_ID_RE.test(launchId)) throw new HttpError(400, 'bad launch id');
    return json({ events: await getLaunchEvents(launchId) });
  });
}
