import { FOOTER_TEXT } from '@argon/core/contracts';
import Link from 'next/link';
import { ARGON_X } from '@/lib/social';

/** On every page (rendered by the root layout). The text is FOOTER_TEXT, verbatim. */
export function Footer() {
  return (
    <footer className="site-footer">
      <nav className="footer-nav" aria-label="Argon">
        <Link href="/">ARGON</Link>
        <Link href="/launch">LAUNCH</Link>
        <Link href="/receipts">RECEIPTS</Link>
        <Link href="/wallets">WALLETS</Link>
        <Link href="/how">HOW</Link>
        <a href={ARGON_X.url} target="_blank" rel="noopener noreferrer" aria-label={`Argon on X (${ARGON_X.handle})`}>
          X
        </a>
      </nav>
      <p data-testid="footer-text">{FOOTER_TEXT}</p>
    </footer>
  );
}
