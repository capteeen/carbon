import { FOOTER_TEXT } from '@carbon/core/contracts';
import Link from 'next/link';

/** On every page (rendered by the root layout). The text is FOOTER_TEXT, verbatim. */
export function Footer() {
  return (
    <footer className="site-footer">
      <nav className="footer-nav" aria-label="Carbon">
        <Link href="/">CARBON</Link>
        <Link href="/launch">LAUNCH</Link>
        <Link href="/receipts">RECEIPTS</Link>
        <Link href="/wallets">WALLETS</Link>
        <Link href="/how">HOW</Link>
      </nav>
      <p data-testid="footer-text">{FOOTER_TEXT}</p>
    </footer>
  );
}
