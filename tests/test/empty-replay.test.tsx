/**
 * SPEC §7: "Empty event stream → live views still (render web pages with no data):
 * honest empty states '--.--' and 'No molecules yet. Launch the first one.'"
 * and "recorded stream → identical replay (fold twice / via SSE resume)".
 *
 * Unlike apps/web's own page test (which mocks the read model), these pages read a
 * REAL, freshly migrated, empty Postgres schema through the production read model.
 */
import { randomBytes } from 'node:crypto';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EMPTY_GRAPHENE, EMPTY_READOUT, FOOTER_TEXT, EventBusHandoffs, foldMolecule, type ArgonEvent } from '@argon/core';
import { sseStream } from '@argon/core/sse';
import { createLaunch, makeEnv, TEST_REDIS, type Env } from './support/env.js';

// apps/web is inlined, so Next's modules are mocked by the path apps/web resolves them to.
const NEXT = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const r = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  return { font: r.resolve('next/font/google'), nav: r.resolve('next/navigation') };
});
vi.mock(NEXT.font, () => ({
  Space_Mono: () => ({ variable: 'font-mono', className: 'font-mono' }),
  Nunito: () => ({ variable: 'font-display', className: 'font-display' }),
}));
vi.mock(NEXT.nav, async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/',
}));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const SAMPLE_WORDS = /\b(sample|mock|placeholder|lorem|ipsum|dummy|example coin|fake)\b/i;

let env: Env;

beforeAll(async () => {
  env = await makeEnv();
  process.env.DATABASE_URL = env.dbUrl;
  process.env.REDIS_URL = TEST_REDIS;
  process.env.ARGON_AGENT_KEY_SEED = env.seed;
  for (const k of ['ARGON_BUYBACK_WALLET', 'ARGON_TREASURY_WALLET', 'ARGON_NETWORK', 'ARGON_MAINNET_ENABLED']) delete process.env[k];
  (globalThis as { __argonCore?: unknown }).__argonCore = undefined;
});
afterAll(async () => {
  const g = globalThis as { __argonCore?: Promise<{ close(): Promise<void> }> };
  if (g.__argonCore) await (await g.__argonCore).close().catch(() => undefined);
  g.__argonCore = undefined;
  await env.cleanup();
});

async function renderPage(mod: Promise<{ default: (p: never) => Promise<ReactElement> | ReactElement }>, props?: unknown): Promise<string> {
  const { Providers } = await import('@/components/Providers');
  const { default: RootLayout } = await import('@/app/layout');
  const el = await (await mod).default(props as never);
  return renderToStaticMarkup(RootLayout({ children: createElement(Providers, null, el) as ReactNode }));
}

describe('empty event log, real read model: honest empty states and the footer on every page', () => {
  it('/ shows exactly the empty graphene text, "--.--" readouts, no replay, and the footer', async () => {
    const html = await renderPage(import('@/app/page'));
    expect(html).toContain(EMPTY_GRAPHENE);
    expect(html).toContain(EMPTY_READOUT);
    expect(html).not.toMatch(SAMPLE_WORDS);
    expect(html.replace(/\$ARGON/g, '')).not.toMatch(/\$[A-Z]{2,10}\b/); // no ticker that did not come from the log
    expect(html).toContain(esc(FOOTER_TEXT));
  });

  it('/receipts, /wallets, /how, /launch render with the footer and no invented data', async () => {
    for (const [name, mod] of [
      ['receipts', import('@/app/receipts/page')],
      ['wallets', import('@/app/wallets/page')],
      ['how', import('@/app/how/page')],
      ['launch', import('@/app/launch/page')],
    ] as const) {
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(new URL('../../apps/web', import.meta.url).pathname); // how.md is found from apps/web, as under Next
      const html = await renderPage(mod as never).finally(() => cwd.mockRestore());
      expect(html, name).toContain(esc(FOOTER_TEXT));
      expect(html, name).not.toMatch(/explorer\.solana\.com\/tx\//); // no receipt links
      if (name !== 'how') expect(html, name).not.toMatch(SAMPLE_WORDS);
      if (name === 'receipts' || name === 'wallets') expect(html, name).toContain(EMPTY_READOUT);
    }
  });

  it('not-found and error pages render inside the same layout (footer present)', async () => {
    for (const mod of [import('@/app/not-found'), import('@/app/error')]) {
      const html = await renderPage(mod as never, { error: new Error('x'), reset: () => undefined });
      expect(html).toContain(esc(FOOTER_TEXT));
    }
  });

  it('/l/[ca] and /embed/[ca] for an unknown CA are 404s, not empty fabricated launches', async () => {
    const params = Promise.resolve({ ca: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' });
    const L = await import('@/app/l/[ca]/page');
    const E = await import('@/app/embed/[ca]/page');
    await expect(L.default({ params })).rejects.toThrow(/404|NOT_FOUND/);
    await expect(E.default({ params })).rejects.toThrow(/404|NOT_FOUND/);
  });

  it('SSE on an empty log sends only the retry line and heartbeats', async () => {
    const ac = new AbortController();
    const stream = sseStream(env.core.bus, '*', null, { signal: ac.signal, heartbeatMs: 100 });
    const text = await drain(stream, 600, ac);
    const frames = text.split('\n\n').filter(Boolean);
    expect(frames[0]).toMatch(/^retry: \d+$/);
    for (const f of frames.slice(1)) expect(f).toBe(': keep-alive');
  });
});

async function drain(stream: ReadableStream<Uint8Array>, ms: number, ac: AbortController): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 50))]);
    if (!r) continue;
    if (r.done) break;
    out += dec.decode(r.value, { stream: true });
  }
  ac.abort();
  await reader.cancel().catch(() => undefined);
  return out;
}

