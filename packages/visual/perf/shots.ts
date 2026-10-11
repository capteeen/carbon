// Screenshots of every chapter centre + standalone views (visual review). Usage:
//   node perf/shots.mjs [outDir] [--fixture]
import { mkdirSync } from 'node:fs';
import { launch, phonePage, scrollToProgress, startServer } from './shared.js';
import { CHAPTER_RANGES } from '../src/story/chapters.js';

const outDir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : './perf/out';
const fixture = process.argv.includes('--fixture');
const desktop = process.argv.includes('--desktop');
mkdirSync(outDir, { recursive: true });

const { server, url } = await startServer();
const browser = await launch();
try {
  const { page, errors, context } = await phonePage(browser, { dpr: 1 });
  if (desktop) await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${url}?view=story&smooth=0${fixture ? '&fixture=1' : ''}`);
  await page.waitForFunction(() => window.__carbon?.firstFrameAt != null, null, { timeout: 30000 });
  for (const r of CHAPTER_RANGES) {
    const extra = r.index === 3 ? [0.08, 0.5] : r.index === 9 ? [0.15, 0.9] : r.index === 4 ? [0.3, 0.6, 0.9] : [0.5];
    for (const l of extra) {
      const p = r.start + (r.end - r.start) * l;
      await scrollToProgress(page, p);
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${outDir}/story-${String(r.index).padStart(2, '0')}-${Math.round(l * 100)}.png` });
    }
  }
  for (const v of ['chamber', 'shapes', 'launch', 'graphene', 'embed']) {
    await page.goto(`${url}?view=${v}${fixture ? '&fixture=1' : ''}`);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${outDir}/${v}.png` });
  }
  console.log(JSON.stringify({ errors }, null, 2));
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
