import { HomeLive } from '@/components/HomeLive';
import { latestReplay, listLiveLaunches, recentGlobalEvents } from '@/server/readmodel';

export const dynamic = 'force-dynamic';

/** / : the scroll story ending in the live graphene of every real launch. */
export default async function HomePage() {
  const [launches, replay, live] = await Promise.all([listLiveLaunches(), latestReplay(), recentGlobalEvents()]);
  return <HomeLive launches={launches} replay={replay} live={live} />;
}
