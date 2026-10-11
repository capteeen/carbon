// Debug probe: open the story at progress p and dump leader lines + layer fades.
// Usage: npx tsx perf/probe.ts <progress> [--fixture]
import { launch, phonePage, scrollToProgress, startServer } from './shared.js';

const p = Number(process.argv[2] ?? 0);
const fixture = process.argv.includes('--fixture');
const { server, url } = await startServer();
const browser = await launch();
try {
  const { page, errors } = await phonePage(browser, { dpr: 1 });
  await page.goto(`${url}?view=story&smooth=0${fixture ? '&fixture=1' : ''}`);
  await page.waitForFunction(() => window.__carbon?.firstFrameAt != null);
  await scrollToProgress(page, p);
  await page.waitForTimeout(800);
  const out = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.carbon-leaders line')].map((l) => ({
      id: l.getAttribute('data-leader'),
      o: (l as SVGLineElement).style.opacity,
      x1: l.getAttribute('x1'),
      y1: l.getAttribute('y1'),
      x2: l.getAttribute('x2'),
      y2: l.getAttribute('y2'),
    }));
    const layers = [...document.querySelectorAll('.carbon-chapter')].map((s) => (s as HTMLElement).dataset.fade);
    const pin = document.querySelector('[data-testid=story-pin]') as HTMLElement;
    return { lines: lines.filter((l) => l.o !== '0'), layers, chapter3d: pin.dataset.chapter3d, chapterHud: pin.dataset.chapterHud, progress: window.__carbon.store.get() };
  });
  console.log(JSON.stringify({ ...out, errors }, null, 1));
} finally {
  await browser.close();
  await server.close();
}
