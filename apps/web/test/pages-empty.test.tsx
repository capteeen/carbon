// @vitest-environment jsdom
/**
 * Every page with an EMPTY event log: honest empty states only ("--.--",
 * "No molecules yet. Launch the first one."), nothing seeded, footer everywhere.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { EMPTY_GRAPHENE, EMPTY_READOUT, FOOTER_TEXT } from '@argon/core/contracts';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ev } from './helpers';

vi.mock('next/font/google', () => ({
  Space_Mono: () => ({ variable: 'font-mono', className: 'font-mono' }),
  Nunito: () => ({ variable: 'font-display', className: 'font-display' }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/server/readmodel', () => ({
  listLiveLaunches: async () => [],
  latestReplay: async () => null,
  recentGlobalEvents: async () => ({ events: [], lastSeq: 0 }),
  activeMolecule: async () => null,
  listReceipts: async () => [],
  listLaunchWallets: async () => [],
  getLaunchByCa: async () => null,
}));

class StubEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

beforeAll(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;
  for (const k of ['ARGON_BUYBACK_WALLET', 'ARGON_TREASURY_WALLET']) delete process.env[k];
});
afterEach(cleanup);

async function page(mod: Promise<{ default: (p: never) => Promise<ReactElement> | ReactElement }>, props?: unknown): Promise<ReactElement> {
  const { Providers } = await import('@/components/Providers');
  const el = await (await mod).default(props as never);
  return <Providers>{el}</Providers>;
}

const SAMPLE_WORDS = /\b(sample|mock|placeholder|lorem|example coin)\b/i;

describe('pages with an empty log', () => {
  it('/ shows the empty graphene, no replay, and "--.--" readouts', async () => {
    const { container } = render(await page(import('@/app/page')));
    expect(screen.getByTestId('graphene-empty').textContent).toBe(EMPTY_GRAPHENE);
    expect(container.textContent).not.toContain('replaying');
    expect(container.textContent).toContain(EMPTY_READOUT);
    expect(container.textContent).not.toMatch(SAMPLE_WORDS);
  });

  it('/receipts shows no receipts', async () => {
    const { container } = render(await page(import('@/app/receipts/page')));
    expect(screen.getByTestId('receipts-empty').textContent).toContain(EMPTY_READOUT);
    expect(container.querySelectorAll('a[href*="explorer"]').length).toBe(0);
  });

  it('/wallets shows "--.--" for unconfigured Argon wallets and no launch wallets', async () => {
    const { container } = render(await page(import('@/app/wallets/page')));
    expect(screen.getByTestId('wallets-empty')).toBeTruthy();
    expect(screen.getByTestId('argon-wallets').textContent).toContain(EMPTY_READOUT);
    expect(container.textContent).not.toMatch(SAMPLE_WORDS);
  });

  it('/launch starts with the wallet step and nothing pre-filled', async () => {
    const { container } = render(await page(import('@/app/launch/page')));
    await screen.findByText(/Sign and start/i);
    expect((container.querySelector('#line') as HTMLInputElement).value).toBe('');
    expect((screen.getByText(/Sign and start/i) as HTMLButtonElement).disabled).toBe(true);
  });

  it('/l/[ca] and /embed/[ca] for an unknown CA are 404s', async () => {
    const L = await import('@/app/l/[ca]/page');
    const E = await import('@/app/embed/[ca]/page');
    const params = Promise.resolve({ ca: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' });
    await expect(L.default({ params })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(E.default({ params })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a launch with only launch.created shows "--.--" everywhere data is missing', async () => {
    const { LaunchLive } = await import('@/components/LaunchLive');
    const { Providers } = await import('@/components/Providers');
    const created = ev('L', 'launch.created', { line: 'a line', isotope: 'Ar-39', shape: 'ring', heavyAgent: null, launcherWallet: '11111111111111111111111111111111', xConnected: false }, 'user');
    render(
      <Providers>
        <LaunchLive launchId="L" initial={[created]} lastSeq={created.seq} renderedAt={created.ts} />
      </Providers>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(EMPTY_READOUT);
    expect(screen.getByTestId('decay-status').textContent).toContain(`CLOCK ${EMPTY_READOUT}`);
    expect(screen.getByTestId('thinking-feed').textContent).toContain(EMPTY_READOUT);
  });
});

describe('footer', () => {
  it('the root layout renders FOOTER_TEXT verbatim around every page', async () => {
    const { default: RootLayout } = await import('@/app/layout');
    const html = renderToStaticMarkup(RootLayout({ children: 'PAGE' as ReactNode }));
    expect(html).toContain(FOOTER_TEXT.replace(/'/g, '&#x27;'));
    expect(html).toContain('PAGE');
  });
});
