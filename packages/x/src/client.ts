/**
 * XClient implementation (packages/core/src/ports.ts) against X API v2, plus
 * the OAuth 2.0 Authorization Code + PKCE flow for the launcher's OWN project
 * account. This package never creates accounts; it only connects an existing
 * one the user signs into on x.com.
 *
 * Token handling: tokens live only in memory for the duration of a call and
 * encrypted in x_tokens. Nothing here logs; error messages never include
 * tokens, auth headers or token-endpoint bodies beyond X's error code.
 */
import { createHash } from 'node:crypto';
import type { ApprovalAction } from '@carbon/core';
import type { XClient, XPost } from '@carbon/core/ports';
import { X_API_BASE, X_AUTHORIZE_URL, X_SCOPES, readXConfig, type XConfig } from './config.js';
import { TokenCipher } from './crypto.js';
import {
  ApprovalRequiredError,
  DuplicatePostError,
  EmptyPostError,
  PostTooLongError,
  RateLimitedError,
  XApiError,
  XAuthError,
  XConfigError,
  XError,
  XNotConnectedError,
  XTokenRejectedError,
} from './errors.js';
import { MAX_WEIGHTED_LENGTH, weightedLength } from './length.js';
import { codeChallengeS256, constantTimeEqual, createCodeVerifier, createState } from './pkce.js';
import { RateLimiter, type Endpoint, type Principal } from './ratelimit.js';
import {
  PgPostLedger,
  PgTokenStore,
  type PostLedger,
  type Queryable,
  type StoredTokens,
  type TokenStore,
  type XConnection,
} from './store.js';

/**
 * Consumer-provided approval gate. Wire core's `Approvals.consume` here. Must
 * throw unless approvalId is granted, unconsumed, for this launch and action.
 */
export type AssertApproval = (launchId: string, approvalId: string, action: Extract<ApprovalAction, 'post' | 'reply'>) => Promise<void>;

export interface XClientDeps {
  config: XConfig;
  tokens: TokenStore;
  ledger: PostLedger;
  /** Seals the short-lived OAuth flow cookie (same key as token storage). */
  cipher: TokenCipher;
  assertApproval?: AssertApproval;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limiter?: RateLimiter;
  /** GETs that hit 429 are retried once if the reset is within this many ms. Posts never auto-retry. */
  maxRetryWaitMs?: number;
  /** Identical text is refused within this window per launch. Default 24h. */
  dedupeWindowMs?: number;
  /** OAuth flow cookie lifetime. Default 10 minutes. */
  flowTtlMs?: number;
  requestTimeoutMs?: number;
}

export interface AuthCookie {
  name: string;
  value: string;
  maxAgeSec: number;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
}

export interface StartAuthResult {
  /** Redirect the user's browser here (x.com consent screen). */
  url: string;
  /** Set this cookie on the redirect response; read it back in the callback. */
  cookie: AuthCookie;
}

export type CallbackParams = URLSearchParams | Record<string, string | string[] | undefined>;

export type TrendsAvailability =
  | { status: 'unknown'; reason: null; checkedAt: null }
  | { status: 'available'; reason: null; checkedAt: number }
  | { status: 'unavailable'; reason: string; checkedAt: number };

export const AUTH_COOKIE_NAME = 'carbon_x_oauth';
const FLOW_AAD = 'carbon/x_oauth_flow/v1';
const DAY_MS = 24 * 60 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const TWEET_FIELDS = 'created_at,author_id,public_metrics';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

interface ApiTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    impression_count?: number;
  };
}

export class CarbonXClient implements XClient {
  private readonly cfg: XConfig;
  private readonly tokens: TokenStore;
  private readonly ledger: PostLedger;
  private readonly cipher: TokenCipher;
  private readonly assertApproval: AssertApproval | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly limiter: RateLimiter;
  private readonly maxRetryWaitMs: number;
  private readonly dedupeWindowMs: number;
  private readonly flowTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly refreshing = new Map<string, Promise<StoredTokens>>();
  private trendsState: TrendsAvailability = { status: 'unknown', reason: null, checkedAt: null };

  constructor(deps: XClientDeps) {
    this.cfg = deps.config;
    this.tokens = deps.tokens;
    this.ledger = deps.ledger;
    this.cipher = deps.cipher;
    this.assertApproval = deps.assertApproval;
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = deps.limiter ?? new RateLimiter({ now: this.now });
    this.maxRetryWaitMs = deps.maxRetryWaitMs ?? 2_000;
    this.dedupeWindowMs = deps.dedupeWindowMs ?? DAY_MS;
    this.flowTtlMs = deps.flowTtlMs ?? 10 * 60_000;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 15_000;
  }

