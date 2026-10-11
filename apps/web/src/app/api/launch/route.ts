/**
 * POST /api/launch: create a launch (appends launch.created; the worker picks it up).
 * The launcher wallet signs messages.createLaunch(...) so nobody can launch in
 * someone else's name. The launchId is chosen by the browser before X connect
 * (X tokens are stored per launchId), and must be unused.
 */
import { AGENT_IDS, ISOTOPES, ISOTOPE_IDS, SHAPE_IDS, launchConfig, type AgentId, type IsotopeId, type ShapeId } from '@carbon/core/contracts';
import { isFresh, isWalletAddress, messages, verifyWalletSignature } from '@/lib/signing';
import { getCore } from '@/server/core';
import { HttpError, UUID_RE, handle, int, json, readJson, str } from '@/server/http';
import { launchCreated } from '@/server/readmodel';
import { xConnectedFor } from '@/server/x';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LINE = 280;

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJson(req);
    const launchId = str(body, 'launchId', 64);
    if (!UUID_RE.test(launchId)) throw new HttpError(400, 'launchId must be a UUID');
    const line = str(body, 'line', MAX_LINE).trim();
    if (!line) throw new HttpError(400, 'line is required');
    const isotope = str(body, 'isotope', 8) as IsotopeId;
    const shape = str(body, 'shape', 16) as ShapeId;
    if (!ISOTOPE_IDS.includes(isotope)) throw new HttpError(400, 'unknown isotope');
    if (!SHAPE_IDS.includes(shape)) throw new HttpError(400, 'unknown shape');
    const heavyRaw = body.heavyAgent ?? null;
    const heavyAgent = heavyRaw === null ? null : (String(heavyRaw) as AgentId);
    if (heavyAgent !== null && !AGENT_IDS.includes(heavyAgent)) throw new HttpError(400, 'unknown agent');
    if (ISOTOPES[isotope].heavyAgent !== (heavyAgent !== null)) {
      throw new HttpError(400, ISOTOPES[isotope].heavyAgent ? `${isotope} needs a heavy agent` : `${isotope} has no extra neutron`);
    }
    launchConfig(isotope, shape, heavyAgent); // the ONE config table must accept the row
    const wallet = str(body, 'wallet', 64);
    if (!isWalletAddress(wallet)) throw new HttpError(400, 'wallet is not a Solana address');
    const issuedAt = int(body, 'issuedAt');
    if (!isFresh(issuedAt)) throw new HttpError(401, 'signature expired; sign again');
    const signature = str(body, 'signature', 128);
    const text = messages.createLaunch({ launchId, line, isotope, shape, heavyAgent, issuedAt });
    if (!verifyWalletSignature(wallet, text, signature)) throw new HttpError(401, 'signature does not verify against the wallet');

    if (await launchCreated(launchId)) throw new HttpError(409, 'launch already exists');
    const xConnected = await xConnectedFor(launchId);
    const { bus } = await getCore();
    const e = await bus.append({
      launchId,
      kind: 'launch.created',
      actor: 'user',
      payload: { line, isotope, shape, heavyAgent, launcherWallet: wallet, xConnected },
    });
    return json({ launchId, eventId: e.id, seq: e.seq }, 201);
  });
}
