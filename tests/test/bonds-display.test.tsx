/**
 * SPEC §1/§7: "Displayed bond orders = orders recomputed from logs, always."
 * The web layer must display with THE pure function (computeBonds/bondTotals over
 * the full launch log at the display time), and a recorded log replayed at any
 * timestamp must give the same bonds as the server's Handoffs.bonds().
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// HomeLive's router (resolved from apps/web, like the component's own import)
vi.mock('../../apps/web/node_modules/next/navigation.js', () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
import { AGENT_IDS, BOND_WINDOW_MS, EventBusHandoffs, bondTotals, computeBonds, type AgentId, type CarbonEvent } from '@carbon/core';
import { deriveLaunchView } from '@/lib/launch-view';
import { toVisualDecay } from '@/lib/visual-data';
import { LaunchScene } from '@/visual';
import { EmbedLive } from '@/components/EmbedLive';
import { HomeLive } from '@/components/HomeLive';
import { LaunchLive } from '@/components/LaunchLive';
import { Providers } from '@/components/Providers';
import { createLaunch, makeEnv, type Env } from './support/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [path.join(dir, d.name)] : [],
  );

/** Display-time bonds exactly as LaunchLive/EmbedLive compute them. */
const displayBonds = (events: CarbonEvent[], now: number) => computeBonds(events, Math.max(now, events[events.length - 1]?.ts ?? 0));

function totalsFromMarkup(html: string): Record<AgentId, number | null> {
  const out = {} as Record<AgentId, number | null>;
  for (const a of AGENT_IDS) {
    // real HUD readout: "SCOUT     BONDS 4/4" (label padded, then the fmtBonds value)
    const m = new RegExp(`${a.toUpperCase()}\\s+BONDS (\\d+|--\\.--)/4`).exec(html);
    out[a] = m ? (m[1] === '--.--' ? null : Number(m[1])) : null;
  }
  return out;
}

describe('the web layer displays bonds with THE pure function', () => {
  it('LaunchLive and EmbedLive compute display bonds with computeBonds from @carbon/core/bonds (no local re-implementation)', () => {
    for (const f of ['apps/web/src/components/LaunchLive.tsx', 'apps/web/src/components/EmbedLive.tsx']) {
      const s = src(f);
      expect(s).toMatch(/import \{ computeBonds \} from '@carbon\/core\/bonds'/);
      expect(s).not.toMatch(/orderFromExchanges|exchanges\s*>=\s*\d/);
    }
    // No other bond arithmetic anywhere in the web app or the visual package that draws it.
    for (const f of [...walk('apps/web/src'), ...walk('packages/visual/src')]) {
      expect(src(f), f).not.toMatch(/orderFromExchanges|exchanges\s*>=\s*\d/);
    }
    for (const f of ['apps/web/src/lib/launch-view.ts', 'apps/web/src/server/readmodel.ts', 'packages/visual/src/components/LaunchScene.tsx', 'packages/visual/src/components/EmbedPlayer.tsx']) {
      expect(src(f), f).not.toMatch(/BOND_WINDOW_MS|computeBonds|bondTotals|analyzeBonds/);
    }
  });

  it('[AG-009] display bonds are evaluated at DISPLAY time on a 1 s timer (never at the last event ts)', () => {
    for (const f of ['apps/web/src/components/LaunchLive.tsx', 'apps/web/src/components/EmbedLive.tsx', 'apps/web/src/components/HomeLive.tsx']) {
      const s = src(f);
      // ticks every second; the first render uses the server render time, not the last event
      // (home: ticks while a molecule exists; nothing to age out otherwise)
      expect(s, f).toMatch(/useNow\(1000, (true|active !== null), (props\.)?renderedAt\) \?\? (props\.)?renderedAt/);
      // no fallback to computeBonds(events) with the default (= last event) time
      expect(s, f).not.toMatch(/computeBonds\(events\)/);
    }
    for (const f of ['apps/web/src/app/l/[ca]/page.tsx', 'apps/web/src/app/embed/[ca]/page.tsx', 'apps/web/src/app/page.tsx']) {
      expect(src(f), f).toMatch(/renderedAt=\{Date\.now\(\)\}/);
    }
  });
});

