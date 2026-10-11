/** GET /api/health: names and states of the deployment's required settings. No values. */
import { checkHealth } from '@/server/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const h = await checkHealth();
  return Response.json(h, { status: h.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
