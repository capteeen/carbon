/** Small helpers for route handlers. Error bodies never include secrets or stack traces. */
import { verifyWalletSignature } from '@/lib/signing';
import type { CarbonEvent } from '@carbon/core/contracts';
import { launchCreated } from './readmodel';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'request too large');
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function str(body: Record<string, unknown>, key: string, max = 512): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new HttpError(400, `${key} is required`);
  return v;
}

export function int(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new HttpError(400, `${key} must be an integer`);
  return v;
}

export function bool(body: Record<string, unknown>, key: string): boolean {
  const v = body[key];
  if (typeof v !== 'boolean') throw new HttpError(400, `${key} must be a boolean`);
  return v;
}

/**
 * Proves the request comes from the launch's launcher wallet: the signature must
 * verify over `message` against launch.created.payload.launcherWallet.
 */
export async function requireLauncher(launchId: string, message: string, signature: string): Promise<CarbonEvent<'launch.created'>> {
  const created = await launchCreated(launchId);
  if (!created) throw new HttpError(404, 'unknown launch');
  if (!verifyWalletSignature(created.payload.launcherWallet, message, signature)) {
    throw new HttpError(401, 'signature does not verify against the launcher wallet');
  }
  return created;
}

export function handle(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((err: unknown) => {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    const name = err instanceof Error ? err.name : 'Error';
    if (name === 'ApprovalError') return json({ error: (err as Error).message }, 409);
    // Unknown failures: no details leak to the client.
    console.error('[carbon/web] request failed:', name);
    return json({ error: 'internal error' }, 500);
  });
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const EVENT_ID_RE = /^[0-9a-f]{64}$/;
