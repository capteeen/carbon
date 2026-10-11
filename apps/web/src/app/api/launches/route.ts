/** GET /api/launches: every deployed launch (the live graphene sheet). Empty log → []. */
import { handle, json } from '@/server/http';
import { listLiveLaunches } from '@/server/readmodel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return handle(async () => json({ launches: await listLiveLaunches() }));
}
