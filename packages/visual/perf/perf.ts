/**
 * Perf + sync check for the Carbon story (Playwright + CDP, Chromium).
 *
 *   npx tsx perf/perf.ts [--throttle=4] [--seconds=16] [--empty] [--out=perf/results/latest.json]
 *   npx tsx perf/perf.ts --url=http://127.0.0.1:3124/ [--dpr=0.3]   (a running app page, e.g. the Next production build)
 *
 * With --url the page is measured as shipped: no harness hooks. A small init
 * script reads frame times from rAF, progress from the scroll position, first
 * frame from the pin's data-chapter3d (written by the r3f loop) and the quality
 * level from data-quality; --dpr sets the device pixel ratio (the app's cap is
 * the quality ladder's ≤1.5); reduced motion is emulated via prefers-reduced-motion.
 *
 * 1. Phone profile: 390x844 viewport, DPR 2, touch, CDP CPU throttling (default 4x).
 * 2. First frame: ms from navigation to the first rendered r3f frame.
 * 3. Frame times: scroll the whole story forward then back (rAF-driven, like a
 *    steady thumb scroll), recording every frame interval.
 * 4. Heap: CDP GC + heap usage before and after the scroll cycle (heap growth).
 * 5. Sync: at sampled progress values (forward, backward and shuffled), check
 *    that the 3D chapter (written by the r3f frame loop), the HUD chapter
 *    (React), the visible copy layer (anime.js onScroll) and its fade envelope
 *    all agree with chapterAt(progress); also with Lenis smooth scrolling on.
 *
 * NOTE: headless Chromium here renders WebGL with SwiftShader (CPU). Frame
 * times are a pessimistic proxy for a phone GPU, reported as measured.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHAPTER_RANGES, chapterAt, chapterFade, chapterLocal, protonAt } from '../src/story/chapters.js';
import { launch, phonePage, scrollToProgress, startServer, stats } from './shared.js';

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const throttle = Number(arg('throttle', '4'));
const seconds = Number(arg('seconds', '16'));
const empty = process.argv.includes('--empty');
const dprCap = arg('dpr', '');
const cycles = Number(arg('cycles', '3'));
const appUrl = arg('url', '');
const outPath = arg('out', `perf/results/${appUrl ? 'app' : 'latest'}${empty ? '-empty' : ''}${throttle !== 4 ? `-x${throttle}` : ''}${dprCap ? `-dpr${dprCap}` : ''}.json`);

/** Installed before any page script in --url mode (the harness defines its own window.__carbon). */
const APP_SHIM = `(() => {
  const c = { frames: [], recording: false, firstFrameAt: null, last: null };
  c.store = { get() {
    const el = document.querySelector('.carbon-story'); if (!el) return 0;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const dist = Math.max(1, el.offsetHeight - window.innerHeight);
    return Math.min(1, Math.max(0, (window.scrollY - top) / dist));
  } };
  c.quality = { level() { const pin = document.querySelector('[data-testid=story-pin]'); return Number(pin && pin.dataset.quality !== undefined ? pin.dataset.quality : -1); } };
  window.__carbon = c;
  const tick = (t) => {
    if (c.firstFrameAt === null) { const pin = document.querySelector('[data-testid=story-pin]'); if (pin && pin.dataset.chapter3d !== undefined) c.firstFrameAt = performance.now(); }
    if (c.recording && c.last !== null) c.frames.push(t - c.last);
    c.last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/** Page URL for a scenario: harness query params, or the app page as is. */
function pageUrl(base: string, o: { smooth: boolean; reduced?: boolean; dpr?: string }) {
  if (appUrl) return appUrl;
  return `${base}?view=story&smooth=${o.smooth ? 1 : 0}${o.reduced ? '&reduced=1' : ''}${empty ? '' : '&fixture=1'}${o.dpr ? `&dpr=${o.dpr}` : ''}`;
}

async function open(page: Page, base: string, o: { smooth: boolean; reduced?: boolean; dpr?: string }) {
  if (appUrl) await page.emulateMedia({ reducedMotion: o.reduced ? 'reduce' : 'no-preference' });
  await page.goto(pageUrl(base, o));
  await page.waitForFunction(() => window.__carbon?.firstFrameAt != null, null, { timeout: 60000 });
}

type Page = Awaited<ReturnType<typeof phonePage>>['page'];

async function settle(page: Page, ms = 160) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(ms);
}

async function readSync(page: Page) {
  return page.evaluate(() => {
    const pin = document.querySelector('[data-testid=story-pin]') as HTMLElement;
    const layers = [...document.querySelectorAll<HTMLElement>('.carbon-chapter')];
    const fades = layers.map((l) => Number(l.dataset.fade ?? (l.dataset.active === 'true' ? 1 : 0)));
    let best = -1;
    let bestV = -1;
    fades.forEach((v, i) => {
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    });
    const proton = document.querySelector('[data-testid=proton-hud]')?.getAttribute('data-agent') ?? null;
    return {
      p: window.__carbon.store.get(),
      chapter3d: Number(pin.dataset.chapter3d),
      chapterHud: Number(pin.dataset.chapterHud),
      copyLayer: best,
      copyFade: bestV,
      fades,
      proton,
    };
  });
}

const AGENTS = ['scout', 'forge', 'herald', 'keeper', 'treasurer', 'sentinel'];

function checkSample(s: Awaited<ReturnType<typeof readSync>>) {
  const expected = chapterAt(s.p);
  const local = chapterLocal(s.p, expected);
  const problems: string[] = [];
  if (s.chapter3d !== expected) problems.push(`3d=${s.chapter3d}`);
  if (s.chapterHud !== expected) problems.push(`hud=${s.chapterHud}`);
  // copy: the scrubbed layer must carry exactly the envelope of the store's progress
  const fadeExpected = chapterFade(local, expected);
  const fadeActual = s.fades[expected] ?? -1;
  if (Math.abs(fadeActual - fadeExpected) > 0.03) problems.push(`fade ${fadeActual.toFixed(3)}≠${fadeExpected.toFixed(3)}`);
  // and no other layer may be more visible (away from boundaries)
  if (fadeExpected > 0.5 && s.copyLayer !== expected) problems.push(`copyLayer=${s.copyLayer}`);
  if (expected === 3 && s.proton !== AGENTS[protonAt(local)]) problems.push(`proton=${s.proton}≠${AGENTS[protonAt(local)]}`);
  return { expected, local: Number(local.toFixed(3)), ok: problems.length === 0, problems };
}

function samplePoints(): number[] {
  const pts: number[] = [];
  for (const r of CHAPTER_RANGES) for (const l of [0.2, 0.5, 0.8]) pts.push(r.start + (r.end - r.start) * l);
  // proton sub-steps
  const r3 = CHAPTER_RANGES[3]!;
  for (let k = 0; k < 6; k++) pts.push(r3.start + (r3.end - r3.start) * ((k + 0.5) / 6));
  return pts;
}

function shuffled<T>(xs: T[], seed = 7): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const { server, url } = appUrl ? { server: null, url: appUrl } : await startServer();
const browser = await launch();
const deviceDpr = appUrl && dprCap ? Number(dprCap) : 2;
const result: Record<string, unknown> = {
  target: appUrl || 'harness',
  throttle,
  viewport: `390x844@${deviceDpr}x`,
  dprCap: dprCap || 'quality ladder (≤1.5)',
  renderer: 'SwiftShader (headless Chromium, CPU WebGL)',
  data: appUrl ? 'whatever the app log holds' : empty ? 'none' : 'test fixture',
  seconds,
  cycles,
};
const init = async (context: { addInitScript(s: string): Promise<void> }) => {
  if (appUrl) await context.addInitScript(APP_SHIM);
};
try {
  // ── perf run ──
  {
    const { page, cdp, errors, context } = await phonePage(browser, { throttle, dpr: deviceDpr });
    await init(context);
    await open(page, url, { smooth: false, dpr: dprCap });
    const firstFrameMs = await page.evaluate(() => window.__carbon.firstFrameAt);
    await page.waitForTimeout(1500);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const heapBefore = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };

    // warm-up pass (first visit compiles each chapter's shaders), then the measured pass
    const sweep = (secs: number, measure: boolean) =>
      page.evaluate(
        ({ secs, measure }) =>
          new Promise<number[]>((resolve) => {
            const el = document.querySelector('.carbon-story') as HTMLElement;
            const top = el.getBoundingClientRect().top + window.scrollY;
            const dist = el.offsetHeight - window.innerHeight;
            const frames: number[] = [];
            const t0 = performance.now();
            let last = t0;
            const half = (secs * 1000) / 2;
            const step = (now: number) => {
              const t = now - t0;
              if (measure) frames.push(now - last);
              last = now;
              const p = t < half ? t / half : Math.max(0, 2 - t / half);
              window.scrollTo(0, top + p * dist);
              if (t < secs * 1000) requestAnimationFrame(step);
              else resolve(frames.slice(1));
            };
            requestAnimationFrame(step);
          }),
        { secs, measure },
      );
    await sweep(Math.max(6, seconds / 2), false);
    await cdp.send('HeapProfiler.collectGarbage');
    const heapMid = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
    const frames: number[] = [];
    const heapAfterCycle: number[] = [];
    for (let c = 0; c < cycles; c++) {
      frames.push(...(await sweep(seconds, true)));
      await cdp.send('HeapProfiler.collectGarbage');
      heapAfterCycle.push(((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize);
    }
    const heapAfter = { usedSize: heapAfterCycle[heapAfterCycle.length - 1]! };
    // idle allocation rate: hold still in the hero for 5 s without forcing GC
    await scrollToProgress(page, 0.04);
    await page.waitForTimeout(800);
    await cdp.send('HeapProfiler.collectGarbage');
    const idle0 = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
    const idleFrames0 = await page.evaluate(() => window.__carbon.frames.length);
    await page.evaluate(() => (window.__carbon.recording = true));
    await page.waitForTimeout(5000);
    const idle1 = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
    const idleFrames = (await page.evaluate(() => window.__carbon.frames.length)) - idleFrames0;
    await page.evaluate(() => (window.__carbon.recording = false));
    const fs = stats(frames);
    const level = await page.evaluate(() => window.__carbon.quality.level());
    result.firstFrameMs = Math.round(firstFrameMs ?? -1);
    result.frames = { ...fs, medianFps: Number((1000 / fs.median).toFixed(1)), p95FrameMs: Number(fs.p95.toFixed(2)), meanFps: Number((1000 / fs.mean).toFixed(1)) };
    result.qualityLevelAfter = level;
    result.heap = {
      beforeMB: +(heapBefore.usedSize / 1e6).toFixed(2),
      afterWarmupMB: +(heapMid.usedSize / 1e6).toFixed(2),
      afterMeasuredMB: +(heapAfter.usedSize / 1e6).toFixed(2),
      afterEachCycleMB: heapAfterCycle.map((h) => +(h / 1e6).toFixed(3)),
      growthAcrossMeasuredCyclesKB: Math.round((heapAfter.usedSize - heapMid.usedSize) / 1e3),
      growthLastCycleKB: heapAfterCycle.length > 1 ? Math.round((heapAfterCycle[heapAfterCycle.length - 1]! - heapAfterCycle[heapAfterCycle.length - 2]!) / 1e3) : null,
      idleAllocKBPerFrame: idleFrames > 0 ? +((idle1.usedSize - idle0.usedSize) / 1e3 / idleFrames).toFixed(3) : null,
      idleFrames,
    };
    result.perfErrors = errors;
    await context.close();
  }

  // ── sync run (no throttle needed; checks agreement, not speed) ──
  {
    const { page, errors, context } = await phonePage(browser, { throttle: 1, dpr: 1 });
    await init(context);
    await open(page, url, { smooth: false });
    const pts = samplePoints();
    const orders = { forward: pts, backward: [...pts].reverse(), shuffled: shuffled(pts) };
    const sync: Record<string, { n: number; failures: unknown[] }> = {};
    for (const [name, list] of Object.entries(orders)) {
      const failures: unknown[] = [];
      for (const p of list) {
        await scrollToProgress(page, p);
        await settle(page);
        const s = await readSync(page);
        const c = checkSample(s);
        if (!c.ok) failures.push({ p: Number(s.p.toFixed(4)), ...c });
      }
      sync[name] = { n: list.length, failures };
    }
    // Lenis smooth scrolling on: wheel through the story, sample after it settles
    await open(page, url, { smooth: true });
    await page.mouse.move(195, 420);
    const lenisFailures: unknown[] = [];
    let lenisN = 0;
    for (const dir of [1, -1]) {
      for (let i = 0; i < 14; i++) {
        await page.mouse.wheel(0, dir * 520);
        await page.waitForTimeout(900);
        await settle(page);
        const s = await readSync(page);
        const c = checkSample(s);
        lenisN++;
        if (!c.ok) lenisFailures.push({ p: Number(s.p.toFixed(4)), ...c });
      }
    }
    sync.lenisWheel = { n: lenisN, failures: lenisFailures };
    // reduced motion: stepped fades carry the same information
    await open(page, url, { smooth: false, reduced: true });
    const rmFailures: unknown[] = [];
    for (const p of pts) {
      await scrollToProgress(page, p);
      await settle(page, 450);
      const s = await page.evaluate(() => {
        const pin = document.querySelector('[data-testid=story-pin]') as HTMLElement;
        const active = [...document.querySelectorAll<HTMLElement>('.carbon-chapter')].findIndex((l) => l.dataset.active === 'true');
        return { p: window.__carbon.store.get(), chapter3d: Number(pin.dataset.chapter3d), chapterHud: Number(pin.dataset.chapterHud), active };
      });
      const e = chapterAt(s.p);
      if (s.chapter3d !== e || s.chapterHud !== e || s.active !== e) rmFailures.push({ ...s, expected: e });
    }
    sync.reducedMotion = { n: pts.length, failures: rmFailures };
    result.sync = sync;
    result.syncErrors = errors;
    await context.close();
  }
} finally {
  await browser.close();
  await server?.close();
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));
const f = result.frames as { medianFps: number; p95FrameMs: number; n: number };
const sync = result.sync as Record<string, { n: number; failures: unknown[] }>;
console.log(
  JSON.stringify(
    {
      firstFrameMs: result.firstFrameMs,
      medianFps: f.medianFps,
      p95FrameMs: f.p95FrameMs,
      frames: f.n,
      qualityLevelAfter: result.qualityLevelAfter,
      heap: result.heap,
      sync: Object.fromEntries(Object.entries(sync).map(([k, v]) => [k, `${v.n - v.failures.length}/${v.n} agree`])),
      errors: [...(result.perfErrors as string[]), ...(result.syncErrors as string[])].length,
    },
    null,
    2,
  ),
);
const syncFailed = Object.values(sync).some((v) => v.failures.length > 0);
if (syncFailed) {
  for (const [k, v] of Object.entries(sync)) if (v.failures.length) console.log(k, JSON.stringify(v.failures.slice(0, 6)));
  process.exitCode = 1;
}
