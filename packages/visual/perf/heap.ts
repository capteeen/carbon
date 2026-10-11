// Heap investigation: sampling heap profiler across scroll cycles; prints the
// call sites holding retained (post-GC) memory and per-frame allocation sites.
// Build the harness unminified first: HARNESS_MINIFY=0 npx vite build --config harness/vite.config.ts
//   npx tsx perf/heap.ts [--idle]
import { launch, phonePage, scrollToProgress, startServer } from './shared.js';

const idle = process.argv.includes('--idle');
interface Node {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: Node[];
}

function aggregate(root: Node) {
  const by = new Map<string, number>();
  const walk = (n: Node, stack: string[]) => {
    const name = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
    const st = [...stack, name];
    if (n.selfSize > 0) {
      const key = st.slice(-4).join(' < ');
      by.set(key, (by.get(key) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c, st);
  };
  walk(root, []);
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
}

const { server, url } = await startServer();
const browser = await launch();
try {
  const { page, cdp } = await phonePage(browser, { dpr: 1 });
  await page.goto(`${url}?view=story&smooth=0&fixture=1&dpr=0.3`);
  await page.waitForFunction(() => window.__carbon?.firstFrameAt != null);
  const sweep = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const el = document.querySelector('.carbon-story') as HTMLElement;
          const top = el.getBoundingClientRect().top + window.scrollY;
          const dist = el.offsetHeight - window.innerHeight;
          const t0 = performance.now();
          const step = (now: number) => {
            const t = (now - t0) / 6000;
            const p = t < 0.5 ? t * 2 : Math.max(0, 2 - t * 2);
            window.scrollTo(0, top + p * dist);
            if (t < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        }),
    );
  await sweep();
  await sweep();
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  // includeObjectsCollectedByMinorGC/MajorGC: false → only live (retained) samples; with --idle we want all allocations
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: idle, includeObjectsCollectedByMinorGC: idle });
  if (idle) {
    await scrollToProgress(page, 0.04);
    await page.waitForTimeout(4000);
  } else {
    await sweep();
    await sweep();
  }
  await cdp.send('HeapProfiler.collectGarbage');
  const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as { profile: { head: Node } };
  for (const [k, v] of aggregate(profile.head)) console.log(String(Math.round(v / 1024)).padStart(6), 'KB ', k);
} finally {
  await browser.close();
  await server.close();
}
