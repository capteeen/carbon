# Carbon security

This document covers Carbon's threat model, how keys are handled, how approvals and money
paths work, and the risks that remain. Findings use the ids from
[audit-log.md](audit-log.md). Each one has a test in `tests/` or is marked "review".

Last reviewed 2026-10-11 (second pass, `main` at `40b7a44`). The first-pass findings AG-001 to
AG-026 are all fixed. The fixes changed the threat model in the sections marked *(changed)*.

## Assets and trust boundaries

| Asset | Where it lives | Who can use it |
|---|---|---|
| Launcher wallet keys | The user's browser wallet only | The user. Carbon receives message signatures and a user-signed launch tx, never a key. |
| Agent signing keys (ed25519, one per agent) | Derived from `CARBON_AGENT_KEY_SEED` (env). An explicit seed argument is accepted only when `NODE_ENV=test`. | The worker, which signs hand-offs. The web app, which appends user events. |
| Crank, buyback and per-launch fee-wallet keys | `CARBON_CRANK_KEY` and `CARBON_BUYBACK_KEY` from env. Per-launch wallets (wallet mode only) are sealed with `CARBON_VAULT_KEY`. | The worker, through `@carbon/solana`. |
| X OAuth tokens | Postgres `x_tokens`, sealed with AES-GCM under `CARBON_TOKEN_KEY`, bound to the launcher wallet that started the flow | The worker's X client, only for a launch created by that wallet and only with a consumed approval. |
| Event log | Postgres `events` table (append-only, hashed and signed) | Everyone can read it (SSE, pages). The worker and the web routes append. |
| Single-use ledgers | `carbon_signed_nonces`, `carbon_x_approval_uses`, `sol_launch_approvals`, `budget_ledger.spend_key` | Postgres enforces them with primary keys and unique indexes. |

Attackers considered:
- An anonymous web visitor.
- A malicious launcher (their own wallet).
- A third party who knows a launch id.
- A malicious site that a launcher visits (CSRF / login-CSRF).
- A crashed or duplicated worker.
- Someone with read access to the git history or logs.

The following are out of scope: a compromised host, a compromised Postgres superuser (a raw
writer can still freeze the bonds display with a future-dated row, see AG-012), and a malicious
RPC operator. That last one is narrowed: the RPC can no longer pass a different cluster off as
devnet (AG-011).

## Key handling

- Every secret is read from env, and the repo holds only names (`.env.example` lines are
  `NAME=`).
- The history of every ref and the tracked files contain no key-, seed-, token- or JWT-shaped
  value. No `.env` or `details/` path was ever committed, and `.gitignore` covers both
  (`tests/test/secrets.test.ts`).
- *(changed)* The vendored `vendor/qsd-market` submodule is now scanned as well: its history and
  its files. Its code runs in the worker through `@qsd/protocol`. The previous scan read it as a
  gitlink and skipped it.
- Key objects do not serialise their secrets. `KeyRing`, the solana config and `TokenCipher`
  have no secret in `JSON.stringify` or `util.inspect` output.
- Error messages name the variable, never the value. RPC `api-key` query values, bearer tokens
  and base58 keys are redacted from chain errors. Web routes return `{"error":"internal error"}`
  for anything unexpected.
- No `console.*` in `src/` prints env values or keys (re-checked over the fix commits). The
  worker's boot line names the LLM provider, model and fallback reason, never a key. The Next
  production build output, the server logs and the perf results contain no secret pattern.

## Approvals *(changed)*

- **Wallet signatures.** Each user action is an ed25519 message signature by the launcher's
  wallet over a canonical text (`apps/web/src/lib/signing.ts`). The text is bound to the launch
  id, the action and the event or approval it answers.
- **Single-use timed signatures.**
  - Autopilot, kill-switch and X-connect requests carry an `issuedAt` (5-minute window).
  - The sha256 of the exact signed text is a nonce, recorded once in `carbon_signed_nonces` after
    the signature verifies. A replay inside the window is refused (AG-016).
- **Approvals table.**
  - Each approval moves through open → granted → consumed exactly once, and each consumption is
    a public `approval.consumed` event (AG-023).
  - Grants for another launch or another action are refused.
  - A DB constraint forbids autopiloting launches, and DIAMOND refuses autopilot.
  - The kill switch revokes autopilot for good.
- **Approvals bound to what was approved.**
  - **Launch.** The chain seam requires a consumed approval and a passing score whose draft
    content (name, ticker, lore, logo hash) has not changed since (AG-001). The first build binds
    the approval to name, symbol, metadata URI, dev buy and payer. Any rebuild with other values,
    or under a superseded approval, is refused (AG-002).
  - **Posts.** One consumed approval authorises one network post, with the approved card's text
    (hash match) and the approved action. The use is recorded before the request (AG-003).
- **X account.**
  - Connect is a same-origin JSON POST signed by the launcher wallet. The wallet is sealed in the
    OAuth flow cookie and stored with the tokens.
  - A connection counts only for a launch created by that same wallet. The web app discards it
    otherwise, and the worker ignores it. This closes AG-004, the former blocking finding.
  - An attacker's authorize URL is useless to a victim, because the callback needs the
    attacker's own flow cookie.
