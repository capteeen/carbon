/**
 * GET /api/x/connect?launch=<uuid>: start OAuth 2.0 PKCE for the launcher's own
 * X project account (@carbon/x startAuth). Only for a launch that does not exist
 * yet, so nobody can attach their account to someone else's running launch.
 */
import { AUTH_COOKIE_NAME } from '@carbon/x';
import { NextResponse } from 'next/server';
import { xConfigured } from '@/server/env';
import { UUID_RE } from '@/server/http';
import { launchCreated } from '@/server/readmodel';
import { getX } from '@/server/x';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const launchId = url.searchParams.get('launch') ?? '';
  const back = (status: string) => NextResponse.redirect(new URL(`/launch?launch=${encodeURIComponent(launchId)}&x=${status}`, url));
  if (!UUID_RE.test(launchId)) return new Response('launch must be a UUID', { status: 400 });
  if (!xConfigured()) return back('unavailable');
  if (await launchCreated(launchId)) return back('too-late');
  const { url: authorizeUrl, cookie } = (await getX()).startAuth(launchId);
  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(AUTH_COOKIE_NAME, cookie.value, {
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxAgeSec,
  });
  return res;
}
