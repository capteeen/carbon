/**
 * Agent G: SPEC §7 "Scroll forward and back: 3D, HUD and labels stay in sync at every point."
 * Independent of packages/visual/perf/perf.ts (which samples 36 points at 20/50/80% of each chapter).
 *
 *   tsx e2e/sync.ts --url=http://127.0.0.1:3202/ [--replay=<seed json>] [--out=file.json]
 *
 * Against the Next production build at 390x844 (Chromium at /opt/pw-browsers). For every sample:
 *  - progress p is read from the scroll position (the store is written from it);
 *  - 3D chapter (pin data-chapter3d, written by the r3f frame loop) == chapterAt(p);
 *  - HUD chapter (pin data-chapter-hud, React) == chapterAt(p);
 *  - every copy/HUD layer's fade (anime.js onScroll) == the chapter table's envelope at p (±0.03),
 *    and no layer other than the current chapter's is visible away from its edges;
 *  - ch03 proton HUD == protonAt(local); ch08 replay hand-off counter == replayedCountAt(local, n)
 *    and typed CA == typedCa(ca, caCharsAt(local)), when a replay exists.
 * Orders: dense forward grid, dense backward grid, random jumps, chapter/proton boundaries ±0.0015,
 * and a continuous rAF sweep (forward+back) that records per-frame mismatches WITHOUT settling,
 * plus the frames needed to re-agree after each random jump.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { CHAPTER_RANGES, chapterAt, chapterFade, chapterLocal, protonAt, caCharsAt, replayedCountAt } from '../../packages/visual/src/story/chapters.js';
import { typedCa } from '../../packages/visual/src/hud/format.js';

const arg = (k: string, d = '') => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const url = arg('url', 'http://127.0.0.1:3202/');
const replayFile = arg('replay');
const out = arg('out', '');
const replay = replayFile ? (JSON.parse(readFileSync(replayFile, 'utf8')) as { ca: string; handoffs: string[] }) : null;
const AGENTS = ['scout', 'forge', 'herald', 'keeper', 'treasurer', 'sentinel'];

interface Sample {
  p: number;
  c3d: number;
  chud: number;
  fades: number[];
  proton: string | null;
  replayCount: string | null;
  ca: string | null;
}

async function read(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const el = document.querySelector('.argon-story') as HTMLElement;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const dist = Math.max(1, el.offsetHeight - window.innerHeight);
    const pin = document.querySelector('[data-testid=story-pin]') as HTMLElement;
    return {
      p: Math.min(1, Math.max(0, (window.scrollY - top) / dist)),
      c3d: Number(pin.dataset.chapter3d ?? -1),
      chud: Number(pin.dataset.chapterHud ?? -1),
      fades: [...document.querySelectorAll<HTMLElement>('.argon-chapter')].map((l) => Number(l.dataset.fade ?? -1)),
      proton: document.querySelector('[data-testid=proton-hud]')?.getAttribute('data-agent') ?? null,
      replayCount: document.querySelector('[data-testid=replay-count]')?.textContent ?? null,
      ca: document.querySelector('[data-ca-typing]')?.textContent ?? null,
    };
  });
}

function check(s: Sample): string[] {
  const e = chapterAt(s.p);
  const local = chapterLocal(s.p, e);
  const bad: string[] = [];
  if (s.c3d !== e) bad.push(`3d=${s.c3d}≠${e}`);
  if (s.chud !== e) bad.push(`hud=${s.chud}≠${e}`);
  for (let i = 0; i < s.fades.length; i++) {
    const want = chapterFade(chapterLocal(s.p, i), i) * (i === e ? 1 : 0);
    // layers of other chapters must be invisible; the current one carries the table's envelope
    const got = s.fades[i]!;
    if (i === e ? Math.abs(got - chapterFade(local, e)) > 0.03 : got > 0.03 && want === 0) bad.push(`fade[${i}]=${got.toFixed(3)}≠${(i === e ? chapterFade(local, e) : 0).toFixed(3)}`);
  }
  if (e === 3 && s.proton !== AGENTS[protonAt(local)]) bad.push(`proton=${s.proton}≠${AGENTS[protonAt(local)]}`);
  if (e === 8 && replay) {
    const n = replay.handoffs.length;
    const want = `${replayedCountAt(local, n)}/${n}`;
    if (!s.replayCount || s.replayCount.replace(/^\D+/, '') !== want) bad.push(`replay=${s.replayCount}≠${want}`);
    const ca = typedCa(replay.ca, caCharsAt(local, replay.ca.length));
    if (s.ca !== ca) bad.push(`ca="${s.ca}"≠"${ca}"`);
  }
  return bad;
}

async function scrollTo(page: Page, p: number) {
  await page.evaluate((p) => {
    const el = document.querySelector('.argon-story') as HTMLElement;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, top + p * (el.offsetHeight - window.innerHeight));
  }, p);
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
  await page.waitForTimeout(120);
}

/** Frames until every check agrees after a jump (polls each rAF, up to 120 frames). */
async function framesToAgree(page: Page): Promise<number> {
  for (let f = 0; f < 120; f++) {
    if (check(await read(page)).length === 0) return f;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  }
  return 120;
}

