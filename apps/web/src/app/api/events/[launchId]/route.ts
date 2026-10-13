/**
 * Live event stream for one launch, or every launch with launchId '*'.
 * Resume: the SSE id is the event seq. A reconnecting EventSource sends it back as
 * Last-Event-ID; a first connection may pass ?after=<seq> (the seq the server
 * render ended at). Last-Event-ID wins over ?after.
 */
import { SSE_HEADERS, sseStream } from '@argon/core/sse';
import { getCore } from '@/server/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LAUNCH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(req: Request, ctx: { params: Promise<{ launchId: string }> }): Promise<Response> {
  const raw = decodeURIComponent((await ctx.params).launchId);
  const launchId = raw === '*' ? '*' : raw;
  if (launchId !== '*' && !LAUNCH_ID_RE.test(launchId)) return new Response('bad launch id', { status: 400 });
  const after = new URL(req.url).searchParams.get('after');
  const lastEventId = req.headers.get('last-event-id') ?? after;
  let bus;
  try {
    ({ bus } = await getCore());
  } catch (err) {
    // No event log on this deployment: 204 tells EventSource there is nothing to stream (and not to retry).
    if (err instanceof Error && err.name === 'LogNotConfiguredError') return new Response(null, { status: 204 });
    throw err;
  }
  const stream = sseStream(bus, launchId, lastEventId, { signal: req.signal, serverTime: true });
  return new Response(stream, { headers: SSE_HEADERS });
}
