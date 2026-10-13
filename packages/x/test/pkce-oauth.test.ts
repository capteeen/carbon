import { describe, expect, it } from 'vitest';
import { codeChallengeS256, createCodeVerifier, createState } from '../src/pkce.js';
import { XAuthError, XNotConnectedError } from '../src/errors.js';
import { connectedTokens, FIXTURE_WALLET, json, makeClient, MemoryTokenStore, testConfig } from './helpers.js';
import { invalidGrant, refreshedTokenResponse, tokenResponse, usersMe } from './fixtures/fixtures.js';

describe('PKCE (RFC 7636)', () => {
  it('matches the RFC 7636 Appendix B S256 test vector', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('generates 43-char unreserved verifiers and unique states', () => {
    const v = createCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43}$/);
    expect(createCodeVerifier()).not.toBe(v);
    expect(createState()).not.toBe(createState());
  });
  it('rejects verifiers outside 43..128 unreserved chars', () => {
    expect(() => codeChallengeS256('short')).toThrow();
    expect(() => codeChallengeS256('a'.repeat(129))).toThrow();
    expect(() => codeChallengeS256('a'.repeat(42) + '!')).toThrow();
  });
});

function startedFlow() {
  const ctx = makeClient({
    responders: [() => json(tokenResponse), () => json(usersMe)],
  });
  const start = ctx.client.startAuth('launch-1', FIXTURE_WALLET);
  const url = new URL(start.url);
  return { ...ctx, start, url, state: url.searchParams.get('state')! };
}

describe('startAuth', () => {
  it('builds the x.com authorize URL with S256, state and only the needed scopes', () => {
    const { url, start } = startedFlow();
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('fixture-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://argon.example/api/x/callback');
    expect(url.searchParams.get('scope')).toBe('tweet.read tweet.write users.read offline.access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.cookie.httpOnly).toBe(true);
    expect(start.cookie.secure).toBe(true);
    expect(start.cookie.sameSite).toBe('lax');
    // The verifier is sealed: the state is not visible in the cookie.
    expect(start.cookie.value).not.toContain(url.searchParams.get('state')!);
  });
});

describe('finishAuth', () => {
  it('exchanges the code with the matching verifier, resolves the account, stores tokens', async () => {
    const { client, calls, start, url, state, tokens } = startedFlow();
    const conn = await client.finishAuth(new URLSearchParams({ code: 'fixture-code', state }), start.cookie.value);
    expect(conn).toEqual({ launchId: 'launch-1', xUserId: usersMe.data.id, xHandle: 'fixture_project', scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'], wallet: FIXTURE_WALLET });
    expect(JSON.stringify(conn)).not.toContain('FIXTURE-ACCESS');

    const tokenCall = calls[0]!;
    expect(tokenCall.url).toBe('https://api.x.com/2/oauth2/token');
    expect(tokenCall.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(tokenCall.headers.authorization).toBe(`Basic ${Buffer.from('fixture-client-id:fixture-client-secret').toString('base64')}`);
    const body = new URLSearchParams(tokenCall.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('fixture-code');
    expect(body.get('client_id')).toBeNull(); // confidential client authenticates via Basic
    expect(codeChallengeS256(body.get('code_verifier')!)).toBe(url.searchParams.get('code_challenge'));

    expect(calls[1]!.url).toBe('https://api.x.com/2/users/me');
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${tokenResponse.access_token}`);
    const stored = await tokens.get('launch-1');
    expect(stored?.accessToken).toBe(tokenResponse.access_token);
    expect(stored?.refreshToken).toBe(tokenResponse.refresh_token);
  });

  it('public client (no secret) sends client_id in the body', async () => {
    const { clientSecret: _omit, ...publicConfig } = testConfig();
    const ctx = makeClient({ responders: [() => json(tokenResponse), () => json(usersMe)], config: publicConfig });
    const s = ctx.client.startAuth('launch-2', FIXTURE_WALLET);
    const st = new URL(s.url).searchParams.get('state')!;
    await ctx.client.finishAuth({ code: 'c', state: st }, s.cookie.value);
    expect(ctx.calls[0]!.headers.authorization).toBeUndefined();
    expect(new URLSearchParams(ctx.calls[0]!.body).get('client_id')).toBe('fixture-client-id');
  });

  it('rejects a state mismatch without any network call', async () => {
    const { client, calls, start } = startedFlow();
    await expect(client.finishAuth({ code: 'fixture-code', state: 'attacker-state' }, start.cookie.value)).rejects.toThrow(XAuthError);
    await expect(client.finishAuth({ code: 'fixture-code' }, start.cookie.value)).rejects.toThrow(/state/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing, tampered or foreign cookie', async () => {
    const { client, start, state, calls } = startedFlow();
    await expect(client.finishAuth({ code: 'c', state }, undefined)).rejects.toThrow(XAuthError);
    const raw = Buffer.from(start.cookie.value, 'base64url');
    raw[raw.length - 1]! ^= 1;
    await expect(client.finishAuth({ code: 'c', state }, raw.toString('base64url'))).rejects.toThrow(/invalid/);
    const other = makeClient(); // different key
    await expect(other.client.finishAuth({ code: 'c', state }, start.cookie.value)).rejects.toThrow(/invalid/);
    expect(calls).toHaveLength(0);
  });

  it('rejects an expired flow and a provider error', async () => {
    let now = 1_000_000;
    const ctx = makeClient({ now: () => now });
    const s = ctx.client.startAuth('launch-1', FIXTURE_WALLET);
    const st = new URL(s.url).searchParams.get('state')!;
    now += 11 * 60_000;
    await expect(ctx.client.finishAuth({ code: 'c', state: st }, s.cookie.value)).rejects.toThrow(/expired/);
    await expect(ctx.client.finishAuth({ error: 'access_denied', state: st }, s.cookie.value)).rejects.toThrow(/not granted/);
    expect(ctx.calls).toHaveLength(0);
  });
});

describe('refresh and revoke', () => {
  it('refreshes an expiring access token before use and stores the rotated pair', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens('launch-1', { accessExpiresAt: new Date(Date.now() + 10_000) }));
    const ctx = makeClient({ tokens, responders: [() => json(refreshedTokenResponse), () => json({ data: [] })] });
    await ctx.client.mentions('launch-1');
    const body = new URLSearchParams(ctx.calls[0]!.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('FIXTURE-REFRESH-TOKEN-stored');
    expect(ctx.calls[1]!.headers.authorization).toBe(`Bearer ${refreshedTokenResponse.access_token}`);
    const t = await tokens.get('launch-1');
    expect(t?.refreshToken).toBe(refreshedTokenResponse.refresh_token);
  });

  it('refreshes once on 401 and retries', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens());
    const ctx = makeClient({
      tokens,
      responders: [() => json({ title: 'Unauthorized', status: 401 }, 401), () => json(refreshedTokenResponse), () => json({ data: [] })],
    });
    await expect(ctx.client.mentions('launch-1')).resolves.toEqual([]);
    expect(ctx.calls.map((c) => c.url.split('?')[0])).toEqual([
      `https://api.x.com/2/users/${usersMe.data.id}/mentions`,
      'https://api.x.com/2/oauth2/token',
      `https://api.x.com/2/users/${usersMe.data.id}/mentions`,
    ]);
  });

  it('disconnects when X rejects the refresh token', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens());
    const ctx = makeClient({ tokens, responders: [() => json(invalidGrant, 400)] });
    await expect(ctx.client.refresh('launch-1')).rejects.toThrow(XNotConnectedError);
    expect(await ctx.client.isConnected('launch-1')).toBe(false);
  });

  it('keeps tokens when the token endpoint rejects our client credentials (401)', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens());
    const ctx = makeClient({ tokens, responders: [() => json({ error: 'unauthorized_client' }, 401)] });
    await expect(ctx.client.refresh('launch-1')).rejects.toThrow(/unauthorized_client/);
    expect(await ctx.client.isConnected('launch-1')).toBe(true);
  });

  it('revokes both tokens at X and deletes the row', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens());
    const ctx = makeClient({ tokens, responders: [() => json({ revoked: true }), () => json({ revoked: true })] });
    await expect(ctx.client.revoke('launch-1')).resolves.toEqual({ revokedRemotely: true });
    expect(ctx.calls.every((c) => c.url === 'https://api.x.com/2/oauth2/revoke')).toBe(true);
    expect(new URLSearchParams(ctx.calls[0]!.body).get('token')).toBe('FIXTURE-REFRESH-TOKEN-stored');
    expect(await ctx.client.isConnected('launch-1')).toBe(false);
  });
});

