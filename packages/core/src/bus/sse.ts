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
import type { ArgonEvent } from '../contracts.js';
import type { ResumableEventBus } from './pg-bus.js';

export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export interface SseOptions {
  /** Heartbeat interval, ms. Default 15000. */
  heartbeatMs?: number;
  /**
   * Send the server clock: a `server-time` message on connect and as every heartbeat
   * (instead of a comment), so browsers can display on server time (AG-032). Default off.
   */
  serverTime?: boolean;
  /** Server clock (ms). Default Date.now. */
  now?: () => number;
  /** Client reconnect delay sent as `retry:`. Default 3000. */
  retryMs?: number;
  signal?: AbortSignal;
}

export function formatSse(e: ArgonEvent): string {
  // JSON.stringify never emits raw newlines, so one data line is always valid.
  return `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** SSE event name for the server's clock reading (no `id:`, so Last-Event-ID is untouched). */
export const SERVER_TIME_EVENT = 'server-time';

/**
 * The server's Date.now(), so browsers evaluate the 60 s bond window on server time
 * rather than their own (possibly skewed) clock (AG-032).
 */
export function formatServerTime(nowMs: number): string {
  return `event: ${SERVER_TIME_EVENT}\ndata: ${Math.trunc(nowMs)}\n\n`;
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
      const now = opts.now ?? Date.now;
      push(`retry: ${opts.retryMs ?? 3000}\n\n`);
      const beat = opts.serverTime ? () => formatServerTime(now()) : () => ': keep-alive\n\n';
      if (opts.serverTime) push(beat());
      unsubscribe = bus.subscribe(launchId, (e) => push(formatSse(e)), afterSeq === undefined ? {} : { afterSeq });
      heartbeat = setInterval(() => push(beat()), opts.heartbeatMs ?? 15_000);
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
