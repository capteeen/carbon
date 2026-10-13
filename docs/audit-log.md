# Audit log

> Historical record, written when the project was called Carbon (renamed Argon on 2026-10-13). Names, isotopes (C-11 to C-14) and figures below are as they were then; SPEC.md and docs/how.md are current.

Adversarial verification by Agent G against SPEC.md §7.

- **First pass** (2026-10-11, `main` at `20b1d03`): AG-001 to AG-026. `@carbon/visual` was out of
  scope.
- **Second pass** (2026-10-11, `main` at `40b7a44`): every first-pass finding re-verified against
  its fix with new adversarial cases (not only the flipped tests), plus the §7 items the first
  pass skipped now that `@carbon/visual` is wired into `apps/web`: scroll sync, frame time, the
  honesty rule in a real browser, and the claims check. New findings are AG-027 to AG-036.

Each finding has a test in `tests/` (package `@carbon/tests`), or is marked "review" when it was
found by reading the code. Open defects are `it.fails(...)` tests carrying their id. Each one fails
today on the assertion that states the requirement, so it flips (and is reported) once fixed. Run
them with `pnpm --filter @carbon/tests test`. The tests use a real local Postgres (`carbon_test`)
and Redis. The browser checks are scripts under `tests/e2e/`, and their results are in
`tests/e2e/results/`.

Severity:
- **blocking** must be fixed before any public launch.
- **major** breaks a SPEC invariant or a user-facing promise.
- **minor** is a correctness or copy issue with limited impact.

## Summary (second pass)

| Status | blocking | major | minor | total |
|---|---|---|---|---|
| fixed | 1 | 11 | 23 | 35 |
| open | 0 | 1 | 0 | 1 |

There is no open blocking finding. The one open major finding (AG-031, frame time on a real phone)
cannot be measured in this sandbox. It is open, not fixed. AG-027 to AG-030 and AG-032 to AG-036
were fixed in the second fix round (commits `757f936` to `f13bff3`).

## Findings

