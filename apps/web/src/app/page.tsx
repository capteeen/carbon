import { HomeLive } from '@/components/HomeLive';
import { activeMolecule, latestReplay, listLiveLaunches, recentGlobalEvents } from '@/server/readmodel';

export const dynamic = 'force-dynamic';

/** / : the scroll story ending in the live graphene of every real launch. */
export default async function HomePage() {
  const [launches, replay, live] = await Promise.all([listLiveLaunches(), latestReplay(), recentGlobalEvents()]);
  // read after the window, so the molecule's full log covers every event up to live.lastSeq
  const molecule = await activeMolecule();
  return <HomeLive launches={launches} replay={replay} live={live} molecule={molecule} renderedAt={Date.now()} />;
}