let seed = 20261011;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const result: Record<string, unknown> = { url, viewport: '390x844@1x', replay: !!replay };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await context.addInitScript('window.__name = (f) => f;');
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => (document.querySelector('[data-testid=story-pin]') as HTMLElement | null)?.dataset.chapter3d !== undefined, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);

  const grid = Array.from({ length: 201 }, (_, i) => i / 200);
  const boundaries: number[] = [];
  for (const r of CHAPTER_RANGES) for (const d of [-0.0015, 0.0015]) boundaries.push(Math.min(1, Math.max(0, r.start + d)));
  const r3 = CHAPTER_RANGES[3]!;
  for (let k = 1; k < 6; k++) for (const d of [-0.0015, 0.0015]) boundaries.push(r3.start + ((r3.end - r3.start) * k) / 6 + d);
  const r8 = CHAPTER_RANGES[8]!;
  for (let k = 0; k <= 40; k++) boundaries.push(r8.start + ((r8.end - r8.start) * k) / 40);
  const jumps = Array.from({ length: 150 }, () => rnd());
  const orders: Record<string, number[]> = { forward: grid, backward: [...grid].reverse(), boundaries, randomJumps: jumps };

  const sync: Record<string, { n: number; failures: unknown[] }> = {};
  for (const [name, pts] of Object.entries(orders)) {
    const failures: unknown[] = [];
    for (const p of pts) {
      await scrollTo(page, p);
      await settle(page);
      const s = await read(page);
      const bad = check(s);
      if (bad.length) failures.push({ p: Number(s.p.toFixed(5)), bad });
    }
    sync[name] = { n: pts.length, failures };
  }

  // recovery after a random jump: frames until every layer agrees (no settle)
  const lag: number[] = [];
  for (let i = 0; i < 60; i++) {
    await scrollTo(page, rnd());
    lag.push(await framesToAgree(page));
  }
  lag.sort((a, b) => a - b);

  // continuous sweep: sample every animation frame while scrolling (thumb-like), no settling
  const sweep = await page.evaluate(
    () =>
      new Promise<{ p: number; c3d: number; chud: number }[]>((resolve) => {
        const el = document.querySelector('.argon-story') as HTMLElement;
        const top = el.getBoundingClientRect().top + window.scrollY;
        const dist = el.offsetHeight - window.innerHeight;
        const pin = document.querySelector('[data-testid=story-pin]') as HTMLElement;
        const rows: { p: number; c3d: number; chud: number }[] = [];
        const t0 = performance.now();
        const D = 12000;
        const step = (now: number) => {
          // state as rendered for the PREVIOUS scroll write
          rows.push({ p: Math.min(1, Math.max(0, (window.scrollY - top) / dist)), c3d: Number(pin.dataset.chapter3d), chud: Number(pin.dataset.chapterHud) });
          const t = (now - t0) / D;
          const p = t < 0.5 ? t * 2 : Math.max(0, 2 - t * 2);
          window.scrollTo(0, top + p * dist);
          if (t < 1) requestAnimationFrame(step);
          else resolve(rows);
        };
        requestAnimationFrame(step);
      }),
  );
  let sweepMismatch3d = 0;
  let sweepMismatchHud = 0;
  for (const r of sweep.slice(1)) {
    const e = chapterAt(r.p);
    if (r.c3d !== e) sweepMismatch3d++;
    if (r.chud !== e) sweepMismatchHud++;
  }

  // reduced motion: stepped fades with the same information
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForFunction(() => (document.querySelector('[data-testid=story-pin]') as HTMLElement | null)?.dataset.chapter3d !== undefined, null, { timeout: 90_000 });
  const rm: unknown[] = [];
  for (const p of [...grid.filter((_, i) => i % 4 === 0), ...[...grid].reverse().filter((_, i) => i % 4 === 0)]) {
    await scrollTo(page, p);
    await settle(page);
    const s = await page.evaluate(() => {
      const el = document.querySelector('.argon-story') as HTMLElement;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const pin = document.querySelector('[data-testid=story-pin]') as HTMLElement;
      return {
        p: Math.min(1, Math.max(0, (window.scrollY - top) / Math.max(1, el.offsetHeight - window.innerHeight))),
        c3d: Number(pin.dataset.chapter3d),
        chud: Number(pin.dataset.chapterHud),
        active: [...document.querySelectorAll<HTMLElement>('.argon-chapter')].findIndex((l) => l.dataset.active === 'true'),
      };
    });
    const e = chapterAt(s.p);
    if (s.c3d !== e || s.chud !== e || s.active !== e) rm.push({ ...s, expected: e });
  }
  sync.reducedMotion = { n: 102, failures: rm };

  Object.assign(result, {
    sync: Object.fromEntries(Object.entries(sync).map(([k, v]) => [k, { agree: `${v.n - v.failures.length}/${v.n}`, failures: v.failures.slice(0, 12) }])),
    jumpRecoveryFrames: { median: lag[Math.floor(lag.length / 2)], p90: lag[Math.floor(lag.length * 0.9)], max: lag[lag.length - 1] },
    continuousSweep: { frames: sweep.length - 1, mismatch3d: sweepMismatch3d, mismatchHud: sweepMismatchHud },
    pageErrors: errors,
  });
  await context.close();
} finally {
  await browser.close();
}
const text = JSON.stringify(result, null, 2);
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
}
console.log(text);
