import type { Metadata } from 'next';
import { ARGON_X } from '@/lib/social';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { LaunchLive } from '@/components/LaunchLive';
import { siteUrl } from '@/server/env';
import { getLaunchByCa } from '@/server/readmodel';

export const dynamic = 'force-dynamic';

/** Player card size (phone portrait card). */
const PLAYER = { width: 390, height: 640 };

const load = cache((ca: string) => getLaunchByCa(ca));

export async function generateMetadata({ params }: { params: Promise<{ ca: string }> }): Promise<Metadata> {
  const { ca } = await params;
  const found = await load(ca);
  if (!found) return { title: 'Unknown launch' };
  const s = found.summary;
  const site = siteUrl();
  const title = s.ticker ? `$${s.ticker}` : ca;
  const description = `${s.name ?? ''} · ${s.isotope} · ${s.shape.toUpperCase()} · stability ${s.score === null ? '--.--' : `${s.score}/${s.threshold}`} · CA ${ca}`;
  const image = { url: `${site}/og/${ca}`, width: 1200, height: 630, alt: `${title} on Argon` };
  return {
    title,
    description,
    metadataBase: new URL(site),
    openGraph: { title: `${title} // ARGON`, description, url: `${site}/l/${ca}`, images: [image], type: 'website' },
    twitter: {
      card: 'player',
      site: ARGON_X.handle,
      creator: ARGON_X.handle,
      title: `${title} // ARGON`,
      description,
      images: [image.url],
      players: [{ playerUrl: `${site}/embed/${ca}`, streamUrl: `${site}/embed/${ca}`, width: PLAYER.width, height: PLAYER.height }],
    },
  };
}

export default async function LaunchPage({ params }: { params: Promise<{ ca: string }> }) {
  const { ca } = await params;
  const found = await load(ca);
  if (!found) notFound();
  const lastSeq = found.events.length ? found.events[found.events.length - 1]!.seq : 0;
  return <LaunchLive launchId={found.summary.launchId} initial={found.events} lastSeq={lastSeq} renderedAt={Date.now()} />;
}
