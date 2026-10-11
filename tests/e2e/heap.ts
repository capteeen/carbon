/**
 * Agent G: heap growth across scroll cycles on the shipped page (SPEC §5 "no heap growth").
 *   tsx e2e/heap.ts --url=http://127.0.0.1:3202/ [--cycles=12] [--dpr=0.3]
 * Scrolls the whole story forward and back per cycle (rAF-driven), forces GC, records
 * used heap; then diffs object counts by constructor between two heap snapshots taken
 * after cycle 2 and after the last cycle, and prints the top growers.
 */
import { chromium } from 'playwright-core';

const arg = (k: string, d = '') => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const url = arg('url', 'http://127.0.0.1:3202/');
const cycles = Number(arg('cycles', '12'));
const dpr = Number(arg('dpr', '0.3'));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
await context.addInitScript('window.__name = (f) => f;');
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await page.goto(url);
await page.waitForFunction(() => (document.querySelector('[data-testid=story-pin]') as HTMLElement | null)?.dataset.chapter3d !== undefined, null, { timeout: 90_000 });
await page.waitForTimeout(1500);
await cdp.send('HeapProfiler.enable');

const sweep = () =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const el = document.querySelector('.carbon-story') as HTMLElement;
        const top = el.getBoundingClientRect().top + window.scrollY;
        const dist = el.offsetHeight - window.innerHeight;
        const t0 = performance.now();
        const step = (now: number) => {
          const t = (now - t0) / 8000;
          const p = t < 0.5 ? t * 2 : Math.max(0, 2 - t * 2);
          window.scrollTo(0, top + p * dist);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
  );

async function snapshotCounts(): Promise<Map<string, { n: number; size: number }>> {
  const chunks: string[] = [];
  const on = (e: { chunk: string }) => chunks.push(e.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', on);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', on);
  const snap = JSON.parse(chunks.join('')) as { snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }; nodes: number[]; strings: string[] };
  const f = snap.snapshot.meta.node_fields;
  const W = f.length;
  const iType = f.indexOf('type');
  const iName = f.indexOf('name');
  const iSize = f.indexOf('self_size');
  const types = snap.snapshot.meta.node_types[0];
  const m = new Map<string, { n: number; size: number }>();
  for (let i = 0; i < snap.nodes.length; i += W) {
    const type = types[snap.nodes[i + iType]!]!;
    const name = type === 'object' || type === 'closure' ? `${type}:${snap.strings[snap.nodes[i + iName]!]}` : type;
    const c = m.get(name) ?? { n: 0, size: 0 };
    c.n++;
    c.size += snap.nodes[i + iSize]!;
    m.set(name, c);
  }
  return m;
}

const heap: number[] = [];
let snapA: Map<string, { n: number; size: number }> | null = null;
for (let c = 0; c < cycles; c++) {
  await sweep();
  await cdp.send('HeapProfiler.collectGarbage');
  heap.push(((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize);
  if (c === 1) snapA = await snapshotCounts();
}
const snapB = await snapshotCounts();
const growers = [...snapB.entries()]
  .map(([k, v]) => ({ k, dn: v.n - (snapA!.get(k)?.n ?? 0), dsize: v.size - (snapA!.get(k)?.size ?? 0) }))
  .sort((a, b) => b.dsize - a.dsize)
  .slice(0, 15);
console.log(JSON.stringify({ url, dpr, cycles, heapAfterEachCycleKB: heap.map((h) => Math.round(h / 1e3)), growthFromCycle2KB: Math.round((heap[heap.length - 1]! - heap[1]!) / 1e3), topGrowersSinceCycle2: growers }, null, 2));
await browser.close();
