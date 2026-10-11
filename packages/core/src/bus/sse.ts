/**
 * Server-Sent Events for Next.js route handlers:
 *
 *   export async function GET(req: Request, { params }) {
 *     const stream = sseStream(bus, params.launchId, req.headers.get('last-event-id'));
 *     return new Response(stream, { headers: SSE_HEADERS });
 *   }
 *
 * The SSE `id:` is the event's seq, so a reconnecting EventSource sends it back as
 * Last-Event-ID and the stream resumes from Postgres with no gaps or duplicates.
 */
import type { CarbonEvent } from '../contracts.js';
import type { ResumableEventBus } from './pg-bus.js';

export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export interface SseOptions {
  /** Comment heartbeat interval, ms. Default 15000. */
  heartbeatMs?: number;
  /** Client reconnect delay sent as `retry:`. Default 3000. */
  retryMs?: number;
  signal?: AbortSignal;
}

export function formatSse(e: CarbonEvent): string {
  // JSON.stringify never emits raw newlines, so one data line is always valid.
  return `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** Parses Last-Event-ID (a seq). Anything else means "from now". */
export function parseLastEventId(lastEventId: string | null | undefined): number | undefined {
  if (lastEventId == null) return undefined;
  const t = lastEventId.trim();
  if (!/^\d{1,15}$/.test(t)) return undefined;
  return Number(t);
}

export function sseStream(
  bus: ResumableEventBus,
  launchId: string | '*',
  lastEventId?: string | null,
  opts: SseOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const afterSeq = parseLastEventId(lastEventId);
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let done = false;

  const stop = () => {
    done = true;
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (s: string) => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          stop();
        }
      };
      push(`retry: ${opts.retryMs ?? 3000}\n\n`);
      unsubscribe = bus.subscribe(launchId, (e) => push(formatSse(e)), afterSeq === undefined ? {} : { afterSeq });
      heartbeat = setInterval(() => push(': keep-alive\n\n'), opts.heartbeatMs ?? 15_000);
      if (opts.signal) {
        if (opts.signal.aborted) {
          stop();
          controller.close();
        } else
          opts.signal.addEventListener('abort', () => {
            stop();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
      }
    },
    cancel() {
      stop();
    },
  });
}
