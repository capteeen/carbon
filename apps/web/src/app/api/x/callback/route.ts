/**
 * GET /api/x/callback: finish OAuth (@carbon/x finishAuth: state check in constant
 * time, PKCE exchange, tokens stored encrypted and bound to the wallet that signed
 * the connect request). The flow cookie is always cleared, success or not. Tokens
 * never reach the browser.
 *
 * If the launch was created in the meantime by a different wallet, the new
 * connection is discarded at once (AG-004); the worker would ignore it anyway.
 */
import { AUTH_COOKIE_NAME } from '@carbon/x';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { launchCreated } from '@/server/readmodel';
import { getX } from '@/server/x';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const jar = await cookies();
  const cookie = jar.get(AUTH_COOKIE_NAME)?.value;
  let target: URL;
  try {
    const x = await getX();
    const conn = await x.finishAuth(url.searchParams, cookie);
    const created = await launchCreated(conn.launchId);
    if (created && !(conn.wallet && (await x.claimConnection(conn.launchId, created.payload.launcherWallet)))) {
      target = new URL(`/launch?x=failed&reason=WalletMismatch`, url);
    } else {
      target = new URL(`/launch?launch=${encodeURIComponent(conn.launchId)}&x=connected&handle=${encodeURIComponent(conn.xHandle)}`, url);
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    target = new URL(`/launch?x=failed&reason=${encodeURIComponent(name)}`, url);
  }
  const res = NextResponse.redirect(target);
  res.cookies.set(AUTH_COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