| ID | Severity | Area | Description | Evidence | Status |
|---|---|---|---|---|---|
| AG-004 | blocking | X / approvals | **X account fixation.** Connect was a GET link that bound no wallet, so a victim's X account could be stored under an attacker's launch id. | Fix `a024d0c`: `POST /api/x/connect` needs a fresh, single-use wallet signature, a JSON body and the same origin (`apps/web/src/app/api/x/connect/route.ts:36-62`). The wallet is sealed in the flow cookie and stored with the tokens (`packages/x/src/client.ts:179-256`). `POST /api/launch` keeps the connection only for the same wallet (`apps/web/src/server/x.ts:29-32`), the callback drops a connection that lands after another wallet created the launch (`callback/route.ts:28`), and the worker ignores tokens not bound to the launcher (`client.ts:313-323`). Second pass: the attacker's authorize URL is useless without the attacker's own flow cookie. The victim's callback has no cookie, so the code is never redeemed. Tests: `approvals.test.ts:274,312,332,345`. Residual DoS: AG-036. | **fixed** |
| AG-001 | major | Launch gate | **Stale score passes the chain seam.** | Fix `a024d0c`: `launchAllowedCheck` now also runs `assertLaunchCleared` (`apps/worker/src/chain.ts:31-43`, `packages/agents/src/sentinel/index.ts:161-177`). A draft whose name, ticker, lore or logo hash changed after the score is refused. Test: `launch-gate.test.ts:139`. Residuals (unreachable with one runner per launch): AG-035. | **fixed** |
| AG-002 | major | Launch gate | **Consumed launch approval is reusable.** | Fix `28521dc`: the first build binds the approval to name, symbol, metadata URI, dev buy and payer (`sol_launch_approvals`, PK `approval_id`, `packages/solana/src/db.ts:47`). A rebuild needs identical values and the launch's current approval, under the launch lock (`client.ts:262-299`). Test: `launch-gate.test.ts:148`. Second pass: also refused for another launch's approval and for a superseded approval (review of `checkApprovalBinding`). | **fixed** |
| AG-003 | major | X / approvals | **One post approval, many posts.** | Fix `a024d0c`: the X seam checks the approval is consumed for this launch and action and that the text hash equals the approved card's text. It records one use atomically before the network call (`apps/worker/src/x.ts:48-63`, `carbon_x_approval_uses` PK `approval_id`). A `post` approval cannot be used for a `reply` (the action is in the query). Test: `approvals.test.ts:245`. | **fixed** |
| AG-005 | major | Money / receipts | **Duplicate buyback receipt.** | Fix `28521dc`: `recordBuy` checks the log by txSig and then acks the chain ledger (`packages/agents/src/treasurer/index.ts:291-308`). The bus makes `buyback.executed` once-per-txSig (`ONCE_KEYS`, `packages/core/src/bus/pg-bus.ts:96-116`, checked under the append lock). Test: `money.test.ts:317`. New second-pass test: two processes racing 4× each to append the same buy, claim and snapshot publish exactly one of each, and distinct ones are still recorded (`reverify.test.ts`, "once-only receipts hold across processes"). | **fixed** |
| AG-006 | major | Money / receipts | **Receipt amount differs from the chain.** | Fix `28521dc`: `lamportsIn` is what the confirmed trade spent, from the on-chain trade event (`packages/solana/src/client.ts:732-738`). The Treasurer refuses to write a receipt with a guessed amount (`treasurer/index.ts:296-297`). Test: `money.test.ts:307`. | **fixed** |
| AG-007 | major | Money / receipts | **Claim with no receipt after a crash.** | Fix `28521dc`: `reconcileClaims` receipts every confirmed claim in the durable ledger that has no `fee.claimed` (`treasurer/index.ts:174-199`, `client.ts:460-475`). In native mode, distributions cranked by third parties are found and receipted (`client.ts:481-525`). Test: `money.test.ts:182`. Residuals: AG-033 and AG-034. | **fixed** |
| AG-008 | major | Money / kill switch | **Kill switch stops fee claims.** | Fix `28521dc`: claims, splits, receipts and the completion of an already started buy run before the kill-switch check. Only posts, replies and new buybacks stop (`packages/agents/src/molecule-runner.ts:161-171`). Test: `money.test.ts:219`. | **fixed** |
| AG-009 | major | Bonds display | **Launch scene bonds frozen at the last event.** | Fix `5cc07b0`: display-time bonds on a 1 s timer, starting from the server render time (`apps/web/src/lib/use-events.ts:90-98`, `LaunchLive.tsx`, `EmbedLive.tsx`). Tests: `bonds-display.test.tsx:61,178,189`. Second pass, in the browser (Next production build, `tests/e2e/honesty.ts`): a new signed hand-off reached `/l/[ca]` over SSE as HERALD/KEEPER `BONDS 1/4` in 1.7 s, then aged out to `0/4` 60.9 s after its ts with no further events. Residual: AG-032. | **fixed** |
| AG-010 | major | Bonds display | **Home BONDS readout uses a truncated window.** | Fix `5cc07b0`: home BONDS comes from the active molecule's complete log, which the HUD names, evaluated at display time. `--.--` until the full log is loaded (`apps/web/src/lib/visual-data.ts:87-96`, `server/readmodel.ts:171-177`). Tests: `bonds-display.test.tsx:126,212,230`. | **fixed** |
| AG-011 | major | Mainnet guard | **Mainnet reachable without the two flags.** | Fix `28521dc`: the client checks the RPC's genesis hash against the configured network before any build, send, claim, split, buy, airdrop or ledger read (`packages/solana/src/client.ts:135-157`, `config.ts:157-185`). The genesis hashes match the public clusters. New second-pass tests (`reverify.test.ts`): a URL that says devnet but serves mainnet, testnet or an unknown genesis is refused on 7 money paths before any DB or RPC call. A mainnet config on a devnet genesis is refused. An RPC that cannot answer fails closed and is retried, not cached as passed. | **fixed** |
| AG-019 | major | Claims / money | **"Never holds your 50%" only true in native mode.** | Fix `a024d0c`: how.md describes both modes. `/wallets` shows each launch's mode from its `wallet.created` event (`apps/web/src/components/WalletsView.tsx:43-49`). Test: `claims.test.ts:178`. | **fixed** |
| AG-031 | major | Performance | **≥ 55 fps median on a throttled phone profile is not demonstrated.** The sandbox has no GPU: Chromium rasterises WebGL with SwiftShader on the CPU, so these numbers are a pessimistic proxy, not a phone measurement. Next production build, `/` with a recorded launch, 390×844, 4× CDP CPU throttle (`packages/visual/perf/perf.ts --url`). **Device DPR 2:** median 20.0 fps, p95 frame 183 ms, first frame 2291 ms (SPEC: under 2 s). **DPR 0.3:** median 59.9 fps, p95 frame 49.9 ms, first frame 1789 ms. In both runs the quality ladder fell to its floor (level 7). Heap after forced GC grew about 100 KB per cycle over 8 to 12 cycles. A heap-snapshot diff puts all of it in V8 `code` (JIT), with JS objects flat, so this is not a leak. **The real-phone check is unverified.** It needs a mid-range phone with remote DevTools. | `tests/e2e/results/perf-app-dpr2.json`, `perf-app-dpr0.3-8cycles.json`; `heap-app-dpr0.3-12cycles.json` (from `tests/e2e/heap.ts`) | **open** (unverified; environment) |
| AG-012 | minor | Valence | **Non-monotonic timestamps break the valence cap.** | Fix `28521dc`: a row whose ts is earlier than its predecessor in seq order is ignored (`packages/core/src/bonds.ts:127-138`). Test: `valence.test.ts:147`. New second-pass property test: 400 random logs with forged actors, backdated and future-dated rows and mutual blocks. No agent exceeds 4 at any sampled time, and a shuffled log gives identical bonds (`reverify.test.ts`). A future-dated raw row still hides later hand-offs from the display. That needs DB write access, which is out of scope. | **fixed** |
| AG-013 | minor | Claims / Gemini | **Gemini-only depends on `NODE_ENV`.** | Fix `a024d0c`: the deploy pins `NODE_ENV=production` (`apps/worker/railway.json`). The worker refuses a non-Gemini fallback unless `CARBON_LLM_ALLOW_FALLBACK=true` outside production, and logs the provider, model and fallback reason (`apps/worker/src/llm.ts`). Test: `claims.test.ts:136`. The model id `gemini-3.8-flash` could not be checked against Google's docs from the sandbox (ai.google.dev blocked). | **fixed** |
| AG-014 | minor | Claims / decay | **how.md overstated the decay dependency.** | Fix `a024d0c`: how.md names exactly the five `@qsd/protocol` functions `decay.ts` imports, and says qsd's decay state machine is not used. Tests: `claims.test.ts:77,84`. | **fixed** |
| AG-015 | minor | Molecule fold | **The fold trusted the payload threshold.** | Fix `28521dc`: `packages/core/src/molecule.ts:124-127` uses the config row (`Infinity` without one). Test: `launch-gate.test.ts:223`. | **fixed** |
| AG-016 | minor | Approvals | **Autopilot and kill-switch signatures could be replayed.** | Fix `a024d0c`: the sha256 of the exact signed text is a single-use nonce, recorded after verification (`apps/web/src/server/nonces.ts`, `carbon_signed_nonces` PK). The same applies to X connect. Test: `approvals.test.ts:175`. | **fixed** |
| AG-017 | minor | Decay | **Duplicate holder snapshot after a crash.** | Fix `28521dc`: `holders.snapshot`, `decay.*`, `daughter.launched` and `airdrop.sent` are once-only facts in the bus (`pg-bus.ts:96-104`). Test: `money.test.ts:356`, plus the second-pass race test in `reverify.test.ts`. | **fixed** |
| AG-018 | minor | Mainnet guard | **Config and client disagreed on a padded flag.** | Fix `28521dc`: every reader uses `readNetworkFlags` (exact values) (`packages/solana/src/config.ts:150-155`). Test: `mainnet-guard.test.ts:65`. | **fixed** |
| AG-020 | minor | Claims / chemistry | **DIAMOND copy impossible under valence 4** (contracts.ts). | Fix `a79366f`: "Every agent may bond with every other … (valence 4 still caps its total)". Test: `claims.test.ts:70`. how.md still has the old claim: AG-028. | **fixed** |
| AG-021 | minor | Claims / fees | **Treasurer role copy predated native fee sharing.** | Fix `a79366f`: "Per-launch fee address" (`packages/core/src/contracts.ts:24`). Test: `claims.test.ts:171`. | **fixed** |
| AG-022 | minor | Budgets | **Resumed buyback spent twice.** | Fix `28521dc`: budget spends carry a key (`buyback:<split>:<n>`), unique per launch and kind (`packages/core/src/budgets.ts:114-120`, migration `004_budget_spend_key.sql`). Review, plus `money.test.ts:317`. | **fixed** |
| AG-023 | minor | Events | **`approval.consumed` was never emitted.** | Fix `a024d0c`: `PgApprovals.consume` appends it (`packages/core/src/approvals.ts:186-190`). Test: `approvals.test.ts:359`. The append is not atomic with the consumption: AG-027. | **fixed** |
| AG-024 | minor | Web API | **Check-then-append race in `POST /api/launch`.** | Fix `a024d0c`: unique index `events_one_launch_created` (`apps/worker/src/migrations/002_single_use.sql`), and the route maps 23505 to 409. Test: `approvals.test.ts:370`. | **fixed** |
| AG-025 | minor | Decay | **C-14 clock started at the event, not the chain.** | Fix `28521dc`: `decay.started` uses the create tx's block time (`treasurer/index.ts:136-153`), and the watcher reads `launchBornAtMs` (`packages/solana/src/decay.ts:181`). Review. If the block time is unavailable at deploy, the supervisor falls back to the event ts (`apps/worker/src/supervisor.ts:186-193`), so the displayed `collapseAt` can then differ from the watcher's by the confirmation latency. | **fixed** |
| AG-026 | minor | Claims / UI | **Mislabelled HALF-LIFE readout.** | Fix `a024d0c`/`9e5bfa0`: `DECAY_RULE` (`packages/visual/src/hud/panels.tsx:123`). Test: `claims.test.ts:110`. | **fixed** |
| AG-027 | minor | Events / approvals | **Consumption and its public event are not atomic.** `consume()` commits `status='consumed'` and then appends `approval.consumed` outside that transaction. If the append fails, or the process dies in between, the approval is spent with no public event. The caller gets an error for an approval it can no longer use ("already used"), so a launch or post must be approved again. | Fix `757f936`: `consume()` locks the row (`SELECT … FOR UPDATE NOWAIT`), appends `approval.consumed` while holding it, then commits `status='consumed'` (`packages/core/src/approvals.ts:186-230`). A failed append rolls back, so the approval stays usable. A crash after the append and before the commit is repaired by the next `consume()`, which finds the event, marks the row consumed and refuses a second use. A racing consumer fails at once (`NOWAIT`) instead of holding a pooled connection. Tests: `reverify.test.ts:214` (flipped), `:230` (crash repair), `packages/core/test/approvals.test.ts:42` (race: exactly one wins). | **fixed** |
| AG-028 | minor | Claims / chemistry | **how.md DIAMOND row: "Every agent bonded to every other."** Under valence 4, with five neighbours, this cannot hold at once. AG-020 fixed only contracts.ts. | Fix `668c99c`: the how.md shapes table is now a generated block (`<!-- generated:shapes-table -->`) rendered from `SHAPES[*].description` (`apps/web/src/lib/how-doc.ts:49`). The DIAMOND row reads "Every agent may bond with every other, so each can hold a triple bond (valence 4 still caps its total)…". Tests: `claims.test.ts:99` (flipped), `apps/web/test/how.test.ts:11` (doc block === code). | **fixed** |
| AG-029 | minor | Claims / approvals | **"You approve every launch and post" is unconditional**, but posts autopilot exists (off by default). Sources: the hero manifesto (`packages/visual/src/copy.ts:22`) and the how.md intro. how.md's "What Carbon never does" states it correctly ("or the posts autopilot you turned on"). | Fix `668c99c`: hero manifesto "You approve every launch." / "Posts need your approval unless you turn on posts autopilot (off by default)." (`packages/visual/src/copy.ts:22-23`). The how.md intro and "Approvals and autopilot" section and the site meta description say the same, with replies autopilot named where replies are mentioned. Test: `claims.test.ts:189` (flipped). | **fixed** |
| AG-030 | minor | Claims / chemistry | **Chapter 04 "Every agent holds exactly 4 bonds."** The rule in the code and on /how is *at most* 4, and an idle agent holds 0. The line is a SPEC §5 literal, so changing it is the integrator's call. | Fix `668c99c`: chapter 04 reads "Every agent has exactly 4 bond arms." and the shell line "4 electrons = 4 bond arms (at most 4 bond orders)" (`packages/visual/src/copy.ts:44-45`). Test: `claims.test.ts:106` (flipped). | **fixed** |
| AG-032 | minor | Bonds display | **Display time is the browser clock.** `useNow` switches from the server's `renderedAt` to the browser's `Date.now()` with no offset. On a device whose clock is 90 s fast, bonds disappear early. On a slow clock they persist past 60 s. Either way, what is displayed differs from the log recomputed at true time. The fix is to keep the server offset observed at hydration (`renderedAt − Date.now()`) and add it. | Fix `09a6a45`: the SSE route sends the server clock (`event: server-time`, no `id:`) on connect and as every heartbeat (`packages/core/src/bus/sse.ts:43-50`, `apps/web/src/app/api/events/[launchId]/route.ts:22`). `useNow` returns server time: the device clock plus the offset from the stream sample, or from `renderedAt` at hydration until one arrives (`apps/web/src/lib/server-clock.ts`, `apps/web/src/lib/use-events.ts:78,102`). Tests: `bonds-display.test.tsx:242` (device ±90 s shows exactly `computeBonds` at true time; stream sample wins; SSE frame and wiring). | **fixed** |
| AG-033 | minor | Money / receipts | **Third-party distributions can be skipped.** `scanForeignDistributions` reads at most 10 × 100 signatures per tick and then moves its cursor to the newest. If the sharing-config address appears in more than 1000 transactions between ticks (unverified whether trades reference it), older third-party distributions are never receipted. Native mode pays the legs on chain, so this is a missing receipt, not missing money. | Fix `2d75bdf`: the scan is resumable. When a tick's 10 pages do not reach the last cursor, it stores the scan's head and the oldest signature it fully processed (`foreign_scan_head`, `foreign_scan_before`), and the next tick continues below that. `foreign_scan_until` moves to the head only after every signature between them was read, and never moves on a failed fetch (`packages/solana/src/client.ts:519-575`, `db.ts` migration). Tests: `packages/solana/test/fixes.test.ts:297` (a distribution under 2500 newer signatures is found and the cursor never jumps), `:320` (fetch failure leaves the cursor). | **fixed** |
| AG-034 | minor | Money / receipts | **DIAMOND gates the resume of a claim that already landed.** A claim that crashed after broadcast stays `sent` in the ledger. Only `claimCreatorFees` drives it to confirmed, and on DIAMOND that call sits behind an `action` approval (`gate`, `treasurer/index.ts:219`). `reconcileClaims` reads only confirmed rows. If the launcher rejects or ignores the card, the landed claim has no `fee.claimed` and no split, and in wallet mode the launcher's 50% stays in Carbon's per-launch wallet. | Fix `8ead54f`: `confirmedClaims` first settles claims left `sent` by looking up that exact signature, with nothing built or signed: landed → confirmed, then measured, receipted (`fee.claimed`) and split by `resumeSplits`, which is not behind the DIAMOND gate. Failed or expired → back to pending, so a new claim is still a new, gated action (`packages/solana/src/client.ts:443-470,496`). Tests: `packages/solana/test/fixes.test.ts:337` (no `claimCreatorFees`, no send, split receipted), `:356`. | **fixed** |
| AG-035 | minor | Launch gate | **The score is not bound to the draft it scored.** `sentinel.score` carries no draft id. The gate treats the latest draft before the score's seq as "scored", so only a strictly sequential runner keeps them paired. The supervisor runs one runner per launch, so this is unreachable today. `sameContent` ignores banner, site and logo URIs, and Sentinel's content rules read only the name, ticker and lore: the generated logo image, banner and site are never content-checked. | Fix `5d9cc0a`: `sentinel.score` carries `draftEventId` and `contentHash`, a sha256 over the name, ticker, lore, logoHash and the content-addressed banner and site URIs (`packages/agents/src/sentinel/index.ts:59`). The gate requires both, finds that draft before the score, re-hashes it, and refuses if any later draft differs (`:274-283`). The content rules now also cover the generated site's text (denylist + text classifier) and the logo and banner images, through optional vision on the LLM port (`generateWithImages`, Gemini Interactions image parts and Claude image blocks; `packages/core/src/llm/vision.ts`). The logo classified must hash to the draft's logoHash. No vision, an unreadable image or site, or a classifier error is a hard fail (`:216`). Tests: `packages/agents/test/sentinel.test.ts:154` (6 cases), `packages/core/test/llm.test.ts:126,204`, `apps/worker/test/worker.test.ts:56`. Proposed contract change: add the two fields to `SentinelReport` and `generateWithImages?` to `LlmProvider`. Not verified live: Gemini vision (no key in the sandbox). | **fixed** |
| AG-036 | minor | X / approvals | **A connection can be erased before the launch exists.** `x_tokens` is keyed by launch id, and `finishAuth` upserts. Someone who learns a not-yet-created launch id can complete their own flow for it and overwrite the launcher's bound connection. At creation it is then discarded as bound to another wallet. This is a denial of service, not a takeover. The id lives only in the launcher's browser until creation. | Fix `f13bff3`: `PgTokenStore.put` replaces a row only when it is unbound or bound to the same wallet (`ON CONFLICT … WHERE x_tokens.wallet IS NULL OR x_tokens.wallet = EXCLUDED.wallet`). Otherwise it throws `XConnectionTakenError` (`packages/x/src/store.ts:113`). The launch page moves the draft to a fresh launch id when that happens (`LaunchFlow.tsx`). Tests: `approvals.test.ts:360` (another wallet's completed flow cannot overwrite; the launcher can reconnect; the launch is created with X connected), `packages/x/test/store.pg.test.ts:56`. | **fixed** |

## Second-pass §7 checks (no finding)

- **Scroll sync, in the browser.** Next production build of `apps/web`, 390×844, Chromium
  `/opt/pw-browsers/chromium`, Lenis on (the app default). `tests/e2e/sync.ts` was written
  independently of `perf.ts`. At every sample it compares the 3D chapter (written by the r3f frame
  loop), the HUD chapter (React), every layer's anime.js `onScroll` fade, the ch03 proton, the ch08
  replay counter and the typed CA against the chapter table at the scroll position.
  - **With a recorded launch:** forward grid 201/201, backward grid 201/201, chapter and proton
    boundaries ±0.0015 71/71, random jumps 150/150, reduced motion 102/102.
  - **After a random jump:** every layer agrees again within 1 frame (median 1, p90 1, max 1,
    n=60).
  - **Continuous rAF sweep forward and back without settling:** 307 frames, with 0 frames where the
    3D or HUD chapter disagrees.
  - **Empty log:** the same results (`sync-empty.json`).
  - **`perf.ts --url`:** its own sync check also passes, including Lenis wheel input.
  - Results: `tests/e2e/results/sync-replay.json`, `sync-empty.json`.
- **Honesty rule, in the browser.** `tests/e2e/honesty.ts`, 15/15 pass
  (`tests/e2e/results/honesty.json`).
  - Empty log: chapters 00 to 07 each carry ILLUSTRATED EXPLAINER, ch03 BONDS and LOAD show
    `--.--`, ch05 shows no hashes, ch08 shows the empty state with no "replaying", and ch09 shows
    `No molecules yet. Launch the first one.` with no feed or receipts.
  - Recorded launch:
    - ch08 is labelled `replaying $GPROBE, 2026-10-11` and shows the recorded hand-off hashes in
      order and the real CA.
    - Two independent page loads give identical ch08 HUD text at 21 scroll points.
    - The hand-off counter is monotone in scroll.
  - Stillness: `LaunchScene` with an empty stream renders pixel-identical frames, grain included,
    once the quality ladder has settled. In SwiftShader the ladder steps grain and DPR down during
    the first ~8 s, which changes the frame but is not motion. With recorded events the same scene
    animates.
  - Every live readout on `/l/[ca]` is display-time computeBonds over the real log (see AG-009).
- **Claims against /docs and code.**
  - **Half-lives:** C-11 ≈ 20.4 min (20.36) and C-14 ≈ 5,730 y are correct, and both are labelled
    story, not the coin's lifetime.
  - **Isotopes:** C-12 ≈ 99% and C-13 ≈ 1% are correct. Neutrons are the mass number minus 6.
  - **Footer:** the exact SPEC literal on every page.
  - **Quantum:** "does not run on a quantum computer" holds. `@qsd/quantum` is not a dependency of
    any Carbon package, and how.md says qsd's quantum-measurement decay is not used.
  - **Gemini:** production refuses any other provider (AG-013). The model id was not verifiable
    live.
  - **Fee split:** 5000/3000/2000 bps in contracts, `carbonShares`, how.md and `/wallets`.
  - **Fee modes:** per-launch mode is shown, and the "never holds your 50%" claim is conditional
    on native mode.
  - **Devnet/mainnet:** two exact flags plus the genesis hash (AG-011).
  - Overclaims found: AG-028, AG-029, AG-030.
- **Secrets.**
  - The history of all 36 commits on every ref, plus the tracked files, contains no key-, seed-,
    token- or JWT-shaped value.
  - No `.env` (only `.env.example`, names only), `details/` or key file was ever committed.
  - New in the second pass:
    - The vendored `vendor/qsd-market` submodule's history (56 commits) and its files are scanned
      too. The first pass skipped them because `git show HEAD:vendor/qsd-market` is a gitlink.
      The only 64-byte base58 value there is a public tx signature.
    - No new `console.*` was added to `src/` by the fixes.
    - The Next build output, the server logs and the perf results contain no secret pattern and
      not the run's agent key seed.

## Passed checks (first pass, still holding)

- **Valence.** A 5th bond never forms: not through Handoffs, not through raw bus appends (including a forged actor), not off the topology, and not with 3 concurrent processes plus raw appends.
- **Bond replay.** `Handoffs.bonds(at)` equals `computeBonds(log, at)` every 500 ms across a recorded run. A shuffled replay is identical, and seam hashes verify.
- **Config.** Every isotope × shape row (27 including the C-13 heavy agents) is enforced at runtime: budgets and windows, the Sentinel threshold, the RING 10-minute loop and 60-minute default ticks, and C-14 decay at deploy + 7 days. C-13 changes only the chosen agent.
- **Launch gate.** The launch is refused in all of these cases: no score, a score below threshold, a hard fail, a superseded pass, no approval, a granted-but-unconsumed approval, another action's approval, another launch's approval, and a mismatched dev buy. Launches can never be autopiloted: there is a DB constraint and the route returns 400. DIAMOND autopilot is refused with 409.
- **Approval signatures.** Forged, replayed and non-launcher signatures are rejected. Double grants are refused, and the kill switch revokes grants.
- **Wallet-mode money paths.** Kill/resume of the split is safe at every step (before send, after send, while confirming, twice) and with two concurrent workers. Each leg is paid once, and receipts equal the chain double's transfers. Airdrop kill/resume is idempotent.
- **Mainnet flags.** In the full env matrix, mainnet is reached only with `CARBON_NETWORK=mainnet-beta` and `CARBON_MAINNET_ENABLED=true`. This holds in the solana config, the worker seam, the web display and the browser default.
- **Empty and replayed log.** With an empty real DB, pages show `--.--` and "No molecules yet. Launch the first one." with no invented data, and unknown CAs return 404. SSE on an empty log sends only retry and heartbeat frames. A recorded log folds identically twice, after a JSON round trip and out of order. SSE resume from any Last-Event-ID delivers exactly the tail, and the merged browser view equals the view of the full log.
- **Footer and source hygiene.** The footer is the exact SPEC literal on every page and on the Forge coin site. `src/` has no `Math.random`, faker, lorem, mock data, keyframes or `requestAnimationFrame`, and no test doubles are exported.
