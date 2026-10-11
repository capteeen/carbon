import { EMPTY_READOUT, FEE_SPLIT_BPS } from '@carbon/core/contracts';
import Link from 'next/link';
import { explorerUrl, lamportsToSol, shortId } from '@/lib/launch-view';
import type { ReceiptRow } from '@/lib/types';

const LEG_LABEL = { launcher: 'LAUNCHER 50%', 'carbon-buyback': '$CARBON BUYBACK 30%', treasury: 'TREASURY 20%' } as const;

export function ReceiptsView({ rows }: { rows: ReceiptRow[] }) {
  return (
    <>
      <h1 className="section-title">Receipts</h1>
      <p className="meta">
        // Every fee split, as logged by Treasurer. Split: {FEE_SPLIT_BPS.launcher / 100}% launcher · {FEE_SPLIT_BPS.carbonBuyback / 100}% $CARBON buyback ·{' '}
        {FEE_SPLIT_BPS.treasury / 100}% Carbon treasury.
      </p>
      {rows.length === 0 ? (
        <p className="empty" data-testid="receipts-empty">
          No fee splits yet. {EMPTY_READOUT}
        </p>
      ) : (
        <ul className="plain" data-testid="receipts">
          {rows.map((r) => (
            <li key={r.eventId} id={`ev-${r.eventId}`}>
              <div className="row">
                <span className="hud-label">SPLIT {shortId(r.receipt.splitId)}</span>
                {r.ca ? <Link href={`/l/${r.ca}`}>{r.ticker ? `$${r.ticker}` : shortId(r.ca)}</Link> : null}
                <span className="meta">{new Date(r.receipt.at).toISOString().replace('T', ' ').slice(0, 19)} UTC</span>
              </div>
              <p className="meta">
                claim <code>{shortId(r.receipt.claimId)}</code> · total {lamportsToSol(r.receipt.totalLamports)} SOL · event <code>{shortId(r.eventId)}</code>
              </p>
              <ul className="plain">
                {r.receipt.legs.map((l, i) => {
                  const tx = l.txSig ? explorerUrl('tx', l.txSig, r.network) : null;
                  return (
                    <li key={i}>
                      {LEG_LABEL[l.to]} · {lamportsToSol(l.lamports)} SOL → <code>{l.address}</code> · {l.status.toUpperCase()} ·{' '}
                      {l.txSig ? (
                        tx ? (
                          <a href={tx} target="_blank" rel="noreferrer">
                            tx {shortId(l.txSig)}
                          </a>
                        ) : (
                          <code>{shortId(l.txSig)}</code>
                        )
                      ) : (
                        <span className="meta">tx {EMPTY_READOUT}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
