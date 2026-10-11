/**
 * GET /api/assets/<launchId>/<name>: Forge's stored assets (worker AssetStore,
 * Postgres). Names carry the content hash, so responses are immutable. HTML (the
 * coin's one-page site) is served sandboxed: no scripts, opaque origin.
 */
import { getAsset } from '@/server/inputs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/html; charset=utf-8', 'text/html']);

export async function GET(_req: Request, ctx: { params: Promise<{ launchId: string; name: string }> }): Promise<Response> {
  const { launchId, name } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(launchId) || !/^[A-Za-z0-9._-]{1,160}$/.test(name)) return new Response('not found', { status: 404 });
  const a = await getAsset(launchId, name);
  if (!a || !ALLOWED.has(a.mime)) return new Response('not found', { status: 404 });
  const headers: Record<string, string> = {
    'content-type': a.mime,
    'cache-control': 'public, max-age=31536000, immutable',
    etag: `"${a.sha256}"`,
    'x-content-type-options': 'nosniff',
  };
  if (a.mime.startsWith('text/html')) {
    headers['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; font-src https: data:";
  }
  return new Response(new Uint8Array(a.bytes), { headers });
}
