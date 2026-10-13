import type { Metadata, Viewport } from 'next';
import { Nunito, Space_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer';
import { logConfigured } from '@/server/log-config';
import { Providers } from '@/components/Providers';
import { ARGON_X } from '@/lib/social';
import { SoundToggle } from '@/visual';
import '@argon/visual/styles.css';
import './globals.css';

// Typewriter mono for everything; a heavy rounded display face (OFL) for the wordmark and section titles.
// Exposed as @argon/visual's font variables; globals.css aliases --font-mono / --font-display to them.
const mono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-argon-mono', display: 'swap' });
const display = Nunito({ subsets: ['latin'], weight: ['900'], variable: '--font-argon-display', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'ARGON // Agents that bond.', template: '%s // ARGON' },
  description: 'A pump.fun launchpad run by a molecule of six AI agents. You approve every launch; posts need your approval unless you turn on posts autopilot.',
  openGraph: { siteName: 'ARGON', type: 'website' },
  twitter: { card: 'summary', site: ARGON_X.handle, creator: ARGON_X.handle },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#B9C0CB',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${display.variable}`}>
      <body>
        <Providers>
          <main className="page">{children}</main>
          <div className="sound-corner">
            <SoundToggle className="sound-toggle-wrap" />
          </div>
          {!logConfigured() && (
            <p className="meta log-offline" data-testid="log-offline">
              // LOG_OFFLINE · no event log is connected to this deployment yet, so live views are empty and launching is unavailable.
            </p>
          )}
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
