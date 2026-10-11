// Smoke: load each harness view, report console/page errors. Usage: npx tsx perf/smoke.ts [view...] [--fixture]
import { launch, phonePage, startServer } from './shared.js';

const fixture = process.argv.includes('--fixture');
const views = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = views.length ? views : ['story', 'chamber', 'shapes', 'launch', 'graphene', 'embed'];
const { server, url } = await startServer();
const browser = await launch();
let failed = 0;
try {
  for (const v of list) {
    const { page, errors, context } = await phonePage(browser, { dpr: 1 });
    await page.goto(`${url}?view=${v}&smooth=0${fixture ? '&fixture=1' : ''}`);
    await page.waitForTimeout(3500);
    const ok = await page.evaluate(() => !!document.querySelector('canvas'));
    if (!ok || errors.length) failed++;
    console.log(`${v}: canvas=${ok} errors=${errors.length}`);
    for (const e of errors.slice(0, 5)) console.log('   ', e.slice(0, 600));
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