describe('wallet binding (X account fixation guard)', () => {
  it('startAuth refuses without a wallet; the wallet is sealed into the cookie and stored with the tokens', async () => {
    const ctx = makeClient({ responders: [() => json(tokenResponse), () => json(usersMe)] });
    expect(() => ctx.client.startAuth('launch-1', '')).toThrow(XAuthError);
    const s = ctx.client.startAuth('launch-1', 'WalletA');
    expect(s.cookie.value).not.toContain('WalletA');
    await ctx.client.finishAuth({ code: 'c', state: new URL(s.url).searchParams.get('state')! }, s.cookie.value);
    expect((await ctx.tokens.get('launch-1'))?.wallet).toBe('WalletA');
  });

  it('tokens bound to another wallet, or to none, are not connected for the launch', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens('launch-1', { wallet: 'Victim' }));
    await tokens.put(connectedTokens('launch-2', { wallet: null }));
    await tokens.put(connectedTokens('launch-3', { wallet: 'Launcher' }));
    const launchers: Record<string, string> = { 'launch-1': 'Attacker', 'launch-2': 'Launcher', 'launch-3': 'Launcher' };
    const ctx = makeClient({ tokens, launcherWallet: async (id) => launchers[id] ?? null, assertApproval: async () => {} });
    expect(await ctx.client.isConnected('launch-1')).toBe(false);
    expect(await ctx.client.isConnected('launch-2')).toBe(false);
    expect(await ctx.client.isConnected('launch-3')).toBe(true);
    await expect(ctx.client.post('launch-1', 'gm', 'appr')).rejects.toThrow(XNotConnectedError);
    expect(ctx.calls).toHaveLength(0);
  });

  it('claimConnection keeps only a connection started by the launcher wallet', async () => {
    const tokens = new MemoryTokenStore();
    await tokens.put(connectedTokens('launch-1', { wallet: 'Victim' }));
    await tokens.put(connectedTokens('launch-2', { wallet: 'Launcher' }));
    const ctx = makeClient({ tokens });
    expect(await ctx.client.claimConnection('launch-1', 'Attacker')).toBe(false);
    expect(await tokens.get('launch-1')).toBeNull();
    expect(await ctx.client.claimConnection('launch-2', 'Launcher')).toBe(true);
    expect(await ctx.client.claimConnection('launch-404', 'Launcher')).toBe(false);
  });
});