  // ───────────────────────────── OAuth 2.0 + PKCE ─────────────────────────────

  /** Begin connecting the launcher's own X account to `launchId`. */
  startAuth(launchId: string): StartAuthResult {
    if (!launchId) throw new XAuthError('launchId is required');
    const verifier = createCodeVerifier();
    const state = createState();
    const url = new URL(this.cfg.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('scope', this.cfg.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallengeS256(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    const sealed = this.cipher.seal(JSON.stringify({ s: state, v: verifier, l: launchId, t: this.now() }), FLOW_AAD);
    return {
      url: url.toString(),
      cookie: {
        name: AUTH_COOKIE_NAME,
        value: Buffer.from(sealed).toString('base64url'),
        maxAgeSec: Math.floor(this.flowTtlMs / 1000),
        httpOnly: true,
        secure: new URL(this.cfg.redirectUri).protocol === 'https:',
        sameSite: 'lax',
        path: '/',
      },
    };
  }

  /**
   * Handle the redirect back from x.com. `cookieValue` is the cookie set by
   * startAuth. Verifies state (constant time), exchanges the code with the
   * PKCE verifier, resolves the account via /2/users/me and stores the tokens
   * encrypted. Returns the connection (never tokens).
   */
  async finishAuth(params: CallbackParams, cookieValue: string | undefined): Promise<XConnection> {
    const get = (k: string): string | undefined => {
      if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
      const v = params[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const error = get('error');
    if (error) throw new XAuthError(`X authorization was not granted (${error.slice(0, 64)})`);
    if (!cookieValue) throw new XAuthError('Missing OAuth flow cookie');
    let flow: { s: string; v: string; l: string; t: number };
    try {
      flow = JSON.parse(this.cipher.open(Uint8Array.from(Buffer.from(cookieValue, 'base64url')), FLOW_AAD));
    } catch {
      throw new XAuthError('OAuth flow cookie is invalid');
    }
    if (this.now() - flow.t > this.flowTtlMs) throw new XAuthError('OAuth flow expired; start again');
    const state = get('state');
    if (!state || !constantTimeEqual(state, flow.s)) throw new XAuthError('OAuth state mismatch');
    const code = get('code');
    if (!code) throw new XAuthError('Missing authorization code');

    const tok = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: flow.v,
    });
    const me = await this.request<{ data: { id: string; username: string } }>(
      'GET /2/users/me',
      { kind: 'user', id: `oauth:${flow.l}` },
      '/2/users/me',
      { method: 'GET' },
      tok.access_token,
    );
    const stored: StoredTokens = {
      launchId: flow.l,
      xUserId: me.data.id,
      xHandle: me.data.username,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      accessExpiresAt: new Date(this.now() + tok.expires_in * 1000),
      scopes: tok.scope ? tok.scope.split(' ').filter(Boolean) : [...this.cfg.scopes],
    };
    await this.tokens.put(stored);
    return publicConnection(stored);
  }

  /** Force a token refresh (normally automatic). X rotates refresh tokens. */
  async refresh(launchId: string): Promise<XConnection> {
    const current = await this.tokens.get(launchId);
    if (!current) throw new XNotConnectedError(launchId);
    return publicConnection(await this.refreshTokens(current));
  }

  /** Revoke at X (best effort for both tokens) and always delete locally. */
  async revoke(launchId: string): Promise<{ revokedRemotely: boolean }> {
    const current = await this.tokens.get(launchId);
    if (!current) return { revokedRemotely: false };
    let ok = true;
    for (const [token, hint] of [
      [current.refreshToken, 'refresh_token'],
      [current.accessToken, 'access_token'],
    ] as const) {
      if (!token) continue;
      try {
        await this.oauthPost('POST /2/oauth2/revoke', '/2/oauth2/revoke', { token, token_type_hint: hint });
      } catch {
        ok = false;
      }
    }
    await this.tokens.delete(launchId);
    return { revokedRemotely: ok };
  }

  async connection(launchId: string): Promise<XConnection | null> {
    const t = await this.tokens.get(launchId);
    return t ? publicConnection(t) : null;
  }

  async isConnected(launchId: string): Promise<boolean> {
    return (await this.tokens.get(launchId)) !== null;
  }

  // ───────────────────────────── posting ─────────────────────────────

  post(launchId: string, text: string, approvalId: string): Promise<{ id: string; url: string }> {
    return this.publish('post', launchId, text, approvalId, null);
  }

  reply(launchId: string, inReplyTo: string, text: string, approvalId: string): Promise<{ id: string; url: string }> {
    if (!/^\d{1,19}$/.test(inReplyTo)) return Promise.reject(new XError('inReplyTo must be a numeric post id'));
    return this.publish('reply', launchId, text, approvalId, inReplyTo);
  }

  private async publish(
    kind: 'post' | 'reply',
    launchId: string,
    rawText: string,
    approvalId: string,
    inReplyTo: string | null,
  ): Promise<{ id: string; url: string }> {
    // 1. No approval gate wired → refuse outright.
    const gate = this.assertApproval;
    if (!gate) throw new ApprovalRequiredError('Posting is disabled: no approval hook is configured');
    if (!approvalId) throw new ApprovalRequiredError('An approvalId is required to post');

    // 2. Local validation (cheap, consumes nothing).
    const text = rawText.normalize('NFC');
    if (text.trim().length === 0) throw new EmptyPostError();
    const len = weightedLength(text);
    if (len.weightedLength > MAX_WEIGHTED_LENGTH) throw new PostTooLongError(len.weightedLength, MAX_WEIGHTED_LENGTH);

    // 3. Must have a connected account (DB only).
    const tokens = await this.tokens.get(launchId);
    if (!tokens) throw new XNotConnectedError(launchId);

    // 4. Dedupe: reserve this text for the launch before anything irreversible.
    const hash = textHash(text);
    const res = await this.ledger.reserve(launchId, hash, kind, new Date(this.now()), this.dedupeWindowMs);
    if (!res.ok) throw new DuplicatePostError(res.postId, res.postedAt);

    // 5. Approval gate, BEFORE any network call. Consumes the approval.
    try {
      await gate(launchId, approvalId, kind);
    } catch (e) {
      await this.ledger.release(launchId, hash);
      throw new ApprovalRequiredError(`Approval ${approvalId} was not accepted for ${kind}`, e);
    }

    // 6. Network.
    const body: Record<string, unknown> = { text };
    if (inReplyTo) body.reply = { in_reply_to_tweet_id: inReplyTo };
    let created: { data: { id: string; text: string } };
    try {
      created = await this.userRequest<{ data: { id: string; text: string } }>(launchId, 'POST /2/tweets', '/2/tweets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, false);
    } catch (e) {
      // Release only when X definitely did not create the post; keep the
      // reservation on timeouts/5xx so a retry cannot double-post.
      if (definitelyNotPublished(e)) await this.ledger.release(launchId, hash);
      throw e;
    }
    await this.ledger.markPublished(launchId, hash, created.data.id);
    const handle = (await this.tokens.get(launchId))?.xHandle ?? tokens.xHandle;
    return { id: created.data.id, url: `https://x.com/${handle}/status/${created.data.id}` };
  }

  // ───────────────────────────── reading ─────────────────────────────

  /**
   * GET /2/tweets/search/recent. Uses the app bearer token (X_BEARER_TOKEN);
   * pass `launchId` to use that launch's user token instead.
   */
  async searchRecent(query: string, opts: { max?: number; launchId?: string } = {}): Promise<XPost[]> {
    if (!query.trim()) return [];
    if (query.length > 512) throw new XError('Search query exceeds 512 characters');
    const max = Math.min(100, Math.max(10, Math.floor(opts.max ?? 10)));
    const qs = new URLSearchParams({ query, max_results: String(max), 'tweet.fields': TWEET_FIELDS });
    const path = `/2/tweets/search/recent?${qs}`;
    const res = opts.launchId
      ? await this.userRequest<{ data?: ApiTweet[] }>(opts.launchId, 'GET /2/tweets/search/recent', path, { method: 'GET' }, true)
      : await this.appRequest<{ data?: ApiTweet[] }>('GET /2/tweets/search/recent', path);
    return (res.data ?? []).map(toXPost);
  }

  async mentions(launchId: string, sinceId?: string): Promise<XPost[]> {
    const t = await this.tokens.get(launchId);
    if (!t) throw new XNotConnectedError(launchId);
    const qs = new URLSearchParams({ max_results: '100', 'tweet.fields': TWEET_FIELDS });
    if (sinceId) {
      if (!/^\d{1,19}$/.test(sinceId)) throw new XError('sinceId must be a numeric post id');
      qs.set('since_id', sinceId);
    }
    const res = await this.userRequest<{ data?: ApiTweet[] }>(
      launchId,
      'GET /2/users/:id/mentions',
      `/2/users/${encodeURIComponent(t.xUserId)}/mentions?${qs}`,
      { method: 'GET' },
      true,
    );
    return (res.data ?? []).map(toXPost);
  }

  /**
   * GET /2/trends/by/woeid/:id (app-only bearer). Returns [] when the app has
   * no bearer token or X refuses access for this account/tier; the reason is
   * available from trendsAvailability(). Rate limits still throw.
   */
  async trends(woeid = 1): Promise<{ name: string; volume?: number }[]> {
    if (!this.cfg.bearerToken) {
      this.trendsState = { status: 'unavailable', reason: 'X_BEARER_TOKEN is not set (trends need an app-only token)', checkedAt: this.now() };
      return [];
    }
    const qs = new URLSearchParams({ max_trends: '50', 'trend.fields': 'trend_name,tweet_count' });
    try {
      const res = await this.appRequest<{ data?: { trend_name: string; tweet_count?: number }[] }>(
        'GET /2/trends/by/woeid/:id',
        `/2/trends/by/woeid/${Math.trunc(woeid)}?${qs}`,
      );
      this.trendsState = { status: 'available', reason: null, checkedAt: this.now() };
      return (res.data ?? []).map((t) => (t.tweet_count === undefined ? { name: t.trend_name } : { name: t.trend_name, volume: t.tweet_count }));
    } catch (e) {
      if (e instanceof XApiError && (e.status === 401 || e.status === 402 || e.status === 403)) {
        this.trendsState = {
          status: 'unavailable',
          reason: `X refused trends (${e.status}${e.title ? ` ${e.title}` : ''}${e.detail ? `: ${e.detail}` : ''})`,
          checkedAt: this.now(),
        };
        return [];
      }
      throw e;
    }
  }

  trendsAvailability(): TrendsAvailability {
    return this.trendsState;
  }

  // ───────────────────────────── transport ─────────────────────────────

  private async appRequest<T>(endpoint: Endpoint, path: string): Promise<T> {
    if (!this.cfg.bearerToken) throw new XConfigError('X_BEARER_TOKEN is not set and no launchId was given');
    return this.request<T>(endpoint, { kind: 'app' }, path, { method: 'GET' }, this.cfg.bearerToken);
  }

  /** Request with the launch's user token; refreshes when near expiry and once on 401. */
  private async userRequest<T>(launchId: string, endpoint: Endpoint, path: string, init: RequestInit, retry429: boolean): Promise<T> {
    let t = await this.tokens.get(launchId);
    if (!t) throw new XNotConnectedError(launchId);
    if (t.accessExpiresAt.getTime() - REFRESH_SKEW_MS <= this.now() && t.refreshToken) t = await this.refreshTokens(t);
    const principal: Principal = { kind: 'user', id: t.xUserId };
    try {
      return await this.request<T>(endpoint, principal, path, init, t.accessToken, retry429);
    } catch (e) {
      if (e instanceof XApiError && e.status === 401 && t.refreshToken) {
        t = await this.refreshTokens(t);
        return this.request<T>(endpoint, principal, path, init, t.accessToken, retry429);
      }
      throw e;
    }
  }

  private async request<T>(
    endpoint: Endpoint,
    principal: Principal,
    path: string,
    init: RequestInit,
    bearer: string,
    retry429 = init.method === 'GET',
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.limiter.acquire(endpoint, principal);
      const res = await this.fetchImpl(`${this.cfg.apiBase}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const until = this.limiter.observe(endpoint, principal, res.status, res.headers);
      if (res.status === 429) {
        const resetAt = new Date(until ?? this.now());
        const wait = resetAt.getTime() - this.now();
        if (retry429 && attempt === 0 && wait <= this.maxRetryWaitMs) {
          await this.sleep(Math.max(0, wait));
          continue;
        }
        throw new RateLimitedError(endpoint, resetAt, '429');
      }
      if (!res.ok) throw await apiError(endpoint, res);
      return (await res.json()) as T;
    }
  }

  private async refreshTokens(current: StoredTokens): Promise<StoredTokens> {
    const inflight = this.refreshing.get(current.launchId);
    if (inflight) return inflight;
    const p = (async () => {
      if (!current.refreshToken) throw new XNotConnectedError(current.launchId);
      let tok: TokenResponse;
      try {
        tok = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
      } catch (e) {
        if (e instanceof XTokenRejectedError && e.status === 400) {
          // Refresh token rejected (revoked by user, rotated elsewhere): disconnect.
          // A 401 means our client credentials are wrong; keep the user's tokens.
          await this.tokens.delete(current.launchId);
          throw new XNotConnectedError(current.launchId);
        }
        throw e;
      }
      const next: StoredTokens = {
        ...current,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? current.refreshToken,
        accessExpiresAt: new Date(this.now() + tok.expires_in * 1000),
        scopes: tok.scope ? tok.scope.split(' ').filter(Boolean) : current.scopes,
      };
      await this.tokens.put(next);
      return next;
    })();
    this.refreshing.set(current.launchId, p);
    try {
      return await p;
    } finally {
      this.refreshing.delete(current.launchId);
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const res = await this.oauthPost('POST /2/oauth2/token', '/2/oauth2/token', params);
    const json = (await res.json()) as Partial<TokenResponse>;
    if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
      throw new XAuthError('Token endpoint returned an unexpected response');
    }
    return json as TokenResponse;
  }

  /** application/x-www-form-urlencoded POST to the OAuth endpoints, client-authenticated per X docs. */
  private async oauthPost(endpoint: Endpoint, path: string, params: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const body = new URLSearchParams(params);
    if (this.cfg.clientSecret) {
      const basic = Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
    } else {
      body.set('client_id', this.cfg.clientId);
    }
    const res = await this.fetchImpl(`${this.cfg.apiBase}${path}`, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      throw new RateLimitedError(endpoint, new Date(Number.isFinite(reset) && reset > 0 ? reset * 1000 : this.now() + 60_000), '429');
    }
    if (!res.ok) {
      let code = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (typeof j.error === 'string') code = j.error.slice(0, 64);
      } catch {
        /* body is not JSON; keep status */
      }
      if (res.status === 400 || res.status === 401) throw new XTokenRejectedError(res.status, code);
      throw new XApiError(endpoint, res.status, code, undefined, undefined);
    }
    return res;
  }
}

/** Build from env: X_CLIENT_ID, X_CLIENT_SECRET, X_REDIRECT_URI, X_BEARER_TOKEN, CARBON_TOKEN_KEY. */
export function createXClient(opts: {
  db: Queryable;
  assertApproval?: AssertApproval;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): CarbonXClient {
  const env = opts.env ?? process.env;
  const cipher = TokenCipher.fromEnv(env);
  return new CarbonXClient({
    config: readXConfig(env),
    tokens: new PgTokenStore(opts.db, cipher),
    ledger: new PgPostLedger(opts.db),
    cipher,
    ...(opts.assertApproval ? { assertApproval: opts.assertApproval } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export function textHash(text: string): string {
  return createHash('sha256').update(text.normalize('NFC').trim(), 'utf8').digest('hex');
}

function publicConnection(t: StoredTokens): XConnection {
  return { launchId: t.launchId, xUserId: t.xUserId, xHandle: t.xHandle, scopes: [...t.scopes] };
}

function toXPost(t: ApiTweet): XPost {
  const m = t.public_metrics;
  return {
    id: t.id,
    text: t.text,
    authorId: t.author_id ?? '',
    createdAt: t.created_at ?? '',
    ...(m
      ? {
          metrics: {
            likes: m.like_count ?? 0,
            reposts: m.retweet_count ?? 0,
            replies: m.reply_count ?? 0,
            quotes: m.quote_count ?? 0,
            ...(m.impression_count !== undefined ? { impressions: m.impression_count } : {}),
          },
        }
      : {}),
  };
}

function definitelyNotPublished(e: unknown): boolean {
  if (e instanceof RateLimitedError) return true;
  if (e instanceof XNotConnectedError || e instanceof XConfigError) return true;
  if (e instanceof XApiError) return e.status >= 400 && e.status < 500;
  return false;
}

async function apiError(endpoint: Endpoint, res: Response): Promise<XApiError> {
  let title: string | undefined;
  let detail: string | undefined;
  let type: string | undefined;
  try {
    const j = (await res.json()) as { title?: unknown; detail?: unknown; type?: unknown; message?: unknown };
    if (typeof j.title === 'string') title = j.title.slice(0, 200);
    if (typeof j.detail === 'string') detail = j.detail.slice(0, 500);
    else if (typeof j.message === 'string') detail = j.message.slice(0, 500);
    if (typeof j.type === 'string') type = j.type.slice(0, 200);
  } catch {
    /* non-JSON body */
  }
  return new XApiError(endpoint, res.status, title, detail, type);
}

export { X_API_BASE, X_AUTHORIZE_URL, X_SCOPES };
