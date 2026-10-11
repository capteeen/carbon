import { EMPTY_READOUT } from '@carbon/core/contracts';
import Link from 'next/link';
import { explorerUrl, shortId } from '@/lib/launch-view';
import type { Network, WalletRow } from '@/lib/types';

function Addr({ address, network }: { address: string | null; network: Network | null }) {
  if (!address) return <span>{EMPTY_READOUT}</span>;
  const href = explorerUrl('address', address, network);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      <code>{address}</code>
    </a>
  ) : (
    <code>{address}</code>
  );
}

export function WalletsView({ rows, carbon, network }: { rows: WalletRow[]; carbon: { buyback: string | null; treasury: string | null }; network: Network }) {
  return (
    <>
      <h1 className="section-title">Wallets</h1>
      <p className="meta">// Carbon never holds YOUR keys. Every per-launch fee address is public here.</p>
      <h2>Carbon</h2>
      <ul className="plain" data-testid="carbon-wallets">
        <li>
          <span className="hud-label">$CARBON BUYBACK (30%)</span>
          <Addr address={carbon.buyback} network={network} />
        </li>
        <li>
          <span className="hud-label">CARBON TREASURY (20%)</span>
          <Addr address={carbon.treasury} network={network} />
        </li>
      </ul>
      <h2>Per launch</h2>
      <p className="meta">
        // Native pump.fun fee sharing: the address is the coin&apos;s sharing-config PDA, which pays 50% to the launcher, 30% to the buyback wallet and 20% to the treasury.
      </p>
      {rows.length === 0 ? (
        <p className="empty" data-testid="wallets-empty">
          No launch wallets yet. {EMPTY_READOUT}
        </p>
      ) : (
        <ul className="plain" data-testid="launch-wallets">
          {rows.map((r) => (
            <li key={r.launchId}>
              <div className="row">
                {r.ca ? <Link href={`/l/${r.ca}`}>{r.ticker ? `$${r.ticker}` : shortId(r.ca)}</Link> : <span className="meta">launch {shortId(r.launchId)}</span>}
                <span className="meta">
                  {r.mode === 'native' ? 'sharing-config PDA' : 'per-launch creator wallet'} · event <code>{shortId(r.eventId)}</code>
                </span>
              </div>
              <Addr address={r.address} network={r.network ?? network} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
