# Carbon security

This document covers Carbon's threat model, how keys are handled, how approvals and money
paths work, and the risks that remain. Findings use the ids from
[audit-log.md](audit-log.md), and each has a test in `tests/`. Last reviewed 2026-10-11.

## Assets and trust boundaries

| Asset | Where it lives | Who can use it |
|---|---|---|
| Launcher wallet keys | The user's browser wallet only | The user. Carbon receives message signatures and a user-signed launch tx, never a key. |
| Agent signing keys (ed25519, one per agent) | Derived from `CARBON_AGENT_KEY_SEED` (env) | The worker, which signs hand-offs. |
| Crank, buyback and per-launch fee-wallet keys | `CARBON_CRANK_KEY` and `CARBON_BUYBACK_KEY` from env. Per-launch wallets (wallet mode only) are sealed with `CARBON_VAULT_KEY`. | The worker, through `@carbon/solana`. |
| X OAuth tokens | Postgres, sealed with AES-GCM under `CARBON_TOKEN_KEY` | The worker's X client, only with a consumed approval. |
| Event log | Postgres `events` table (append-only, hashed and signed) | Everyone can read it (SSE, pages). The worker and the web routes append. |

Attackers considered:
- An anonymous web visitor.
- A malicious launcher (their own wallet).
- A third party who knows a launch id.
- A crashed or duplicated worker.
- Someone with read access to the git history or logs.

The following are out of scope: a compromised host, a compromised Postgres superuser
(see AG-012), and a malicious RPC operator.

## Key handling

- Every secret is read from env, and the repo holds only names (`.env.example` lines are
  `NAME=`).
- `git log -p --all` and the tracked files contain no key-, seed- or JWT-shaped value. No
  `.env` or `details/` path was ever committed, and `.gitignore` covers both
  (`tests/test/secrets.test.ts`).
- Key objects do not serialise their secrets. `KeyRing`, the solana config and
  `TokenCipher` have no secret in `JSON.stringify` or `util.inspect` output.
- Error messages name the variable, never the value. RPC `api-key` query values, bearer
  tokens and base58 keys are redacted from chain errors. Web routes return
  `{"error":"internal error"}` for anything unexpected.
- No `console.*` call in `src/` prints env values or keys, and no event payload type has a
  field named like a secret.

## Approvals

- **Wallet signatures.** Each user action is an ed25519 message signature by the
  launcher's wallet over a canonical text (`apps/web/src/lib/signing.ts`). The text is
  bound to the launch id, the action and the event it answers.
- **Approvals table.** Approvals live in the `approvals` table:
  - Each moves through open → granted → consumed exactly once.
  - Grants for another launch or another action are refused.
  - A DB constraint forbids autopiloting launches.
  - DIAMOND refuses autopilot.
  - The kill switch revokes autopilot for good.
- **Weak points:**
  - The chain seam and the X seam only *check* "consumed". They do not bind the approval
    to the exact values approved or count its uses: AG-001, AG-002 and AG-003.
  - Autopilot and kill signatures are bound only by time (AG-016).
- **X account.** X is connected per launch id *before* the launch exists, and nothing
  binds that OAuth session to the launcher's wallet. This is AG-004 (**blocking**): an
  attacker can get a victim's X account attached to the attacker's launch.

## Money paths

**Fee split.**
- Native mode (the default) uses pump.fun fee sharing: launcher 5000 bps, buyback
  3000 bps, treasury 2000 bps. The split is set once in the launch tx (`carbonShares`
  refuses duplicates and any total other than 10,000 bps). Carbon never holds the
  launcher's share in this mode.
- Wallet mode (`CARBON_FEE_MODE=wallet`) is different: a Carbon-held per-launch wallet
  claims all fees and pays the three legs. The site copy does not say this (AG-019).

**Idempotency.**
- Each split leg and airdrop is a durable ledger row (`driveTxRow`). The ledger moves
  through wallet → built → sent → confirmed and is resumed under an advisory lock.
- Kill/resume at every step, and two concurrent workers, pay each leg once.
- Gaps remain:
  - A crash between the chain claim and the `fee.claimed` append (AG-007).
  - Buyback receipts can be duplicated (AG-005), and their amounts can differ from the
    chain (AG-006).
  - The kill switch also stops fee claims (AG-008).

**Mainnet.**
- Mainnet runs only with `CARBON_NETWORK=mainnet-beta` and `CARBON_MAINNET_ENABLED=true`
  (exact string). `CarbonChainClient` re-checks this when it is constructed.
- The RPC check is a substring match: a mainnet endpoint whose URL lacks "mainnet" is
  accepted as devnet (AG-011).

## Residual risks (accepted or pending)

- **Blocking:** AG-004.
- **Major:** AG-001, 002, 003, 005, 006, 007, 008, 009, 010, 011 and 019.
- **No live verification of external services.** Solana RPC, pump.fun, pumpportal and
  api.x.com are blocked from the build sandbox. Every chain and X behaviour above was
  verified against in-repo doubles, not the live services. In particular, none of these
  has been seen working end to end:
  - native fee-sharing instructions, distribution and claims
  - `buyCarbon` venue routing
  - daughter launches
  - X OAuth and posting

  The doubles follow the SDK and API schemas but were not recorded from live traffic.
- **LLM provider.** Gemini-only is enforced only when `NODE_ENV=production` (AG-013).
- **Single Postgres.** The log, approvals and ledgers all live in one Postgres. Anyone
  with write access there can bypass every guard (AG-012 shows one effect).
- **`@carbon/visual`** was not reviewed in this pass.