describe('recorded log replay: server bonds == pure recomputation at many timestamps', () => {
  let env: Env;
  let launchId: string;
  let events: CarbonEvent[];
  beforeAll(async () => {
    env = await makeEnv();
    launchId = await createLaunch(env.core, 'ring');
    const h = new EventBusHandoffs({ bus: env.core.bus, pool: env.core.bus.pool, now: env.clock.now, pollMs: 10, maxWaitMs: 200 });
    // A recorded run: ring traffic with bursts (doubles/triples), blocks, gaps longer than the window.
    const ring: [AgentId, AgentId][] = [['scout', 'forge'], ['forge', 'sentinel'], ['sentinel', 'treasurer'], ['treasurer', 'herald'], ['herald', 'keeper'], ['keeper', 'scout']];
    for (let i = 0; i < 60; i++) {
      const [a, b] = ring[(i * 5) % 6]!;
      await h.send(launchId, i % 2 ? a : b, i % 2 ? b : a, 'rec', `rec ${i}`).catch(() => undefined);
      env.clock.advance(i % 13 === 0 ? BOND_WINDOW_MS + 5000 : 1700);
      if (i === 20) {
        await env.core.bus.append({ launchId, kind: 'agent.blocked', actor: 'forge', payload: { agent: 'forge', on: 'sentinel', reason: 'r' } });
        await env.core.bus.append({ launchId, kind: 'agent.blocked', actor: 'sentinel', payload: { agent: 'sentinel', on: 'forge', reason: 'r' } });
      }
      if (i === 35) await env.core.bus.append({ launchId, kind: 'agent.unblocked', actor: 'forge', payload: { agent: 'forge', on: 'sentinel' } });
    }
    events = await env.core.bus.list(launchId);
  });
  afterAll(async () => env.cleanup());

  it('Handoffs.bonds(at) equals computeBonds(log, at) and the client display function, every 500 ms across the run', async () => {
    const t0 = events[0]!.ts;
    const t1 = events[events.length - 1]!.ts + BOND_WINDOW_MS + 2000;
    let checked = 0;
    let nonEmpty = 0;
    for (let t = t0; t <= t1; t += 500) {
      const server = await env.core.handoffs.bonds(launchId, t);
      const pure = computeBonds(events, t);
      expect(server).toEqual(pure);
      // what the browser shows after receiving the same events over SSE (prefix up to t)
      const prefix = events.filter((e) => e.ts <= t);
      if (prefix.length) expect(displayBonds(prefix, t)).toEqual(pure);
      checked++;
      if (pure.length) nonEmpty++;
    }
    expect(checked).toBeGreaterThan(100);
    expect(nonEmpty).toBeGreaterThan(20);
  });

  it('replaying the same recorded log twice (and in shuffled delivery order) gives identical bonds and view', () => {
    const shuffled = [...events].sort(() => Math.random() - 0.5);
    const at = events[events.length - 1]!.ts;
    expect(computeBonds(shuffled, at)).toEqual(computeBonds(events, at));
    expect(JSON.stringify(deriveLaunchView(launchId, shuffled))).toBe(JSON.stringify(deriveLaunchView(launchId, events)));
  });

  it('[AG-010] / server render: the home readout uses the molecule full log from the real read model, not the 60-event window', async () => {
    (globalThis as { __carbonCore?: Promise<unknown> }).__carbonCore = Promise.resolve(env.core);
    try {
      const { activeMolecule, recentGlobalEvents } = await import('@/server/readmodel');
      const mol = (await activeMolecule())!;
      expect(mol.launchId).toBe(launchId);
      expect(mol.events.map((e) => e.id)).toEqual(events.map((e) => e.id)); // complete, not windowed
      expect((await recentGlobalEvents()).events.length).toBeLessThan(events.length);
      const { default: HomePage } = await import('@/app/page');
      const html = renderToStaticMarkup(await HomePage());
      const at = events[events.length - 1]!.ts; // env clock is ahead of wall time, so display time = last ts
      const m = /PROTON_01_SCOUT[\s\S]*?BONDS (\d+)\/4/.exec(html);
      expect(m?.[1]).toBe(String(bondTotals(events, at).scout));
    } finally {
      delete (globalThis as { __carbonCore?: unknown }).__carbonCore;
    }
  });

  it('every displayed seam hash is the first 8 chars of a real, verifiable hand-off event', () => {
    const at = events[events.length - 1]!.ts;
    for (const b of computeBonds(events, at)) {
      const e = events.find((x) => x.id === b.lastHash);
      expect(e?.kind).toBe('handoff');
      expect(env.core.bus.verify(e!)).toBe(true);
    }
  });
});

