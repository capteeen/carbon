import { expect, test } from '@playwright/test';

const FOOTER =
  'Carbon does not run on a quantum computer. Agents are powered by Google Gemini; Carbon is not affiliated with or endorsed by Google. Coins launch on pump.fun (Solana). A meme, not an investment.';

const PAGES = ['/', '/launch', '/receipts', '/wallets', '/how'];
const UNKNOWN_CA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

for (const path of PAGES) {
  test(`${path} loads at 390x844 with no console errors and the footer`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    // 'load', not 'networkidle': live pages hold an SSE connection open.
    const res = await page.goto(path, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId('footer-text')).toHaveText(FOOTER);
    // No horizontal scroll at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });
}

test('empty log: honest empty states on /', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('graphene-empty')).toHaveText('No molecules yet. Launch the first one.');
  await expect(page.locator('body')).not.toContainText('replaying');
});

test('unknown CA: /l, /embed and /og are 404s', async ({ request }) => {
  expect((await request.get(`/l/${UNKNOWN_CA}`)).status()).toBe(404);
  expect((await request.get(`/embed/${UNKNOWN_CA}`)).status()).toBe(404);
  expect((await request.get(`/og/${UNKNOWN_CA}`)).status()).toBe(404);
});
