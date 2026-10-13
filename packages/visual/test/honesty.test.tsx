/**
 * HONESTY (SPEC §5): chapters 00-07 are an illustrated explainer; live
 * readouts come only from props or show "--.--"; chapter 08 replays a real
 * launch or shows an empty state; chapter 09 shows real launches or
 * "No molecules yet. Launch the first one."; nothing in src/ carries sample data.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_GRAPHENE } from '@argon/core/contracts';
import { buildReplay, launchSummaryFromEvents } from '../src/data/derive.js';
import { GrapheneHud, ProtonHud, ReplayHud } from '../src/hud/panels.js';
import { ArgonStory } from '../src/story/ArgonStory.js';
import { StoryHud, type StoryHudProps } from '../src/story/StoryHud.js';
import { CSS_VARS, PALETTE } from '../src/tokens.js';
import { fixtureLaunch, fixtureLive } from './fixtures/events.js';

const base: StoryHudProps = {
  live: null,
  replay: null,
  launches: [],
  feed: [],
  receipts: [],
  recent: [],
  isotope: 'Ar-36',
  heavyAgent: null,
  shape: 'chain',
  proton: 0,
  replayed: 0,
  hovered: null,
  activeChapter: 0,
  reducedMotion: false,
};

function chapterHtml(html: string, i: number): string {
  const start = html.indexOf(`data-chapter="${i}"`);
  const next = html.indexOf(`data-chapter="${i + 1}"`);
  return html.slice(start, next < 0 ? undefined : next);
}

describe('story HUD with no data', () => {
  const html = renderToStaticMarkup(<StoryHud {...base} />);

  it('carries no illustration badge or note (removed at the owner\'s request, 2026-10-11)', () => {
    expect(html).not.toContain('ILLUSTRATED EXPLAINER');
    expect(html).not.toContain('Illustration, not live activity');
  });

  it('BONDS and LOAD show "--.--" without live data', () => {
    const ch3 = chapterHtml(html, 3);
    expect(ch3).toContain('BONDS --.--');
    expect(ch3).toContain('LOAD --.--');
    expect(ch3).not.toMatch(/BONDS \d/);
  });

  it('chapter 08 shows the honest empty state, chapter 09 the empty graphene copy', () => {
    expect(chapterHtml(html, 8)).toContain('data-testid="replay-empty"');
    expect(chapterHtml(html, 8)).not.toContain('replaying');
    expect(EMPTY_GRAPHENE).toBe('No molecules yet. Launch the first one.');
    expect(chapterHtml(html, 9)).toContain(EMPTY_GRAPHENE);
  });

  it('shows no hash anywhere', () => {
    expect(html).not.toMatch(/[0-9a-f]{8}/);
  });
});

describe('story HUD with real-shaped data', () => {
  const { events, bonds } = fixtureLaunch({ ticker: 'FIXT' });
  const replay = buildReplay(events, bonds)!;
  const launch = launchSummaryFromEvents(events)!;
  const live = fixtureLive();
  const html = renderToStaticMarkup(<StoryHud {...base} live={live} replay={replay} launches={[launch]} recent={live.recentHandoffs} />);

  it('BONDS/LOAD come from the live prop', () => {
    const s = live.agents.scout!;
    expect(chapterHtml(html, 3)).toContain(`BONDS ${s.bondOrders}/4`);
    expect(chapterHtml(html, 3)).toMatch(/LOAD \d\d\.\d\d [+-]\d\d\.\d\d/);
    // the readout names the one molecule whose bonds it shows
    expect(chapterHtml(html, 3)).toContain('bonds in $FIXT');
  });

  it('BONDS is "--.--" when no molecule full log backs it (never a count from a partial window)', () => {
    const noMol = { ...live, molecule: null };
    const h = renderToStaticMarkup(<StoryHud {...base} live={noMol} />);
    expect(chapterHtml(h, 3)).toContain('BONDS --.--');
    const unknown = { ...live, agents: Object.fromEntries(Object.entries(live.agents).map(([a, s]) => [a, { ...s!, bondOrders: null }])) };
    expect(chapterHtml(renderToStaticMarkup(<StoryHud {...base} live={unknown} />), 3)).toContain('BONDS --.--');
  });

  it('chapter 08 is labelled "replaying $TICKER, <date>"', () => {
    expect(chapterHtml(html, 8)).toContain('replaying $FIXT, 2026-09-01');
  });

  it('bond hashes shown are the first 8 chars of the flash event ids', () => {
    for (const f of live.recentHandoffs) expect(chapterHtml(html, 5)).toContain(f.hash.slice(0, 8));
  });

  it('chapter 09 lists launches instead of the empty copy', () => {
    expect(chapterHtml(html, 9)).not.toContain(EMPTY_GRAPHENE);
  });
});

describe('panels refuse invalid data', () => {
  it('ReplayHud with null replay is empty; ProtonHud with an agent missing from live is empty', () => {
    expect(renderToStaticMarkup(<ReplayHud replay={null} replayed={0} />)).toContain('replay-empty');
    const live = { asOf: 1, agents: {}, recentHandoffs: [] };
    expect(renderToStaticMarkup(<ProtonHud agent="forge" live={live} />)).toContain('BONDS --.--');
    expect(renderToStaticMarkup(<GrapheneHud launches={[]} hovered={null} />)).toContain(EMPTY_GRAPHENE);
  });

  it('ArgonStory server-renders with empty props and drops forged data', () => {
    const forged = { ...fixtureLive(), agents: {}, recentHandoffs: [{ pairKey: 'scout|forge' as never, hash: 'deadbeef', at: 1 }] };
    const html = renderToStaticMarkup(
      <ArgonStory live={forged} replay={{ ...buildReplay(fixtureLaunch().events)!, deployEventId: 'fake' }} launches={[]} smoothScroll={false} />,
    );
    expect(html).toContain('data-testid="replay-empty"');
    expect(html).toContain(EMPTY_GRAPHENE);
    expect(html).not.toContain('deadbeef');
    expect(html).toContain('Sound: Off');
  });
});

describe('source audit', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);

  it('src/ has no hardcoded hashes, CAs, sample launches or test imports', () => {
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/\b[0-9a-f]{64}\b/);
      expect(s, f).not.toMatch(/\b[1-9A-HJ-NP-Za-km-z]{32,44}pump\b/);
      expect(s, f).not.toMatch(/from ['"][./]*test\//);
      expect(s, f).not.toMatch(/\b(fixture|lorem|dummy|mock)\w*/i);
    }
  });

  it('CSS tokens match TS tokens', () => {
    const css = readFileSync(join(root, 'styles.css'), 'utf8').toLowerCase();
    for (const k of Object.keys(PALETTE) as (keyof typeof PALETTE)[]) {
      expect(css).toContain(`${CSS_VARS[k]}: ${PALETTE[k].toLowerCase()};`);
    }
  });
});
