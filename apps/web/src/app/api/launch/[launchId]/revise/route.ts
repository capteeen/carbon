/**
 * POST /api/launch/<launchId>/revise { scoreEventId, stop, name, ticker, note, newArt, signature }
 * Answers LaunchUser.revise after Sentinel blocks: a revision (re-draft + re-run) or stop.
 */
import type { ArgonEvent } from '@argon/core/contracts';
import { messages } from '@/lib/signing';
import { getCore } from '@/server/core';
import { EVENT_ID_RE, HttpError, UUID_RE, bool, handle, json, readJson, requireLauncher, str } from '@/server/http';
import { insertUserInput } from '@/server/inputs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const opt = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function POST(req: Request, ctx: { params: Promise<{ launchId: string }> }): Promise<Response> {
  return handle(async () => {
    const { launchId } = await ctx.params;
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'bad launch id');
    const body = await readJson(req);
    const scoreEventId = str(body, 'scoreEventId', 64);
    if (!EVENT_ID_RE.test(scoreEventId)) throw new HttpError(400, 'bad event id');
    const stop = bool(body, 'stop');
    const name = opt(body.name, 32);
    const ticker = opt(body.ticker, 13);
    const note = opt(body.note, 280);
    const newArt = body.newArt === true;
    const signature = str(body, 'signature', 128);
    const created = await requireLauncher(launchId, messages.revise({ launchId, scoreEventId, stop, name, ticker, note, newArt }), signature);
    const { bus } = await getCore();
    const ev = (await bus.get(scoreEventId)) as ArgonEvent<'sentinel.score'> | null;
    if (!ev || ev.launchId !== launchId || ev.kind !== 'sentinel.score') throw new HttpError(404, 'unknown score');
    if (ev.payload.passed) throw new HttpError(409, 'this score passed; nothing to revise');
    const ok = await insertUserInput({
      launchId,
      kind: 'revision',
      ref: scoreEventId,
      payload: stop ? { stop: true } : { stop: false, ...(name ? { name } : {}), ...(ticker ? { ticker } : {}), ...(note ? { note } : {}), newArt },
      wallet: created.payload.launcherWallet,
      signature,
    });
    if (!ok) throw new HttpError(409, 'already answered');
    return json({ ok: true }, 202);
  });
}
