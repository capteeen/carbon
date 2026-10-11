/**
 * SPEC §3/§7: "Post or launch without approval: impossible."
 * Real web route handlers (apps/web/src/app/api/**) on a real core (Postgres + Redis),
 * the X client as the worker wires it, and core approvals. Attacks: forged
 * approval signatures, signatures replayed for another approval, a non-launcher
 * wallet, autopilot for launches, autopilot on DIAMOND, after the kill switch,
 * approval reuse, and X account fixation.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchConfig, type AgentId, type Core } from '@carbon/core';
import { ApprovalRequiredError, AUTH_COOKIE_NAME, createXClient, PgTokenStore, TokenCipher, XConnectionTakenError } from '@carbon/x';
import { consumedApprovalCheck } from '../../apps/worker/src/x.js';
import { makeEnv, wallet, type Env } from './support/env.js';

let env: Env;
const X_ENV = {
  X_CLIENT_ID: 'agent-g-client',
  X_REDIRECT_URI: 'https://carbon.invalid/api/x/callback',
  CARBON_TOKEN_KEY: randomBytes(32).toString('hex'),
};

// Web modules are imported after the env points at this test's schema.
let web: {
  createLaunch: (req: Request) => Promise<Response>;
  approve: (req: Request, ctx: { params: Promise<{ approvalId: string }> }) => Promise<Response>;
  autopilot: (req: Request) => Promise<Response>;
  kill: (req: Request) => Promise<Response>;
  xConnect: (req: Request) => Promise<Response>;
  messages: typeof import('../../apps/web/src/lib/signing.js').messages;
  getX: typeof import('../../apps/web/src/server/x.js').getX;
};
let webCore: Core;

const post = (url: string, body: unknown) => new Request(`http://carbon.test${url}`, { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
  env = await makeEnv();
  Object.assign(process.env, { DATABASE_URL: env.dbUrl, REDIS_URL: 'redis://localhost:6379', CARBON_AGENT_KEY_SEED: env.seed }, X_ENV);
  web = {
    createLaunch: (await import('@/app/api/launch/route')).POST,
    approve: (await import('@/app/api/approvals/[approvalId]/route')).POST,
    autopilot: (await import('@/app/api/autopilot/route')).POST,
    kill: (await import('@/app/api/killswitch/route')).POST,
    xConnect: (await import('@/app/api/x/connect/route')).POST,
    messages: (await import('@/lib/signing')).messages,
    getX: (await import('@/server/x')).getX,
  };
  webCore = await (await import('@/server/core')).getCore();
});
afterAll(async () => {
  await webCore?.close();
  await env.cleanup();
});

async function launchViaWeb(w = wallet(), shape: 'chain' | 'ring' | 'diamond' = 'ring', launchId = randomUUID(), isotope: 'C-12' | 'C-13' = 'C-12', heavyAgent: AgentId | null = null) {
  const issuedAt = Date.now();
  const line = 'frozen lattice coin';
  const signature = w.sign(web.messages.createLaunch({ launchId, line, isotope, shape, heavyAgent, issuedAt }));
  const res = await web.createLaunch(post('/api/launch', { launchId, line, isotope, shape, heavyAgent, wallet: w.address, issuedAt, signature }));
  return { res, launchId, w };
}

describe('launch creation is signed by the launcher wallet', () => {
  it('a valid signature creates the launch; the same signature for a different isotope/shape/wallet is refused', async () => {
    const { res, launchId, w } = await launchViaWeb();
    expect(res.status).toBe(201);
    const issuedAt = Date.now();
    const sig = w.sign(web.messages.createLaunch({ launchId: randomUUID(), line: 'x', isotope: 'C-12', shape: 'ring', heavyAgent: null, issuedAt }));
    const other = wallet();
    const r2 = await web.createLaunch(post('/api/launch', { launchId: randomUUID(), line: 'x', isotope: 'C-12', shape: 'diamond', heavyAgent: null, wallet: w.address, issuedAt, signature: sig }));
    expect(r2.status).toBe(401);
    const r3 = await web.createLaunch(post('/api/launch', { launchId: randomUUID(), line: 'x', isotope: 'C-12', shape: 'ring', heavyAgent: null, wallet: other.address, issuedAt, signature: sig }));
    expect(r3.status).toBe(401);
    // An existing launch id cannot be taken over.
    const again = await launchViaWeb(wallet(), 'ring', launchId);
    expect(again.res.status).toBe(409);
  });
});

describe('approval decisions', () => {
  async function card() {
    const { launchId, w } = await launchViaWeb();
    const { approvalId } = await webCore.approvals.open(launchId, 'post', { text: 'hello' }, 'herald');
    const call = (body: unknown, id = approvalId) => web.approve(post(`/api/approvals/${id}`, body), { params: Promise.resolve({ approvalId: id }) });
    const status = async (id = approvalId) => (await webCore.bus.pool.query('SELECT status FROM approvals WHERE id=$1', [id])).rows[0]?.status;
    return { launchId, w, approvalId, call, status };
  }

  it('forged: a non-launcher wallet’s valid signature is refused and nothing is decided', async () => {
    const { approvalId, call, status } = await card();
    const r = await call({ decision: 'grant', signature: wallet().sign(web.messages.approval({ approvalId, decision: 'grant' })) });
    expect(r.status).toBe(401);
    expect(await status()).toBe('pending');
  });

  it('forged: random bytes as a signature, and the launcher signing a different text, are refused', async () => {
    const { approvalId, w, call, status } = await card();
    expect((await call({ decision: 'grant', signature: 'x'.repeat(88) })).status).toBe(401);
    expect((await call({ decision: 'grant', signature: w.sign(`CARBON // APPROVAL\napproval: ${approvalId}\ndecision: grant `) })).status).toBe(401);
    expect(await status()).toBe('pending');
  });

  it('replay: a launcher signature for approval A cannot decide approval B (same launch or another launch)', async () => {
    const a = await card();
    const { approvalId: b } = await webCore.approvals.open(a.launchId, 'post', { text: 'other' }, 'herald');
    const sigA = a.w.sign(web.messages.approval({ approvalId: a.approvalId, decision: 'grant' }));
    expect((await a.call({ decision: 'grant', signature: sigA }, b)).status).toBe(401);
    const c = await card();
    expect((await c.call({ decision: 'grant', signature: sigA })).status).toBe(401);
    expect(await a.status(b)).toBe('pending');
  });

  it('replay: the same signed grant twice is refused the second time (one decision per card)', async () => {
    const { approvalId, w, call } = await card();
    const signature = w.sign(web.messages.approval({ approvalId, decision: 'grant' }));
    expect((await call({ decision: 'grant', signature })).status).toBe(200);
    expect((await call({ decision: 'grant', signature })).status).toBe(409);
  });

  it('a consumed approval cannot be consumed again, nor for another action or launch', async () => {
    const { launchId, approvalId, w, call } = await card();
    await call({ decision: 'grant', signature: w.sign(web.messages.approval({ approvalId, decision: 'grant' })) });
    await expect(webCore.approvals.consume(launchId, approvalId, 'reply')).rejects.toThrow(/for 'post'/);
    await expect(webCore.approvals.consume('other-launch', approvalId, 'post')).rejects.toThrow(/different launch/);
    await webCore.approvals.consume(launchId, approvalId, 'post');
    await expect(webCore.approvals.consume(launchId, approvalId, 'post')).rejects.toThrow(/already used/);
  });
});

describe('autopilot and kill switch', () => {
  const ap = (launchId: string, w: ReturnType<typeof wallet>, actionClass: string, enabled: boolean, issuedAt = Date.now()) =>
    web.autopilot(post('/api/autopilot', { launchId, actionClass, enabled, issuedAt, signature: w.sign(web.messages.autopilot({ launchId, actionClass, enabled, issuedAt })) }));
  const kill = (launchId: string, w: ReturnType<typeof wallet>, issuedAt = Date.now()) =>
    web.kill(post('/api/killswitch', { launchId, issuedAt, signature: w.sign(web.messages.killSwitch({ launchId, issuedAt })) }));

  it('autopilot is never available for launches (route + core)', async () => {
    const { launchId, w } = await launchViaWeb();
    expect((await ap(launchId, w, 'launch', true)).status).toBe(400);
    for (const c of ['posts', 'replies', 'buybacks']) expect((await ap(launchId, w, c, true)).status).toBe(200);
    const { autoGranted } = await webCore.approvals.open(launchId, 'launch', {}, 'treasurer');
    expect(autoGranted).toBe(false);
  });

  it('autopilot is unavailable on DIAMOND, even if the row is forced into the table', async () => {
    const { launchId, w } = await launchViaWeb(wallet(), 'diamond');
    expect((await ap(launchId, w, 'posts', true)).status).toBe(409);
    await webCore.bus.pool.query("INSERT INTO autopilot (launch_id, class, enabled, changed_by, changed_at) VALUES ($1,'posts',TRUE,'forced',0)", [launchId]);
    const { autoGranted } = await webCore.approvals.open(launchId, 'post', { text: 'x' }, 'herald');
    expect(autoGranted).toBe(false);
  });

  it('a non-launcher cannot switch autopilot on or engage the kill switch', async () => {
    const { launchId } = await launchViaWeb();
    const stranger = wallet();
    expect((await ap(launchId, stranger, 'posts', true)).status).toBe(401);
    expect((await kill(launchId, stranger)).status).toBe(401);
  });

  it('after the kill switch: autopilot cannot be re-enabled and an unconsumed autopilot grant is revoked', async () => {
    const { launchId, w } = await launchViaWeb();
    expect((await ap(launchId, w, 'posts', true)).status).toBe(200);
    const pre = await webCore.approvals.open(launchId, 'post', { text: 'auto' }, 'herald');
    expect(pre.autoGranted).toBe(true);
    expect((await kill(launchId, w)).status).toBe(200);
    await expect(webCore.approvals.consume(launchId, pre.approvalId, 'post')).rejects.toThrow(/kill switch/);
    expect((await ap(launchId, w, 'posts', true)).status).toBe(409);
    const after = await webCore.approvals.open(launchId, 'post', { text: 'after' }, 'herald');
    expect(after.autoGranted).toBe(false);
  });

  // AUTOPILOT/KILL_SWITCH messages carry only an issuedAt (5-minute window), no nonce and no
  // record of used signatures, so a captured "enable" request can be replayed after the
  // launcher switched autopilot off again.
  it('[AG-016] a captured "enable autopilot" signature cannot be replayed after the launcher turned it off', async () => {
    const { launchId, w } = await launchViaWeb();
    const t0 = Date.now();
    const enable = { launchId, actionClass: 'posts', enabled: true, issuedAt: t0, signature: w.sign(web.messages.autopilot({ launchId, actionClass: 'posts', enabled: true, issuedAt: t0 })) };
    expect((await web.autopilot(post('/api/autopilot', enable))).status).toBe(200);
    expect((await ap(launchId, w, 'posts', false)).status).toBe(200);
    expect((await web.autopilot(post('/api/autopilot', enable))).status).not.toBe(200);
  });
});

describe('X posting needs a consumed approval for exactly that launch and action', () => {
  const sent: string[] = [];
  const xFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/2/tweets') && init?.method === 'POST') {
      sent.push(String(init.body));
      const id = String(1_900_000_000_000_000_000n + BigInt(sent.length));
      return new Response(JSON.stringify({ data: { id, text: JSON.parse(String(init.body)).text } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  async function connected(): Promise<{ launchId: string; w: ReturnType<typeof wallet> }> {
    const { launchId, w } = await launchViaWeb();
    await new PgTokenStore(webCore.bus.pool, TokenCipher.fromEnv(X_ENV)).put({
      launchId,
      xUserId: '42',
      xHandle: 'launcher_project',
      accessToken: 'test-access-token-not-a-secret',
      refreshToken: null,
      accessExpiresAt: new Date(Date.now() + 3600_000),
      scopes: ['tweet.read', 'tweet.write', 'users.read'],
      wallet: w.address, // connections are bound to the launcher wallet that started OAuth (AG-004)
    });
    return { launchId, w };
  }
  /** The X client exactly as apps/worker/src/x.ts builds it, with a test-double fetch. */
  const workerX = () => createXClient({ db: webCore.bus.pool, assertApproval: consumedApprovalCheck(webCore.bus.pool), env: X_ENV, fetch: xFetch });

  async function approved(launchId: string, w: ReturnType<typeof wallet>, action: 'post' | 'reply', consume = true, text = 'x') {
    const { approvalId } = await webCore.approvals.open(launchId, action, { text }, 'herald');
    await webCore.approvals.decide(approvalId, true, w.address);
    if (consume) await webCore.approvals.consume(launchId, approvalId, action);
    return approvalId;
  }

  it('the web app’s X client cannot post at all (no approval hook)', async () => {
    const { launchId, w } = await connected();
    const id = await approved(launchId, w, 'post');
    await expect((await web.getX()).post(launchId, 'from the web app', id)).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('worker X client: no approval, unknown id, granted-but-not-consumed, other launch, other action → refused, nothing sent', async () => {
    const { launchId, w } = await connected();
    const other = await connected();
    const x = workerX();
    const before = sent.length;
    await expect(x.post(launchId, 'a', '')).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(x.post(launchId, 'b', randomUUID())).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(x.post(launchId, 'c', await approved(launchId, w, 'post', false))).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(x.post(launchId, 'd', await approved(other.launchId, other.w, 'post'))).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(x.post(launchId, 'e', await approved(launchId, w, 'reply'))).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(sent.length).toBe(before);
    await expect(x.post(launchId, 'approved text', await approved(launchId, w, 'post', true, 'approved text'))).resolves.toMatchObject({ id: expect.any(String) });
    expect(sent.length).toBe(before + 1);
  });

  // The worker wires assertApproval = consumedApprovalCheck, which accepts any approval whose
  // status is 'consumed' and never marks it used by X. One approved post therefore unlocks
  // unlimited further posts (any text) from the user's account through this client.
  it('[AG-003] one consumed post approval authorises exactly one X post (no reuse with other text)', async () => {
    const { launchId, w } = await connected();
    const x = workerX();
    const id = await approved(launchId, w, 'post', true, 'the approved text');
    await x.post(launchId, 'the approved text', id);
    await expect(x.post(launchId, 'text the user never saw', id)).rejects.toBeInstanceOf(ApprovalRequiredError);
  });
});