describe('the launch HUD readouts agree with the bonds shown next to them', () => {
  function log(): CarbonEvent[] {
    let seq = 0;
    const mk = (ts: number, kind: CarbonEvent['kind'], actor: CarbonEvent['actor'], payload: unknown): CarbonEvent =>
      ({ id: (++seq).toString(16).padStart(64, 'a'), seq, launchId: 'L', ts, kind, actor, payload, signer: '', sig: '' }) as CarbonEvent;
    return [
      mk(1_000, 'launch.created', 'user', { line: 'x', isotope: 'C-12', shape: 'diamond', heavyAgent: null, launcherWallet: 'w', xConnected: false }),
      ...(['forge', 'herald', 'keeper', 'treasurer'] as const).map((to, i) => mk(2_000 + i, 'handoff', 'scout', { from: 'scout', to, topic: 't', summary: 's' })),
    ];
  }

  it('right after the hand-offs, LaunchScene totals equal bondTotals at display time', () => {
    const events = log();
    const now = events[events.length - 1]!.ts;
    const html = renderToStaticMarkup(
      <LaunchScene events={events} bonds={displayBonds(events, now)} sentinel={null} decay={toVisualDecay(events, deriveLaunchView('L', events).decay)} daughter={null} />,
    );
    const shown = totalsFromMarkup(html);
    const truth = bondTotals(events, now);
    for (const a of AGENT_IDS) expect(shown[a]).toBe(truth[a]);
  });

  // Was: LaunchLive passed bonds computed at `now` but the scene computed per-agent totals
  // at the LAST EVENT's ts. The real LaunchScene sums the bonds it is given.
  it('[AG-009] 2 minutes later, with no new events, LaunchScene totals still equal bondTotals at display time', () => {
    const events = log();
    const now = events[events.length - 1]!.ts + 2 * BOND_WINDOW_MS;
    const html = renderToStaticMarkup(
      <LaunchScene events={events} bonds={displayBonds(events, now)} sentinel={null} decay={toVisualDecay(events, deriveLaunchView('L', events).decay)} daughter={null} />,
    );
    const shown = totalsFromMarkup(html);
    const truth = bondTotals(events, now);
    for (const a of AGENT_IDS) expect(shown[a], a).toBe(truth[a]);
  });

  it('[AG-009] /l/[ca] (LaunchLive) and /embed/[ca] (EmbedLive) rendered 2 minutes after the last event show bonds at display time', async () => {
    const events = log();
    for (const late of [0, 2 * BOND_WINDOW_MS]) {
      const renderedAt = events[events.length - 1]!.ts + late;
      const html = renderToStaticMarkup(
        <Providers>
          <LaunchLive launchId="L" initial={events} lastSeq={events.length} renderedAt={renderedAt} />
        </Providers>,
      );
      const shown = totalsFromMarkup(html);
      const truth = bondTotals(events, renderedAt);
      for (const a of AGENT_IDS) expect(shown[a], `${a} +${late}`).toBe(truth[a]);
      // the embed draws exactly computeBonds(log, display time): one seam per bond
      const summary = { launchId: 'L', ca: null, name: null, ticker: null, isotope: 'C-12' as const, shape: 'diamond' as const, heavyAgent: null, score: null, threshold: null, network: null, createdAt: 1_000, deployedAt: null, state: null, logoUri: null, deployEventId: null, collapsed: false };
      const embed = renderToStaticMarkup(<EmbedLive launch={summary} initial={events} lastSeq={events.length} site="https://x" renderedAt={renderedAt} />);
      expect(embed).toContain('data-testid="launch-scene"');
    }
  });

  // Was: the home page's chapter 03 "BONDS n/4" readout was bondTotals() over the slice of
  // the latest launch inside the last 60 GLOBAL events (recentGlobalEvents(60)).
  // Now: app/page.tsx also passes the active molecule's COMPLETE log (activeMolecule()),
  // and HomeLive names that molecule next to the readout.
  it('[AG-010] home chapter 03 BONDS n/4 equals the recomputation over the launch’s full log', () => {
    let seq = 0;
    const mk = (ts: number, kind: CarbonEvent['kind'], actor: CarbonEvent['actor'], payload: unknown): CarbonEvent =>
      ({ id: (++seq).toString(16).padStart(64, 'b'), seq, launchId: 'L', ts, kind, actor, payload, signer: '', sig: '' }) as CarbonEvent;
    const full: CarbonEvent[] = [
      mk(1_000, 'launch.created', 'user', { line: 'x', isotope: 'C-12', shape: 'diamond', heavyAgent: null, launcherWallet: 'w', xConnected: false }),
      ...(['forge', 'herald', 'keeper', 'treasurer'] as const).map((to, i) => mk(2_000 + i, 'handoff', 'scout', { from: 'scout', to, topic: 't', summary: 's' })),
    ];
    for (let i = 0; i < 59; i++) full.push(mk(3_000 + i, 'reasoning', 'forge', { agent: 'forge', forEventId: full[1]!.id, text: `step ${i}` }));
    full.push(mk(3_100, 'handoff', 'scout', { from: 'scout', to: 'sentinel', topic: 't', summary: 'raw fifth (ignored in the full log)' }));
    const live = { events: full.slice(-60), lastSeq: seq }; // what app/page.tsx passes: recentGlobalEvents(60)
    const molecule = { launchId: 'L', events: full }; // and activeMolecule(): the launch's full log
    const html = renderToStaticMarkup(<HomeLive launches={[]} replay={null} live={live} molecule={molecule} renderedAt={3_100} />);
    const m = /PROTON_01_SCOUT[\s\S]*?BONDS (\d+|--\.--)\/4/.exec(html);
    expect(m?.[1]).toBe(String(bondTotals(full, 3_100).scout));
    expect(html).toContain('bonds in launch L');
  });

  it('[AG-010] without the full log the home readout is "--.--", never a count from the window', () => {
    let seq = 0;
    const mk = (ts: number, kind: CarbonEvent['kind'], actor: CarbonEvent['actor'], payload: unknown): CarbonEvent =>
      ({ id: (++seq).toString(16).padStart(64, 'c'), seq, launchId: 'M', ts, kind, actor, payload, signer: '', sig: '' }) as CarbonEvent;
    const window = [mk(5_000, 'handoff', 'scout', { from: 'scout', to: 'sentinel', topic: 't', summary: 's' })];
    const html = renderToStaticMarkup(<HomeLive launches={[]} replay={null} live={{ events: window, lastSeq: seq }} molecule={null} renderedAt={5_000} />);
    expect(/PROTON_01_SCOUT[\s\S]*?BONDS (\d+\/4|--\.--)/.exec(html)?.[1]).toBe('--.--');
  });
});

