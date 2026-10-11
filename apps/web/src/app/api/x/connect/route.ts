/**
 * POST /api/x/connect { launchId, wallet, issuedAt, signature } → { authorizeUrl }
 *
 * Starts OAuth 2.0 PKCE for the launcher's own X project account (@carbon/x
 * startAuth), bound to the wallet that signed messages.xConnect (AG-004):
 * - The wallet signature is required and single-use. The wallet is sealed into the
 *   encrypted flow cookie and stored with the tokens (x_tokens.wallet).
 * - POST + application/json + same-origin only, so another site cannot start a flow
 *   in a visitor's browser bound to the attacker's wallet (no GET link).
 * - Only for a launch id that does not exist yet. POST /api/launch keeps the
 *   connection only if the launcher wallet is the wallet bound here; the worker's X
 *   client ignores tokens bound to any other wallet.
 */
import { AUTH_COOKIE_NAME } from '@carbon/x';
import { NextResponse } from 'next/server';
import { isFresh, isWalletAddress, messages, verifyWalletSignature } from '@/lib/signing';
import { xConfigured } from '@/server/env';
import { HttpError, UUID_RE, handle, int, readJson, str } from '@/server/http';
import { consumeSignedNonce } from '@/server/nonces';
import { launchCreated } from '@/server/readmodel';
import { getX } from '@/server/x';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Refuses cross-site requests: JSON content type (a form cannot send it) and, when the browser says, same origin. */
function assertSameOrigin(req: Request): void {
  const ct = req.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'content-type must be application/json');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'cross-site request refused');
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'cross-origin request refused');
}

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const body = await readJson(req);
    const launchId = str(body, 'launchId', 64);
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'launchId must be a UUID');
    const wallet = str(body, 'wallet', 64);
    if (!isWalletAddress(wallet)) throw new HttpError(400, 'wallet is not a Solana address');
    const issuedAt = int(body, 'issuedAt');
    if (!isFresh(issuedAt)) throw new HttpError(401, 'signature expired; sign again');
    const signature = str(body, 'signature', 128);
    const text = messages.xConnect({ launchId, wallet, issuedAt });
    if (!verifyWalletSignature(wallet, text, signature)) throw new HttpError(401, 'signature does not verify against the wallet');
    if (!xConfigured()) throw new HttpError(503, 'X is not configured on this deployment');
    if (await launchCreated(launchId)) throw new HttpError(409, 'X can only be connected before the launch is created');
    await consumeSignedNonce('x_connect', launchId, wallet, text);

    const { url: authorizeUrl, cookie } = (await getX()).startAuth(launchId, wallet);
    const res = NextResponse.json({ authorizeUrl }, { status: 200, headers: { 'cache-control': 'no-store' } });
    res.cookies.set(AUTH_COOKIE_NAME, cookie.value, {
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      path: cookie.path,
      maxAge: cookie.maxAgeSec,
    });
    return res;
  });
}