/** Events delivered over SSE (parsed from data lines), stopping once `n` arrived. */
async function sseEvents(launchId: string, lastEventId: string | null, n: number): Promise<ArgonEvent[]> {
  const ac = new AbortController();
  const reader = sseStream(env.core.bus, launchId, lastEventId, { signal: ac.signal }).getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out: ArgonEvent[] = [];
  const deadline = Date.now() + 8000;
  while (out.length < n && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 100))]);
    if (!r) continue;
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const d = /^data: (.*)$/m.exec(frame);
      if (d) out.push(JSON.parse(d[1]!) as ArgonEvent);
    }
  }
  ac.abort();
  await reader.cancel().catch(() => undefined);
  return out;
}

describe('a recorded stream replays identically', () => {
  let launchId: string;
  let recorded: ArgonEvent[];
  beforeAll(async () => {
    launchId = await createLaunch(env.core, 'ring', 'Ar-39');
    const h = new EventBusHandoffs({ bus: env.core.bus, pool: env.core.bus.pool, now: env.clock.now, pollMs: 10, maxWaitMs: 100 });
    const ring = [['scout', 'forge'], ['forge', 'sentinel'], ['sentinel', 'treasurer'], ['treasurer', 'herald'], ['herald', 'keeper'], ['keeper', 'scout']] as const;
    for (let i = 0; i < 24; i++) {
      const [a, b] = ring[i % 6]!;
      await h.send(launchId, a, b, 'rec', `step ${i}`).catch(() => undefined);
      env.clock.advance(900 + ((i * 7919) % 3000));
    }
    await env.core.bus.append({ launchId, kind: 'reasoning', actor: 'scout', payload: { agent: 'scout', summary: 'recorded', refSeq: 1 } as never }).catch(() => undefined);
    recorded = await env.core.bus.list(launchId);
    expect(recorded.length).toBeGreaterThan(20);
  });

  it('folding the recorded log twice, or after a JSON round trip, or out of order, gives the same molecule', () => {
    const a = foldMolecule(recorded);
    const b = foldMolecule(recorded);
    const c = foldMolecule(JSON.parse(JSON.stringify(recorded)) as ArgonEvent[]);
    const d = foldMolecule([...recorded].reverse());
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
  });

  it('SSE from the start delivers exactly the recorded log; a resume from any Last-Event-ID delivers exactly the tail', async () => {
    const full = await sseEvents(launchId, '0', recorded.length);
    expect(full).toEqual(JSON.parse(JSON.stringify(recorded)));
    for (const cut of [1, Math.floor(recorded.length / 3), recorded.length - 2]) {
      const lastId = String(recorded[cut - 1]!.seq);
      const tail = await sseEvents(launchId, lastId, recorded.length - cut);
      expect(tail.map((e) => e.seq)).toEqual(recorded.slice(cut).map((e) => e.seq));
      expect(foldMolecule([...recorded.slice(0, cut), ...tail])).toEqual(foldMolecule(recorded));
    }
  });

  it('the browser view (server-rendered prefix + SSE tail merged) equals the view of the whole log', async () => {
    const { deriveLaunchView, mergeEvents } = await import('@/lib/launch-view');
    const whole = deriveLaunchView(launchId, recorded);
    const cut = Math.floor(recorded.length / 2);
    const tail = await sseEvents(launchId, String(recorded[cut - 1]!.seq), recorded.length - cut);
    // the client may also receive a duplicate across the seam
    const merged = mergeEvents(mergeEvents(recorded.slice(0, cut), [recorded[cut - 1]!]), tail);
    expect(deriveLaunchView(launchId, merged)).toEqual(whole);
    expect(deriveLaunchView(launchId, recorded)).toEqual(whole);
    void randomBytes;
  });
});
