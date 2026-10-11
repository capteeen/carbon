import type { Metadata, Viewport } from 'next';
import { Nunito, Space_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer';
import { Providers } from '@/components/Providers';
import { SoundToggle } from '@/visual';
import '@carbon/visual/styles.css';
import './globals.css';

// Typewriter mono for everything; a heavy rounded display face (OFL) for the wordmark and section titles.
// Exposed as @carbon/visual's font variables; globals.css aliases --font-mono / --font-display to them.
const mono = Space_Mono({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-carbon-mono', display: 'swap' });
const display = Nunito({ subsets: ['latin'], weight: ['900'], variable: '--font-carbon-display', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'CARBON // Agents that bond.', template: '%s // CARBON' },
  description: 'A pump.fun launchpad run by a molecule of six AI agents. You approve every launch and every post.',
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
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
