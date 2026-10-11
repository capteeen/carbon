/**
 * POST /api/launch/<launchId>/choice { proposalsEventId, narrative, name, signature }
 * The launcher picks one of Scout's real proposals (LaunchUser.chooseNarrative).
 */
import type { CarbonEvent } from '@carbon/core/contracts';
import { messages } from '@/lib/signing';
import { getCore } from '@/server/core';
import { EVENT_ID_RE, HttpError, UUID_RE, handle, int, json, readJson, requireLauncher, str } from '@/server/http';
import { insertUserInput } from '@/server/inputs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request, ctx: { params: Promise<{ launchId: string }> }): Promise<Response> {
  return handle(async () => {
    const { launchId } = await ctx.params;
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'bad launch id');
    const body = await readJson(req);
    const proposalsEventId = str(body, 'proposalsEventId', 64);
    if (!EVENT_ID_RE.test(proposalsEventId)) throw new HttpError(400, 'bad event id');
    const narrative = int(body, 'narrative');
    const name = int(body, 'name');
    const signature = str(body, 'signature', 128);
    const created = await requireLauncher(launchId, messages.chooseNarrative({ launchId, proposalsEventId, narrative, name }), signature);
    const { bus } = await getCore();
    const ev = (await bus.get(proposalsEventId)) as CarbonEvent<'scout.proposals'> | null;
    if (!ev || ev.launchId !== launchId || ev.kind !== 'scout.proposals') throw new HttpError(404, 'unknown proposals');
    const pick = ev.payload.narratives[narrative]?.names[name];
    if (!pick) throw new HttpError(400, 'choice out of range');
    const ok = await insertUserInput({
      launchId,
      kind: 'narrative',
      ref: proposalsEventId,
      payload: { narrative, name },
      wallet: created.payload.launcherWallet,
      signature,
    });
    if (!ok) throw new HttpError(409, 'already chosen');
    return json({ ok: true }, 202);
  });
}
