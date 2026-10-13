/**
 * Agent G: SPEC §5 honesty rule and §7 "Empty event stream → live views still; recorded
 * stream → identical replay", in a real browser against the Next production build.
 *
 *   tsx e2e/honesty.ts --empty=http://127.0.0.1:3201/ --replayUrl=http://127.0.0.1:3202/ \
 *       --replay=<seed json> --db=<postgres url of the replay schema> [--out=file.json]
 *
 * 1. Empty log (/): ch08 honest empty state;
 *    ch09 EMPTY_GRAPHENE; BONDS/LOAD "--.--"; no hashes, feed or receipts.
 * 2. Recorded log (/): ch08 is labelled "replaying $TICKER, <date>", shows the recorded
 *    hand-off hashes in order and the real CA; two independent page loads give identical
 *    HUD text at the same scroll positions (identical replay).
 * 3. /l/[ca] live: BONDS readouts at display time; a NEW signed hand-off appended to the log
 *    shows up through SSE, and ages out of the 60 s window with no further events (AG-009 in
 *    the browser).
 * 4. Stillness (component level, harness without fixture): LaunchScene with an empty stream
 *    renders pixel-identical frames over 3 s (grain/fog/glitch included); the same scene with
 *    events animates (control).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, type Page } from 'playwright-core';
import { createCore } from '@argon/core';
import { CHAPTER_RANGES } from '../../packages/visual/src/story/chapters.js';
import { startServer } from '../../packages/visual/perf/shared.js';

const arg = (k: string, d = '') => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const emptyUrl = arg('empty', 'http://127.0.0.1:3201/');
const replayUrl = arg('replayUrl', 'http://127.0.0.1:3202/');
const seedInfo = JSON.parse(readFileSync(arg('replay'), 'utf8')) as { schema: string; seed: string; launchId: string; ca: string; ticker: string; handoffs: string[]; deployDate: string };
const out = arg('out');
const results: Record<string, { ok: boolean; detail?: unknown }> = {};
const ok = (name: string, cond: boolean, detail?: unknown) => {
  results[name] = { ok: cond, ...(detail === undefined ? {} : { detail }) };
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await ctx.addInitScript('window.__name = (f) => f;');

async function openStory(url: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForFunction(() => (document.querySelector('[data-testid=story-pin]') as HTMLElement | null)?.dataset.chapter3d !== undefined, null, { timeout: 90_000 });
  return page;
}
async function scrollTo(page: Page, p: number) {
  await page.evaluate((p) => {
    const el = document.querySelector('.argon-story') as HTMLElement;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + p * (el.offsetHeight - window.innerHeight));
  }, p);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(150);
}
const layerText = (page: Page, i: number) => page.evaluate((i) => (document.querySelector(`.argon-chapter[data-chapter="${i}"]`) as HTMLElement).textContent ?? '', i);
const mid = (i: number, l = 0.5) => CHAPTER_RANGES[i]!.start + (CHAPTER_RANGES[i]!.end - CHAPTER_RANGES[i]!.start) * l;

try {
  // ── 1. empty log ──
  {
    const page = await openStory(emptyUrl);
    await scrollTo(page, mid(3, 0.1));
    const proton = await layerText(page, 3);
    ok('empty: ch03 BONDS and LOAD readouts are --.--', /BONDS\s+--\.--/.test(proton) && /LOAD\s+--\.--/.test(proton), proton.replace(/\s+/g, ' ').slice(0, 300));
    await scrollTo(page, mid(5));
    ok('empty: ch05 shows no hashes ("No hand-offs recorded yet")', /No hand-offs recorded yet/.test(await layerText(page, 5)) && !/[0-9a-f]{8}\s+[A-Z]+·[A-Z]+/.test(await layerText(page, 5)));
    await scrollTo(page, mid(8, 0.9));
    const ch8 = await layerText(page, 8);
    ok('empty: ch08 shows the honest empty state, no "replaying"', /No launch has been recorded yet/.test(ch8) && !/replaying/.test(ch8), ch8.replace(/\s+/g, ' ').slice(0, 200));
    await scrollTo(page, 0.995);
    const ch9 = await layerText(page, 9);
    ok('empty: ch09 says "No molecules yet. Launch the first one." with no feed or receipts', /No molecules yet\. Launch the first one\./.test(ch9) && /No reasoning logged yet/.test(ch9) && /No fee splits yet/.test(ch9), ch9.replace(/\s+/g, ' ').slice(0, 300));
    await page.close();
  }

  // ── 2. recorded log: identical replay ──
  {
    const pts = Array.from({ length: 21 }, (_, k) => mid(8, k / 20));
    const takes: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const page = await openStory(replayUrl);
      const texts: string[] = [];
      for (const p of pts) {
        await scrollTo(page, p);
        texts.push((await layerText(page, 8)).replace(/\s+/g, ' '));
      }
      takes.push(texts);
      await page.close();
    }
    const last = takes[0]![takes[0]!.length - 2]!; // local 0.95: fully typed, layer still visible
    ok('replay: label is "replaying $TICKER, <date>"', last.includes(`replaying $${seedInfo.ticker}, ${seedInfo.deployDate}`), last.slice(0, 200));
    const shownHashes = [...last.matchAll(/\/\/ ([0-9a-f]{8}) /g)].map((m) => m[1]);
    const want = seedInfo.handoffs.slice(-4).map((h) => h.slice(0, 8));
    ok('replay: ch08 lists the last recorded hand-off hashes in order', JSON.stringify(shownHashes) === JSON.stringify(want), { shownHashes, want });
    ok('replay: the typed CA is the recorded CA', last.includes(seedInfo.ca), last.slice(-120));
    ok(`replay: two page loads give identical ch08 HUD text at ${pts.length} scroll points`, JSON.stringify(takes[0]) === JSON.stringify(takes[1]));
    const counts = takes[0]!.map((t) => /HAND-OFFS (\d+)\/(\d+)/.exec(t)?.slice(1).join('/'));
    ok('replay: hand-off counter is monotone in scroll and ends at all recorded', counts.every((c, i) => i === 0 || Number(c?.split('/')[0]) >= Number(counts[i - 1]?.split('/')[0])) && counts[counts.length - 1] === `${seedInfo.handoffs.length}/${seedInfo.handoffs.length}`, counts);
  }

  // ── 3. /l/[ca]: bonds at display time, live through SSE, ageing out ──
  {
    const page = await ctx.newPage();
    await page.goto(new URL(`/l/${seedInfo.ca}`, replayUrl).toString());
    await page.waitForSelector('[data-testid=launch-bonds]', { timeout: 60_000 });
    const bonds = () => page.evaluate(() => (document.querySelector('[data-testid=launch-bonds]') as HTMLElement).innerText.replace(/\s+/g, ' '));
    const before = await bonds();
    ok('/l/[ca]: recorded hand-offs older than 60 s show BONDS 0/4 at display time', !/BONDS [1-4]\/4/.test(before), before);
    const core = await createCore({ databaseUrl: `postgres://carbon:carbon@localhost:5432/carbon_test`, redisUrl: 'redis://localhost:6379', seed: seedInfo.seed, schema: seedInfo.schema });
    const h = await core.handoffs.send(seedInfo.launchId, 'herald', 'keeper', 'e2e-live', 'agent g live probe');
    const t0 = Date.now();
    await page.waitForFunction(() => /HERALD\s+BONDS 1\/4/.test((document.querySelector('[data-testid=launch-bonds]') as HTMLElement).innerText), null, { timeout: 20_000 }).catch(() => undefined);
    const live = await bonds();
    ok('/l/[ca]: a new signed hand-off reaches the page over SSE as HERALD/KEEPER BONDS 1/4', /HERALD BONDS 1\/4/.test(live) && /KEEPER BONDS 1\/4/.test(live), { live, ms: Date.now() - t0, hash: h.id.slice(0, 8) });
    await page.waitForFunction(() => !/BONDS [1-4]\/4/.test((document.querySelector('[data-testid=launch-bonds]') as HTMLElement).innerText), null, { timeout: 80_000 }).catch(() => undefined);
    const aged = await bonds();
    const agedAfter = Date.now() - h.ts;
    ok('/l/[ca]: with no further events the bond ages out of the 60 s window (display time, AG-009)', !/BONDS [1-4]\/4/.test(aged) && agedAfter >= 59_000 && agedAfter < 63_500, { aged, agedAfterMs: agedAfter });
    await core.close();
    await page.close();
  }

  // ── 4. stillness: LaunchScene with an empty stream (component, harness without fixture) ──
  {
    const { server, url } = await startServer();
    try {
      const frameHashes = async (q: string) => {
        const page = await ctx.newPage();
        await page.goto(`${url}?view=launch${q}`);
        await page.waitForSelector('canvas', { timeout: 60_000 });
        // the quality ladder steps grain/DPR down during the first ~8 s under SwiftShader (a size/post
        // change, not motion); measure once it has settled at its floor
        await page.waitForTimeout(11000);
        const hs: string[] = [];
        for (let i = 0; i < 5; i++) {
          hs.push(createHash('sha256').update(await page.locator('canvas').first().screenshot()).digest('hex').slice(0, 12));
          await page.waitForTimeout(1000);
        }
        await page.close();
        return hs;
      };
      const still = await frameHashes('');
      const moving = await frameHashes('&fixture=1');
      ok('stillness: LaunchScene with an empty event stream renders identical frames over 4 s (after the quality ladder settles)', new Set(still).size === 1, still);
      ok('stillness control: the same scene with recorded events animates', new Set(moving).size > 1, moving);
    } finally {
      await server.close();
    }
  }
} finally {
  await browser.close();
}
const text = JSON.stringify(results, null, 2);
if (out) writeFileSync(out, text);
console.log(text);
const failed = Object.entries(results).filter(([, v]) => !v.ok);
console.log(`${Object.keys(results).length - failed.length}/${Object.keys(results).length} honesty checks pass`);
if (failed.length) process.exitCode = 1;
