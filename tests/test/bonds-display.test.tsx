/**
 * SPEC §1/§7: "Displayed bond orders = orders recomputed from logs, always."
 * The web layer must display with THE pure function (computeBonds/bondTotals over
 * the full launch log at the display time), and a recorded log replayed at any
 * timestamp must give the same bonds as the server's Handoffs.bonds().
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_IDS, BOND_WINDOW_MS, EventBusHandoffs, bondTotals, computeBonds, type AgentId, type CarbonEvent } from '@carbon/core';
import { deriveLaunchView } from '@/lib/launch-view';
import { CarbonStory, LaunchScene } from '@/visual';
import { createLaunch, makeEnv, type Env } from './support/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** Display-time bonds exactly as LaunchLive/EmbedLive compute them. */
const displayBonds = (events: CarbonEvent[], now: number) => computeBonds(events, Math.max(now, events[events.length - 1]?.ts ?? 0));

function totalsFromMarkup(html: string): Record<AgentId, number | null> {
  const out = {} as Record<AgentId, number | null>;
  for (const a of AGENT_IDS) {
    const m = new RegExp(`${a.toUpperCase()} (\\d+|--\\.--)/4`).exec(html);
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
    // No other bond arithmetic anywhere in the web app.
    for (const f of ['apps/web/src/visual-fallback.tsx', 'apps/web/src/lib/launch-view.ts', 'apps/web/src/server/readmodel.ts']) {
      expect(src(f)).not.toMatch(/exchanges\s*>=\s*\d|BOND_WINDOW_MS/);
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
      <LaunchScene events={events} bonds={displayBonds(events, now)} sentinel={null} decay={deriveLaunchView('L', events).decay} daughter={null} />,
    );
    const shown = totalsFromMarkup(html);
    const truth = bondTotals(events, now);
    for (const a of AGENT_IDS) expect(shown[a]).toBe(truth[a]);
  });

  // LaunchLive passes bonds computed at `now` but LaunchScene computes the per-agent
  // totals with bondTotals(events) — i.e. at the LAST EVENT's ts. Once the 60 s window
  // passes with no new event, the page shows "BONDS: --.--" next to "SCOUT 4/4".
  it.fails('[AG-009] 2 minutes later, with no new events, LaunchScene totals still equal bondTotals at display time', () => {
    const events = log();
    const now = events[events.length - 1]!.ts + 2 * BOND_WINDOW_MS;
    const html = renderToStaticMarkup(
      <LaunchScene events={events} bonds={displayBonds(events, now)} sentinel={null} decay={deriveLaunchView('L', events).decay} daughter={null} />,
    );
    const shown = totalsFromMarkup(html);
    const truth = bondTotals(events, now);
    for (const a of AGENT_IDS) expect(shown[a], a).toBe(truth[a]);
  });

  // The home page's chapter 03 "BONDS n/4" readout is bondTotals() over the slice of
  // the latest launch that happens to fall inside the last 60 GLOBAL events
  // (recentGlobalEvents(60)), not over that launch's full log.
  it.fails('[AG-010] home chapter 03 BONDS n/4 equals the recomputation over the launch’s full log', () => {
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
    const html = renderToStaticMarkup(<CarbonStory live={live} replay={null} launches={[]} onOpenAgent={() => undefined} onOpenLaunch={() => undefined} />);
    const m = /PROTON_01_SCOUT[\s\S]*?BONDS (\d+|--\.--)\/4/.exec(html);
    expect(m?.[1]).toBe(String(bondTotals(full, 3_100).scout));
  });
});