/** POST /api/x/connect as the launch page sends it: JSON, same origin, signed by `w`. */
function signedXConnect(launchId: string, w: ReturnType<typeof wallet>, issuedAt = Date.now(), headers: Record<string, string> = {}) {
  const signature = w.sign(web.messages.xConnect({ launchId, wallet: w.address, issuedAt }));
  return web.xConnect(
    new Request('http://carbon.test/api/x/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://carbon.test', 'sec-fetch-site': 'same-origin', ...headers },
      body: JSON.stringify({ launchId, wallet: w.address, issuedAt, signature }),
    }),
  );
}

describe('X account binding', () => {
  // GET /api/x/connect?launch=<id> works for ANY not-yet-created launch id without a wallet
  // signature, and POST /api/launch then accepts that id from ANY wallet. An attacker who
  // gets a victim to connect X under an attacker-chosen id (a link to Carbon's own
  // /api/x/connect?launch=…) can create the launch first and own the victim's X account
  // for posting (the attacker approves the posts).
  // Fix round: connect is now a signed, same-origin POST (no GET link), so the only flow a
  // victim's browser can run is one signed by the victim's own wallet; the test drives that.
  it('[AG-004] a launch created by wallet B does not inherit an X account connected by someone else for that launch id', async () => {
    const launchId = randomUUID(); // chosen by the attacker, sent to the victim as a link
    const res = await signedXConnect(launchId, wallet()); // the victim signs with the victim's wallet
    expect(res.status).toBe(200);
    const authorize = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
    const cookie = /carbon_x_oauth=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? (res.headers.get('set-cookie') ?? '').split(';')[0]!.split('=').slice(1).join('=');
    expect(AUTH_COOKIE_NAME).toBeTruthy();
    // The victim authorises on x.com; X redirects back with code+state. The callback route
    // calls finishAuth with the flow cookie; same key/config here, with a test-double X API.
    const xApi = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/2/oauth2/token')) return new Response(JSON.stringify({ access_token: 'victim-access', refresh_token: 'victim-refresh', expires_in: 7200, token_type: 'bearer', scope: 'tweet.read tweet.write users.read offline.access' }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('/2/users/me')) return new Response(JSON.stringify({ data: { id: '777', username: 'victim_project' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const conn = await createXClient({ db: webCore.bus.pool, env: X_ENV, fetch: xApi }).finishAuth(new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'victim-code' }), decodeURIComponent(cookie));
    expect(conn.launchId).toBe(launchId);
    // The attacker creates the launch first, with the attacker's wallet.
    const attacker = wallet();
    const { res: created } = await launchViaWeb(attacker, 'ring', launchId);
    const ev = (await webCore.bus.list(launchId, { kinds: ['launch.created'] }))[0];
    expect(created.status === 201 && (ev?.payload as { xConnected: boolean }).xConnected === true).toBe(false);
  });

  const xApiFor = (id: string, username: string) =>
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/2/oauth2/token')) return new Response(JSON.stringify({ access_token: `${username}-access`, refresh_token: `${username}-refresh`, expires_in: 7200, token_type: 'bearer', scope: 'tweet.read tweet.write users.read offline.access' }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('/2/users/me')) return new Response(JSON.stringify({ data: { id, username } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

  async function finish(res: Response, xApi: typeof fetch) {
    const authorize = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
    const cookie = /carbon_x_oauth=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
    return createXClient({ db: webCore.bus.pool, env: X_ENV, fetch: xApi }).finishAuth(new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'c' }), decodeURIComponent(cookie));
  }

  it('[AG-004] connect needs a fresh wallet signature, JSON, same origin, and is single-use', async () => {
    const w = wallet();
    const launchId = randomUUID();
    expect((await web.xConnect(new Request(`http://carbon.test/api/x/connect?launch=${launchId}`))).status).not.toBe(200);
    expect((await signedXConnect(launchId, w, Date.now(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await signedXConnect(launchId, w, Date.now(), { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await signedXConnect(launchId, w, Date.now() - 10 * 60_000)).status).toBe(401);
    const other = wallet();
    const forged = other.sign(web.messages.xConnect({ launchId, wallet: w.address, issuedAt: Date.now() }));
    const r = await web.xConnect(
      new Request('http://carbon.test/api/x/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ launchId, wallet: w.address, issuedAt: Date.now(), signature: forged }) }),
    );
    expect(r.status).toBe(401);
    const t = Date.now();
    expect((await signedXConnect(launchId, w, t)).status).toBe(200);
    expect((await signedXConnect(launchId, w, t)).status).toBe(409); // replay of the same signed request
    const { launchId: existing, w: lw } = await launchViaWeb();
    expect((await signedXConnect(existing, lw)).status).toBe(409); // never for a launch that exists
  });

  it('[AG-004] the launcher who signed connect keeps the X account; the worker uses it only for that launcher', async () => {
    const w = wallet();
    const launchId = randomUUID();
    const conn = await finish(await signedXConnect(launchId, w), xApiFor('888', 'launcher_project'));
    expect(conn.wallet).toBe(w.address);
    const { res } = await launchViaWeb(w, 'ring', launchId);
    expect(res.status).toBe(201);
    const ev = (await webCore.bus.list(launchId, { kinds: ['launch.created'] }))[0]!;
    expect((ev.payload as { xConnected: boolean }).xConnected).toBe(true);
    const workerX = createXClient({ db: webCore.bus.pool, assertApproval: consumedApprovalCheck(webCore.bus.pool), env: X_ENV });
    expect(await workerX.isConnected(launchId)).toBe(true);
  });

  it('[AG-004] a victim connection that lands AFTER the attacker created the launch is never used', async () => {
    const victim = wallet();
    const launchId = randomUUID();
    const started = await signedXConnect(launchId, victim);
    const { res } = await launchViaWeb(wallet(), 'ring', launchId); // attacker wins the race
    expect(res.status).toBe(201);
    await finish(started, xApiFor('999', 'victim_late'));
    const workerX = createXClient({ db: webCore.bus.pool, assertApproval: consumedApprovalCheck(webCore.bus.pool), env: X_ENV });
    expect(await workerX.isConnected(launchId)).toBe(false);
    await expect(workerX.post(launchId, 'from the victim account', randomUUID())).rejects.toThrow();
  });

  // AG-036: x_tokens is keyed by launch id and finishAuth upserted, so anyone who learned a
  // not-yet-created launch id could finish their own flow for it and overwrite the launcher's
  // pending connection (which creation then discarded as bound to another wallet).
  it('[AG-036] a pending X connection cannot be overwritten (or cleared) by a flow another wallet started', async () => {
    const launcher = wallet();
    const launchId = randomUUID();
    const mine = await finish(await signedXConnect(launchId, launcher), xApiFor('1001', 'launcher_acct'));
    expect(mine.wallet).toBe(launcher.address);
    // Someone learns the id and completes their own signed flow for it.
    const other = wallet();
    await expect(finish(await signedXConnect(launchId, other), xApiFor('2002', 'other_acct'))).rejects.toThrow(XConnectionTakenError);
    const store = new PgTokenStore(webCore.bus.pool, TokenCipher.fromEnv(X_ENV));
    expect(await store.get(launchId)).toMatchObject({ xHandle: 'launcher_acct', wallet: launcher.address, accessToken: 'launcher_acct-access' });
    // The wallet that started it may replace it (reconnect with another account).
    expect((await finish(await signedXConnect(launchId, launcher), xApiFor('1003', 'launcher_acct2'))).xHandle).toBe('launcher_acct2');
    const { res } = await launchViaWeb(launcher, 'ring', launchId);
    expect(res.status).toBe(201);
    const ev = (await webCore.bus.list(launchId, { kinds: ['launch.created'] }))[0]!;
    expect((ev.payload as { xConnected: boolean }).xConnected).toBe(true);
  });
});

describe('approval.consumed and launch id uniqueness', () => {
  it('[AG-023] consuming an approval appends approval.consumed to the public log', async () => {
    const { launchId, w } = await launchViaWeb();
    const { approvalId } = await webCore.approvals.open(launchId, 'post', { text: 'gm' }, 'herald');
    await webCore.approvals.decide(approvalId, true, w.address);
    expect(await webCore.bus.list(launchId, { kinds: ['approval.consumed'] })).toEqual([]);
    await webCore.approvals.consume(launchId, approvalId, 'post');
    await expect(webCore.approvals.consume(launchId, approvalId, 'post')).rejects.toThrow(/already used/);
    const evs = await webCore.bus.list(launchId, { kinds: ['approval.consumed'] });
    expect(evs.map((e) => e.payload)).toEqual([{ approvalId, action: 'post' }]);
  });

  it('[AG-024] concurrent POST /api/launch with the same id: exactly one is created', async () => {
    const launchId = randomUUID();
    const rs = await Promise.all(Array.from({ length: 6 }, () => launchViaWeb(wallet(), 'ring', launchId)));
    expect(rs.filter((r) => r.res.status === 201)).toHaveLength(1);
    expect(rs.every((r) => r.res.status === 201 || r.res.status === 409)).toBe(true);
    expect(await webCore.bus.list(launchId, { kinds: ['launch.created'] })).toHaveLength(1);
  });
});

it('sanity: config row for the launches above', () => {
  expect(launchConfig('C-12', 'ring').gateEveryAction).toBe(false);
});
