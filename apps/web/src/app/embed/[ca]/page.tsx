import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EmbedLive } from '@/components/EmbedLive';
import { siteUrl } from '@/server/env';
import { getLaunchByCa } from '@/server/readmodel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false } };

/** /embed/[ca]: the twitter:player card. Unknown CA → 404. */
export default async function EmbedPage({ params }: { params: Promise<{ ca: string }> }) {
  const { ca } = await params;
  const found = await getLaunchByCa(ca);
  if (!found) notFound();
  const lastSeq = found.events.length ? found.events[found.events.length - 1]!.seq : 0;
  return <EmbedLive launch={found.summary} initial={found.events} lastSeq={lastSeq} site={siteUrl()} />;
}
