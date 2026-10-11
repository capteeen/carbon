// Shared helpers for the Playwright perf/sync/screenshot scripts (Node, ESM).
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

export const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

export function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(c)) {
      // the directory form holds the binary at chrome-linux/chrome
      if (existsSync(`${c}/chrome-linux/chrome`)) return `${c}/chrome-linux/chrome`;
      if (!c.endsWith('/chromium')) return c;
    }
  }
  return undefined;
}

export async function startServer() {
  const server = await preview({ configFile: `${pkgRoot}harness/vite.config.ts`, preview: { port: 5180, strictPort: false, host: '127.0.0.1' } });
  const url = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5180/';
  return { server, url };
}

export async function launch() {
  return chromium.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
}

export async function phonePage(browser: any, { throttle = 1, dpr = 2 } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  page.on("console", (m: any) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const cdp = await context.newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  return { context, page, cdp, errors };
}

/** Scroll so that story progress == p (programmatic, no Lenis smoothing). */
export async function scrollToProgress(page: any, p: number) {
  await page.evaluate((p) => {
    const el = document.querySelector('.carbon-story');
    const top = el.getBoundingClientRect().top + window.scrollY;
    const dist = el.offsetHeight - window.innerHeight;
    window.scrollTo(0, top + p * dist);
  }, p);
}

export function stats(xs: number[]) {
  const a = [...xs].sort((x, y) => x - y);
  const q = (f: number) => a[Math.min(a.length - 1, Math.max(0, Math.floor(f * (a.length - 1))))];
  const mean = a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  return { n: a.length, median: q(0.5), p95: q(0.95), p99: q(0.99), mean };
}
