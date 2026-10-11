import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/** Smoke: build, start, load every page at 390×844 against an EMPTY log (throwaway schema in carbon_test). */
const PORT = 3123;
export const E2E_SCHEMA = 'web_e2e';
const DB = process.env.CARBON_TEST_DATABASE_URL ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';
const chromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['iPhone 13'],
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    // Sandbox: the preinstalled Chromium build (same revision Playwright 1.56 expects).
    ...(existsSync(chromium) ? { launchOptions: { executablePath: chromium } } : {}),
  },
  webServer: {
    command: `pnpm build && pnpm start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/how`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: `${DB}?options=-c%20search_path%3D${E2E_SCHEMA}`,
      REDIS_URL: process.env.CARBON_TEST_REDIS_URL ?? 'redis://localhost:6379',
      // A throwaway signing seed for this run only (the web app appends user events with it).
      CARBON_AGENT_KEY_SEED: randomBytes(32).toString('hex'),
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