- **Weak points remaining (all minor):**
  - The consumption and its public event are two steps, not one transaction (AG-027).
  - A party who learns a launch id before the launch is created can erase, but not take over,
    its pending X connection (AG-036).
  - The score does not name the draft it scored, and the logo image, banner and site are never
    content-checked (AG-035).

## Money paths *(changed)*

**Fee split.**
- Native mode (the default) uses pump.fun fee sharing: launcher 5000 bps, buyback 3000 bps,
  treasury 2000 bps. The split is set once in the launch tx (`carbonShares` refuses duplicates
  and any total other than 10,000 bps). Carbon never holds the launcher's share in this mode.
  Distributions are permissionless. Ones cranked by third parties are now found on the sharing
  config and receipted.
- Wallet mode (`CARBON_FEE_MODE=wallet`) is different: a Carbon-held per-launch wallet claims all
  fees and pays the three legs. The site now says so, and `/wallets` shows each launch's mode
  (AG-019).

**Idempotency.**
- Each split leg, buyback tranche and airdrop is a durable ledger row (`driveTxRow`). The ledger
  moves through wallet → built → sent → confirmed and is resumed under an advisory lock.
- A claim row exists before its transaction is broadcast. Every confirmed claim without a
  `fee.claimed` gets one on the next tick (AG-007).
- Once-only facts are deduplicated by the bus under its append lock:
  - `fee.claimed` per claim
  - `buyback.executed` per txSig
  - `split.receipt`
  - holder snapshots
  - decay events
  - `daughter.launched`
  - `airdrop.sent`

  Two workers racing to receipt the same fact publish it once (AG-005, AG-017).
- Buyback receipts carry what the confirmed trade spent, from the on-chain trade event (AG-006).
  A resumed buy is budgeted once, keyed by split and tranche (AG-022).
- The kill switch stops posts, replies and new buybacks only. Claims, splits and receipts keep
  running (AG-008).
- **Remaining (minor):**
  - On DIAMOND, a claim that landed just before a crash is re-driven only through the gated
    claim call, so a rejected gate leaves it unreceipted (AG-034).
  - The third-party distribution scan reads at most 1000 signatures per tick (AG-033).

**Mainnet.**
- Mainnet runs only with `CARBON_NETWORK=mainnet-beta` and `CARBON_MAINNET_ENABLED=true` (exact
  strings, read the same way everywhere). `CarbonChainClient` re-checks this when it is
  constructed.
- *(changed)* The cluster is decided by the RPC's genesis hash, checked before any build, send,
  claim, split, buy, airdrop or ledger read. A devnet-labelled client on a mainnet, testnet or
  unknown genesis refuses, and so does a mainnet config on a devnet genesis. An RPC that cannot
  answer fails closed and is retried (AG-011). The URL check remains only as a fast first filter.

## Browser and visuals *(new in this pass)*

- `@carbon/visual` runs entirely in the browser and receives only public log data: events,
  core's bonds, receipts and launch summaries. It holds no secret and makes no write request.
- Its honesty filters accept only real 64-hex event ids for flashes, hashes, replays and
  crystals. The browser checks in `tests/e2e/honesty.ts` confirm this on the production build.
- Display-time bonds use the browser's clock (AG-032). This is a display accuracy issue, not a
  trust boundary: the server never takes bond orders from the client.
- `/embed/*` may be framed by any site (player card). Every other page sends
  `X-Frame-Options: DENY`.

## Residual risks (accepted or pending)

- **Blocking:** none open. AG-004 is fixed.
- **Major:** AG-031. The ≥ 55 fps median on a throttled phone and the under-2 s first frame are
  unverified. The sandbox has no GPU, and its SwiftShader numbers fail at device DPR. This is a
  product-quality risk, not a security one.
- **Minor, open:** AG-027 to AG-030 and AG-032 to AG-036.
- **No live verification of external services.** Solana RPC, pump.fun, pumpportal and api.x.com
  are blocked from the build sandbox. Every chain and X behaviour above was verified against
  in-repo doubles, not the live services. In particular, none of these has been seen working end
  to end:
  - native fee-sharing instructions, distribution, claims and the third-party distribution scan
  - `buyCarbon` venue routing
  - daughter launches
  - X OAuth and posting
  - the genesis check against a real RPC

  The Gemini model id (`gemini-3.8-flash`) was not checked against Google's docs, which were
  unreachable from the sandbox.
- **LLM provider.** Production is Gemini only. The worker deploy pins `NODE_ENV=production`, and a
  fallback provider is refused unless `CARBON_LLM_ALLOW_FALLBACK=true` outside production
  (AG-013 fixed).
- **Single Postgres.** The log, approvals, nonces and ledgers all live in one Postgres. Anyone
  with write access there can bypass every guard.
- **Migrations run in the worker only.** The web app's single-use guards (nonces, the unique
  `launch.created` index) depend on the worker having migrated first. Until then those routes
  fail closed with an internal error.
