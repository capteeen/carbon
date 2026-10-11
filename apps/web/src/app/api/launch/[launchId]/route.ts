/** GET /api/launch/<launchId>: which launcher questions are already answered (narrative, revision, signed tx). */
import { HttpError, UUID_RE, handle, json } from '@/server/http';
import { answeredRefs } from '@/server/inputs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(_req: Request, ctx: { params: Promise<{ launchId: string }> }): Promise<Response> {
  return handle(async () => {
    const { launchId } = await ctx.params;
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'bad launch id');
    return json({ answered: await answeredRefs(launchId) });
  });
}
