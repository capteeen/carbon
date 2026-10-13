# Carbon build report

> Historical record, written when the project was called Carbon (renamed Argon on 2026-10-13). Names, isotopes (C-11 to C-14) and figures below are as they were then; SPEC.md and docs/how.md are current.

2026-10-11 · integrator report for SPEC.md §8 · repo `capteeen/carbon`, branch `main`

## Bottom line

All of SPEC §4 is built and integrated:

- core, agents, visual, x and solana packages
- the web app and the worker
- the verification suite

`pnpm -r test` passes: 719 tests, including the 147 adversarial tests. The adversarial verifier found 36 findings over two passes:

- 35 are fixed and re-verified.
- AG-031 (frame time on a real phone) is the one open item. It is not blocking.

The §8 phone recording **has not been made**. The build sandbox's network policy blocks:

- Solana devnet RPC
- pump.fun
- api.x.com
- Google's docs

No real devnet coin, X post or fee split could happen. None was faked.

## What works (verified here)

**Chemistry is enforced in code.**

- Valence is limited to 4, with visible queueing. A fifth bond is impossible:
  - through hand-offs
  - through raw appends
  - with forged actors
  - with backdated rows
  - with concurrent processes

  A property test over 400 random logs confirms this.
- Bond orders come from a rolling 60-second window: single, double, triple, or triple through a mutual block.
- Every hand-off is a signed ed25519 message, and its hash rides the seam.
- The displayed bonds come from the same `computeBonds` function the server uses, evaluated at server-corrected display time. Bonds age out live; this was checked in a real browser.

**The config table and Sentinel.**

- There is one config table (`packages/core/src/contracts.ts`), and `/how` renders it from the code.
- All 12 isotope × shape rows apply at runtime: budgets, cadence, threshold and decay.
- C-13 doubles capacity for the chosen agent only.
- Sentinel scores six public inputs. If any input can't be measured, it scores 0.
- Content rules cover the text, logo and banner. Content and impersonation are hard fails.
- A score is bound to the exact draft it scored.

**Approvals.**

- Every launch and post needs a one-tap approval signed by the launcher's wallet. Approvals are single-use and bound to the approved text.
- Autopilot is off by default and set per class. It is never available for launches or on DIAMOND. The kill switch also stops the agents.
- X uses OAuth 2.0 PKCE, bound to the launcher's wallet. No code anywhere creates accounts.

**Money.**

- Every money movement produces a receipt event.
- The split, buyback, claim and airdrop ledgers are idempotent: if a run is killed and resumed, each leg is paid exactly once.
- Distributions cranked by a third party still get receipts.
- The Treasurer's instruction allowlist only permits $CARBON buybacks and the launch's own dev buy.

**Network safety.** Devnet is the default. Mainnet needs both `CARBON_NETWORK=mainnet-beta` and `CARBON_MAINNET_ENABLED=true`, and the RPC's genesis hash must also match.

**Live-only data.**

- There is no sample data anywhere.
- Empty states read exactly `--.--` and "No molecules yet. Launch the first one."
- Chapters 00–07 are an illustrated explainer with no live values. The owner had the on-screen illustration badge and note removed (2026-10-11).
- Chapter 08 replays only a real recorded launch.
- The same recorded log replays identically.

**Scroll story.**

- One pinned canvas, with Lenis, anime.js v4 and react-three-fiber all reading one progress value.
- In the browser, the 3D scene, HUD and labels agreed at every one of 1,000+ sampled points: forward, backward, random jumps and reduced motion.

**Secrets.** No keys, seeds or tokens in the code, the full git history, the vendored submodule, logs or build output.

## Devnet-only, unverified live

These have only been tested against in-repo test doubles:

- pump.fun create + native fee sharing in one transaction
- claims and the distribution crank
- the split
- $CARBON buybacks
- holder snapshots
- daughter launches and airdrops
- X OAuth and posting
- Gemini text, grounding, image generation and vision

`pnpm --filter @carbon/solana devnet-spike` runs the five open devnet checks from docs/fees-research.md once the network is open.

## Fees research (docs/fees-research.md)

pump.fun has native fee sharing in the `pfee…` program: 1–10 recipients, set once and then locked. Carbon uses it as the primary design.

