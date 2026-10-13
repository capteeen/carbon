import { EMPTY_READOUT } from '@argon/core/contracts';
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

/** The fee mode the log recorded for the launch (wallet.created.mode); never assumed. */
export function feeModeLabel(mode: WalletRow['mode']): string {
  if (mode === 'native') return 'NATIVE · sharing-config PDA';
  if (mode === 'wallet') return "WALLET · Argon's per-launch wallet receives the fees and splits them";
  return `fee mode not logged ${EMPTY_READOUT}`;
}

export function WalletsView({ rows, argon, network }: { rows: WalletRow[]; argon: { buyback: string | null; treasury: string | null }; network: Network }) {
  return (
    <>
      <h1 className="section-title">Wallets</h1>
      <p className="meta">// Argon never holds YOUR keys. Every per-launch fee address is public here.</p>
      <h2>Argon</h2>
      <ul className="plain" data-testid="argon-wallets">
        <li>
          <span className="hud-label">$ARGON BUYBACK (30%)</span>
          <Addr address={argon.buyback} network={network} />
        </li>
        <li>
          <span className="hud-label">ARGON TREASURY (20%)</span>
          <Addr address={argon.treasury} network={network} />
        </li>
      </ul>
      <h2>Per launch</h2>
      <p className="meta">
        // Every claimed creator fee is split 50% to the launcher, 30% to the buyback wallet and 20% to the treasury. How depends on the launch&apos;s fee mode, shown on each row from its wallet.created event:
      </p>
      <p className="meta">
        // NATIVE: pump.fun fee sharing. The address is the coin&apos;s sharing-config PDA, which pays the three shares directly. Argon never holds your 50%.
      </p>
      <p className="meta">
        // WALLET: Argon&apos;s per-launch wallet receives all of the launch&apos;s fees. Treasurer claims and splits them, paying your 50% to your wallet with a public receipt.
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
                  <span data-testid="fee-mode">{feeModeLabel(r.mode)}</span> · event <code>{shortId(r.eventId)}</code>
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
