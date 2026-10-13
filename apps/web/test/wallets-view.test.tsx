/**
 * /wallets shows each launch's ACTUAL fee mode from its wallet.created event (AG-019):
 * "never holds your 50%" only for native; wallet mode says Argon's wallet receives
 * the fees and splits them; no logged mode is shown as unknown, never assumed native.
 */
import { EMPTY_READOUT } from '@argon/core/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WalletsView, feeModeLabel } from '@/components/WalletsView';
import type { WalletRow } from '@/lib/types';

const row = (launchId: string, mode: WalletRow['mode']): WalletRow => ({
  launchId,
  ca: null,
  ticker: null,
  address: '11111111111111111111111111111111',
  mode,
  network: 'devnet',
  eventId: 'e'.repeat(64),
});

describe('WalletsView fee mode', () => {
  it('labels each row by the logged mode', () => {
    expect(feeModeLabel('native')).toMatch(/^NATIVE/);
    expect(feeModeLabel('wallet')).toMatch(/^WALLET · Argon's per-launch wallet receives the fees and splits them/);
    expect(feeModeLabel(null)).toBe(`fee mode not logged ${EMPTY_READOUT}`);
  });

  it('renders one mode per row; the 50% claim is scoped to native mode', () => {
    const html = renderToStaticMarkup(
      <WalletsView rows={[row('a', 'native'), row('b', 'wallet'), row('c', null)]} argon={{ buyback: null, treasury: null }} network="devnet" />,
    ).replace(/&#x27;|&#39;/g, "'");
    const modes = [...html.matchAll(/data-testid="fee-mode">([^<]*)</g)].map((m) => m[1]);
    expect(modes).toEqual([feeModeLabel('native'), feeModeLabel('wallet'), feeModeLabel(null)]);
    expect(html).toMatch(/NATIVE: pump\.fun fee sharing[^<]*Argon never holds your 50%\./);
    expect(html).toMatch(/WALLET: Argon's per-launch wallet receives all of the launch's fees/);
  });
});