- The launcher's wallet is the coin's creator. One transaction does `create_v2` → `create_fee_sharing_config` → `update_fee_shares`, with the launcher at 50%, the $CARBON buyback wallet at 30% and the treasury at 20%, followed by the dev buy.
- pump.fun pays each leg on-chain, so Carbon holds no per-launch keys and never touches the launcher's 50%.
- The SPEC's default design, a per-launch server wallet with a ledger split, is the fallback: `CARBON_FEE_MODE=wallet`.

Caveats:

- Devnet availability of fee sharing is inferred from the SDKs, not observed.
- pump.fun's `admin_cto` key can still override a coin's split.
- PumpPortal is not used.

## Agent G open findings

**AG-031 (major, environmental).** The SPEC target is ≥55 fps median on a throttled phone. With no GPU in the sandbox (CPU rendering), the production build at 390x844 with 4x throttle measured:

| Device pixel ratio | Median fps | First frame |
| --- | --- | --- |
| 2 | 20 | 2.3 s |
| 0.3 | 59.9 | 1.8 s |

The quality ladder works, and there is no JS heap leak. This needs a measurement on a real mid-range phone.

Also noted: one test in the vendored `@qsd/quantum` package (upstream, not Carbon code) failed once in four runs.

## Env vars

- **Worker (Railway):**
  - `NODE_ENV=production`
  - `DATABASE_URL`
  - `REDIS_URL`
  - `CARBON_AGENT_KEY_SEED`
  - `GEMINI_API_KEY`
  - `CARBON_LLM_MODEL` (optional)
  - `CARBON_LLM_IMAGE_MODEL` (optional)
  - `CARBON_RPC_URL`
  - `CARBON_NETWORK`
  - `CARBON_MAINNET_ENABLED`
  - `CARBON_FEE_MODE`
  - `CARBON_MINT` ($CARBON)
  - `CARBON_BUYBACK_WALLET`
  - `CARBON_BUYBACK_KEY`
  - `CARBON_TREASURY_WALLET`
  - `CARBON_CRANK_KEY`
  - `CARBON_VAULT_KEY`
  - `CARBON_LOOKUP_TABLE`
  - `CARBON_PRIORITY_FEE_MICROLAMPORTS`
  - `PINATA_JWT`
  - `CARBON_IPFS_GATEWAY`
  - `PUMP_FRONTEND_API_URL`
  - `X_CLIENT_ID`
  - `X_CLIENT_SECRET`
  - `X_REDIRECT_URI`
  - `X_BEARER_TOKEN`
  - `CARBON_TOKEN_KEY`
  - `CARBON_PUBLIC_URL`
- **Web (Vercel):**
  - `DATABASE_URL`
  - `REDIS_URL`
  - `CARBON_AGENT_KEY_SEED`
  - `CARBON_TOKEN_KEY`
  - the `X_*` vars
  - `NEXT_PUBLIC_SITE_URL`
  - `NEXT_PUBLIC_SOLANA_RPC_URL`
  - `CARBON_NETWORK`
  - `CARBON_MAINNET_ENABLED`
- **Mainnet:** `CARBON_NETWORK=mainnet-beta` and `CARBON_MAINNET_ENABLED=true` on both services, plus a mainnet `CARBON_RPC_URL`. You also need:
  - a mainnet `CARBON_MINT`
  - funded buyback and crank keys
  - a mainnet lookup table, made by `devnet-spike` on mainnet
- **Keys:** `pnpm --filter @carbon/solana generate-keys -- --out <path outside repo>` prints only public keys.

## Cost per launch

The launcher pays:

- The dev buy from the config row:
  - C-11: 0.05 / 0.125 / 0.25 SOL (chain / ring / diamond)
  - C-12, C-13 and C-14: 0.1 / 0.25 / 0.5 SOL
- Account rent for the mint, curve, metadata and sharing config, plus transaction fees. This is **not measured yet**; the devnet spike reports it.

Carbon pays:

- The distribution crank's transaction fees.
- On C-11 and C-14, the daughter coin's creation and the airdrops.
- Gemini usage. A launch makes about 4–6 text calls, 2 image generations and 1 vision check, plus 1 text call per post or reply. Pricing was not checked, because Google's pages were blocked.
