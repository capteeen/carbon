/**
 * Display time is SERVER time (AG-032). Bonds age out 60 s after their hand-off's ts,
 * and those ts are server clock readings, so evaluating them against a skewed browser
 * clock would drop bonds early (fast clock) or keep them too long (slow clock).
 *
 * The clock keeps an offset = serverNow - clientNow from the latest sample:
 *   - the page's renderedAt prop, observed at hydration (a coarse first sample: it
 *     understates server time by the render-to-hydration delay), then
 *   - every `server-time` message on the SSE stream (sent on connect and with each
 *     heartbeat), which replaces the coarse sample.
 */
export type ClockSource = 'render' | 'stream';

export class ServerClock {
  private offset: number | null = null;
  private source: ClockSource | null = null;

  /** Records that the server read `serverMs` when this client read `clientMs`. */
  observe(serverMs: number, clientMs: number, source: ClockSource): void {
    if (!Number.isFinite(serverMs) || !Number.isFinite(clientMs)) return;
    // a stream sample is fresher than the render-time sample; never let render override it
    if (source === 'render' && this.source === 'stream') return;
    this.offset = serverMs - clientMs;
    this.source = source;
  }

  /** Server time corresponding to the client's `clientMs` (the client clock if no sample yet). */
  now(clientMs: number): number {
    return clientMs + (this.offset ?? 0);
  }

  get offsetMs(): number | null {
    return this.offset;
  }
}

/** The page-wide clock (one server per page). */
export const serverClock = new ServerClock();

/** SSE event name carrying the server's Date.now() (see @carbon/core/sse). */
export const SERVER_TIME_EVENT = 'server-time';