// ───────────────────────── AG-032: display time is server time, not the device clock ─────────────────────────

describe('[AG-032] display bonds use server time even when the device clock is skewed', () => {
  function log(): CarbonEvent[] {
    let seq = 0;
    const mk = (ts: number, kind: CarbonEvent['kind'], actor: CarbonEvent['actor'], payload: unknown): CarbonEvent =>
      ({ id: (++seq).toString(16).padStart(64, 'd'), seq, launchId: 'S', ts, kind, actor, payload, signer: '', sig: '' }) as CarbonEvent;
    return [
      mk(1_000_000, 'launch.created', 'user', { line: 'x', isotope: 'C-12', shape: 'ring', heavyAgent: null, launcherWallet: 'w', xConnected: false }),
      mk(1_001_000, 'handoff', 'scout', { from: 'scout', to: 'forge', topic: 't', summary: 's' }),
    ];
  }

  it('a device 90 s fast (or 90 s slow) shows exactly the bonds of the log at true server time', async () => {
    const { ServerClock } = await import('@/lib/server-clock');
    const events = log();
    const handoffTs = events[1]!.ts;
    for (const skew of [90_000, -90_000]) {
      const clock = new ServerClock();
      const serverAtSample = handoffTs + 1_000;
      clock.observe(serverAtSample, serverAtSample + skew, 'stream'); // the SSE server-time sample
      for (const trueElapsed of [2_000, 30_000, 59_000, 61_000, 120_000]) {
        const trueNow = handoffTs + trueElapsed;
        const deviceNow = trueNow + skew;
        const shown = clock.now(deviceNow);
        expect(shown).toBe(trueNow);
        expect(displayBonds(events, shown), `skew ${skew} at +${trueElapsed}`).toEqual(computeBonds(events, trueNow));
      }
      // and the skewed device clock alone would have shown something else
      // (fast: the bond vanishes at true +30 s; slow: it is still shown at true +61 s)
      const at = handoffTs + (skew > 0 ? 30_000 : 61_000);
      expect(displayBonds(events, at + skew)).not.toEqual(computeBonds(events, at));
    }
  });

  it('the stream sample wins over the coarse render-time sample', async () => {
    const { ServerClock } = await import('@/lib/server-clock');
    const clock = new ServerClock();
    clock.observe(1_000, 91_500, 'render'); // hydration: renderedAt vs a fast device clock
    expect(clock.now(91_500)).toBe(1_000);
    clock.observe(2_000, 92_000, 'stream');
    clock.observe(1_000, 99_000, 'render'); // a later component's stale renderedAt is ignored
    expect(clock.now(92_000)).toBe(2_000);
  });

  it('the web SSE route sends the server clock (event server-time, no id) and the client applies it in useNow', async () => {
    const { sseStream, SERVER_TIME_EVENT } = await import('@carbon/core/sse');
    const web = await import('@/lib/server-clock');
    expect(web.SERVER_TIME_EVENT).toBe(SERVER_TIME_EVENT);
    const fakeBus = { subscribe: () => () => undefined } as unknown as Parameters<typeof sseStream>[0];
    const ac = new AbortController();
    const reader = sseStream(fakeBus, '*', null, { signal: ac.signal, serverTime: true, now: () => 1_234_567 }).getReader();
    let text = '';
    const dec = new TextDecoder();
    while (!text.includes('server-time')) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
    ac.abort();
    const frame = text.split('\n\n').find((f) => f.includes('server-time'))!;
    expect(frame).toBe(`event: ${SERVER_TIME_EVENT}\ndata: 1234567`);
    expect(src('apps/web/src/app/api/events/[launchId]/route.ts')).toMatch(/serverTime: true/);
    const hook = src('apps/web/src/lib/use-events.ts');
    expect(hook).toMatch(/addEventListener\(SERVER_TIME_EVENT/);
    expect(hook).toMatch(/setNow\(serverClock\.now\(Date\.now\(\)\)\)/);
    expect(hook).not.toMatch(/setNow\(Date\.now\(\)\)/);
  });
});
