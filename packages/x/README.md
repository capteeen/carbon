# @carbon/x

X API v2 client for Carbon. Implements `XClient` from `@carbon/core/ports`, plus
the OAuth 2.0 Authorization Code with PKCE flow that connects the launcher's own
project account. This package does not create X accounts and has no signup code
of any kind (`test/static-guards.test.ts` checks this).

## Environment

| Var | Required | Use |
| --- | --- | --- |
| `X_CLIENT_ID` | yes | OAuth 2.0 client id (Developer Console → Keys and tokens) |
| `X_CLIENT_SECRET` | confidential clients | Sent as HTTP Basic on `/2/oauth2/token` and `/2/oauth2/revoke`. If it is unset, the client acts as a public client and sends `client_id` in the body. |
| `X_REDIRECT_URI` | yes | Must exactly match a callback URL set on the X app. Must be https, except for localhost. |
| `X_BEARER_TOKEN` | optional | App-only token for `searchRecent` and `trends`. If it is unset, `trends()` returns `[]` with a reason. |
| `CARBON_TOKEN_KEY` | yes | 32 bytes, as hex or base64. It is the AES-256-GCM key for stored tokens and the OAuth flow cookie. |

## Wiring (apps/web and the worker)

```ts
import { createXClient, migrate, AUTH_COOKIE_NAME } from '@carbon/x';
await migrate(pool);                       // or run migrations/0001_*.sql and 0002_*.sql
// The worker's hook: consumed approval + approved text hash + one use (apps/worker/src/x.ts).
const x = createXClient({ db: pool, assertApproval: (l, a, act, textSha256) => checkOnePost(l, a, act, textSha256) });

// POST /api/x/connect (signed by the launcher wallet, same origin, JSON)
const { url, cookie } = x.startAuth(launchId, wallet);   // set `cookie`, return `url`
// GET /api/x/callback
const conn = await x.finishAuth(new URL(req.url).searchParams, cookies.get(AUTH_COOKIE_NAME));
// conn = { launchId, xUserId, xHandle, scopes, wallet }. It never contains tokens. Clear the cookie afterwards.
// POST /api/launch: keep the connection only if the launcher wallet started it.
const xConnected = await x.claimConnection(launchId, launcherWallet);
```

The cookie is httpOnly, SameSite=Lax and lasts 10 minutes. Its value is the state,
the PKCE verifier, the launchId, the wallet that started the flow and the issue
time, sealed with AES-GCM so the browser never sees the verifier.

**Wallet binding.** Every connection is stored with the wallet that started it
(`x_tokens.wallet`). User tokens are used (posting, mentions, `isConnected`) only
when that wallet equals the launch's launcher wallet. By default
`createXClient` reads it from the `launch.created` event; pass `launcherWallet` to
override. A connection bound to another wallet, or to none, counts as not
connected, so nobody can attach someone else's X account to their launch. `finishAuth` checks the state in constant time and
rejects a mismatched state, a missing or tampered cookie, an expired flow, or an
`error=` callback. All of these checks run before any network call.

## Posting rules

`post` and `reply` run these steps in this order:
1. If no `assertApproval` hook was injected, they refuse with `ApprovalRequiredError`.
2. Weighted length must be ≤ 280 and the text must not be empty. Nothing is consumed at this step.
3. The launch must have a connected account bound to the launcher wallet. This is a database read only.
4. Dedupe. Identical NFC-trimmed text for the same launch within 24h is refused with
   `DuplicatePostError`. The text is reserved atomically in `x_post_dedupe`.
5. `assertApproval(launchId, approvalId, 'post' | 'reply', textSha256)`. It must admit exactly one
   post per approval, with the approved text, and record the use atomically.
   If it throws, the reservation is released and the call fails with `ApprovalRequiredError`.
6. `POST /2/tweets`. On a definite 4xx or 429 the reservation is released. On a timeout or 5xx it is
   kept, so a retry cannot post twice.

## Weighted length

`src/length.ts` reimplements X's counting rules:
- Text is NFC-normalised before counting.
- Code points in the twitter-text v3 ranges count 1. All other code points count 2.
- Every emoji counts 2, including ZWJ sequences.
- Every URL counts 23.

Two limits:
- URL detection covers scheme URLs and bare domains on a fixed TLD list. twitter-text recognises every IANA TLD.
- The auto-mention prefix on replies is not subtracted. This can only make the count too high, never too low.

## Rate limits

`RateLimiter` keeps a separate bucket for each endpoint and principal (app, or user id). A request goes out only if both of these layers allow it:
- **Local token bucket.** Seeded from the documented limits:
  - POST /2/tweets: 100/15 min per user, plus 10,000/24 h app-wide across all users
  - search/recent: 300 per user / 450 per app, per 15 min
  - mentions: 300 per user / 450 per app, per 15 min
  - users/me: 75 per 15 min
  - trends/by/woeid: 75 per 15 min, app only
- **Server state** from `x-rate-limit-limit/remaining/reset`, plus the 24-hour headers `x-user-limit-24hour-*` and `x-app-limit-24hour-*`.

When `remaining` reaches 0, requests are blocked locally until the reset time. A 429 also blocks until the reset time. If the 429 has no reset header, the limiter backs off exponentially, from 15 s up to 15 min.

Every block surfaces as `RateLimitedError { endpoint, resetAt, source }`. A GET whose reset is ≤ 2 s away is retried once. POSTs are never retried automatically.

## Trends

`GET /2/trends/by/woeid/:id` is available on the current pay-per-use plan and is billed per request. It needs the app-only bearer token. In these cases `trends()` returns `[]` and `trendsAvailability()` gives the reason:
- no bearer token is configured
- X answers 401, 402 or 403

## Sources (read 2026-10-11)

- OAuth 2.0 authorization code + PKCE, scopes, endpoints: https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
- Token exchange, refresh and revoke requests, with Basic auth for confidential clients: https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
- Rate limits and headers: https://docs.x.com/x-api/fundamentals/rate-limits
- Create Post (`POST /2/tweets`; scopes tweet.read, tweet.write, users.read): https://docs.x.com/x-api/posts/create-post
- Trends by WOEID: https://docs.x.com/x-api/trends/get-trends-by-woeid
- Pricing (pay-per-use; Post create $0.015, Post read $0.005/resource, Trends $0.010/request): https://docs.x.com/x-api/getting-started/pricing
- Counting characters: https://docs.x.com/fundamentals/counting-characters
- twitter-text v3 weights config: https://github.com/twitter/twitter-text/blob/master/config/v3.json
- PKCE test vector: RFC 7636 Appendix B, https://www.rfc-editor.org/rfc/rfc7636#appendix-B

## Verification status

api.x.com is blocked from the build sandbox, so **live verification is pending**. Tests use an injected `fetch` with hand-written fixtures under `test/fixtures/`. These fixtures follow the documented schemas and were not recorded from the live API. The Postgres tests run against the local `carbon_test` database, in a throwaway schema.

Not yet checked against the live API:
- the exact token endpoint error codes
- the problem shape returned for duplicate-content rejections
- which 24-hour headers `POST /2/tweets` returns
- whether the trends endpoint is enabled for this app's account
