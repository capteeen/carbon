# pump.fun creator-fee research

Researched 2026-10-11 by Agent E (chain), phase 1. Research only; no code was written.

**How this was checked.** The primary sources are pump.fun's own artifacts: the official npm SDKs `@pump-fun/pump-sdk@4.0.0` (published 2026-10-08) and `@pump-fun/pump-swap-sdk@2.1.0` (published 2026-10-07), with their vendored Anchor IDLs (`pump.json`, `pump_amm.json`, `pump_fees.json`), READMEs and sources, plus the `pump-fun/pump-public-docs` GitHub docs. Press coverage is used only for dates and announcements. The sandbox proxy blocked three things: `pump.fun`, `docs.pump.fun` (robots) and the Solana RPC endpoints (`api.mainnet-beta`/`api.devnet.solana.com`). So nothing below was checked against live chain state. The tarball contents were read as data and never executed.

Tags used below: **[verified]** means read in a primary source. **[secondary]** means press or third-party only. **[inferred]** means my reading, not stated anywhere. **[unverified]** means it could not be confirmed here.

---

## 1. Who receives creator fees, where they sit, and how they are claimed

### Default coins (no fee sharing)

**Recipient.** The recipient is the coin's `creator`, stored as `BondingCurve.creator` and, after graduation, as `Pool.coin_creator`. **[verified: IDL]** [S1][S3]

**Bonding curve (pump program `6EF8…F6P`).**
- Fees accrue in the creator-vault PDA, `["creator-vault", creator]`, owned by the pump program. SOL-quoted coins hold lamports there. Token-quoted coins hold them in that PDA's ATA for the quote mint. **[verified: IDL]** [S1]
- They are claimed with `collect_creator_fee` (SOL) or `collect_creator_fee_v2` (any quote mint).
- **Neither instruction has a signer.** The `creator` account is writable but not a signer, so the claim is **permissionless**: anyone can crank it. **[verified: IDL accounts]** [S1][S5]
- The funds can only go to the `creator` wallet: lamports go to it directly, and tokens go to the creator's ATA. A claim cannot send them anywhere else. **[verified]** [S1][S5]

**PumpSwap AMM (`pAMMBay6…EXEA`).**
- Fees accrue in the ATA, for the quote mint, of the PDA `coin_creator_vault_authority = ["creator_vault", coin_creator]`. Note the underscore: this seed differs from the pump program's `creator-vault`. **[verified]** [S2][S5]
- They are claimed with `collect_coin_creator_fee`, which also has no signer and so is permissionless.
- The destination is `coin_creator_token_account`. The SDK defaults it to the creator's ATA. A custom destination must be "any token account the creator owns". **[verified]** [S2][S8]
- The SDK unwraps wSOL only when the creator is also the payer. **[verified: README]** [S8]

**New since `pump-sdk` 3.x (published 2026-10-07): v3 trades.**
- With `buy_v3`/`sell_v3` and pump-amm `buy_v2`/`sell_v2`, the creator fee stays in a bucket on the curve or pool (`BondingCurve.creatorFee`) until someone calls the permissionless `sweep_creator_fee`. That instruction is on both pump and pump-amm. **[verified: README]** [S6]
- Until the sweep runs, creator-vault balances do not show those fees.
- An unswept bucket blocks `distribute_creator_fees*`, `admin_cto` and fee-share updates. The errors are pump 6095, pump-amm 6081 and pump-fees 6033. **[verified]** [S6]
- Whether v3 is already live on mainnet or devnet program deployments is **[unverified]**. The SDK says it "tracks pump-programs-monorepo PR #60/#61".

### Fee-shared coins (see §3)

- Running `create_fee_sharing_config` sets the coin's creator to the `sharing_config` PDA, `["sharing-config", mint]` on pump-fees. This applies to the curve and, when the coin has graduated, to the pool. **[verified]** [S4]
- Fees then accrue in `creator-vault(sharing_config)`.
- `collect_creator_fee*` and `collect_coin_creator_fee` **fail** for such coins, because they check that the creator is not owned by pump-fees. **[verified]** [S5]
- Payout runs in two steps, both permissionless:
  1. `transfer_creator_fees_to_pump(_v2)` moves the AMM vault into the pump creator vault.
  2. `distribute_creator_fees(_v2)` pays the shareholders by `share_bps`.
- In `distribute_creator_fees(_v2)`, SOL goes as lamports straight to each shareholder. Tokens go to each shareholder's ATA, and with `initialize_ata=true` the payer covers any missing ATA. **[verified]** [S4][S1]

### Other variants

- **Holder-reward coins** (`create_v2` with `is_holder_reward`).
  - The creator becomes `holderRewardsPda(mint)` permanently, and fees go to holders through `distribute_fee_to_holders`.
  - Only `Global.holderRewardClaimAuthority`, which is pump.fun-controlled, can sign that payout. **[verified]** [S6]
- **Cashback coins** (creator fee paid to traders) launched 2026-02-17 [S13] and are now **deprecated for new coins**: `create_v2` rejects them with error 6082. Existing cashback coins keep working. **[verified]** [S6]

### Admin override: `admin_cto`

- `admin_cto` is signed by `Global.adminSetCreatorAuthority`, a pump.fun-controlled key.
- It can reassign the creator of any non-mayhem coin, and for a fee-shared coin it rewrites the `SharingConfig` to the new creator at 100%.
- Since the 2026-10 SDK it has replaced `admin_set_creator`, `admin_set_creator_fee_editable`, `set_creator_fee_bps` and `reset_fee_sharing_config*`. **[verified]** [S6]
- pump.fun can therefore always redirect creator fees, for example after a community takeover (CTO). This is a trust assumption Carbon cannot remove.

## 2. Fee percentages (current)

Fees come from the pump-fees `FeeConfig` and are selected by quote mint: SOL-like quotes use `feeTiers` by market cap, USDC uses `stableFeeTiers`, and any other quote uses `exoticFlatFees`. **[verified]** [S6][S8]

### PumpSwap AMM, canonical pump pools, SOL quote

These figures come from the live mainnet pump-amm `FeeConfig` (`5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`). The SDK ships a golden fixture of that account, captured 2026-09-08 at slot 445186127. **[verified: fixture in pump-swap-sdk 2.1.0]** [S7]

| Market cap ≥ (SOL) | LP bps | Protocol bps | Creator bps | Total |
|---|---|---|---|---|
| 0 | 2 | 93 | 30 | 1.25% |
| 420 | 20 | 5 | 95 | 1.20% |
| 1,470 | 20 | 5 | 90 | 1.15% |
| 2,460 / 3,440 / 4,420 | 20 | 5 | 85 / 80 / 75 | |
| 9,820 → 49,120 (~4,900 SOL steps) | 20 | 5 | 70 → 30 (−5 per step) | |
| 54,030 → 93,330 | 20 | 5 | 28, 25, 23, 20, 18, 15, 13, 10, 8 | |
| 98,240 | 20 | 5 | 5 | 0.30% |

- Flat fees for non-canonical pools are 25 LP / 5 protocol / 0 creator.
- USDC pools use the same bps, with thresholds in USDC running from $59k to $20M.

### Bonding curve

- The curve reads the pump program's own fee config, PDA `["fee_config", pump_program_id]` on pump-fees. I could not read that account because RPC was blocked.
- A secondary source gives 0.95% protocol + 0.30% creator = 1.25%, with no LP. **[secondary]** [S12]
- The AMM tier-0 row (2/93/30, also 1.25% total) is consistent with that. **[inferred]**
- Treat the curve's creator rate as **0.30%** and confirm it against chain state.

### History

- Project Ascend / "Dynamic Fees V1" shipped 2025-09-03. It introduced a creator rate of up to 0.95% that tapers to 0.05% at about a $20M market cap. [S10][S11]
- The 2026-01-09 update added fee sharing and admin controls. [S9][S14]
- Per-coin `creator_fee_bps` exists only for quote-control (exotic) quotes. On SOL and USDC coins the value is ignored. **[verified]** [S6]

## 3. Native fee sharing: yes, it exists

**Program and announcement.**
- It lives in the **pump-fees program, `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`**. **[verified]** [S1][S4][S6]
- It was announced 2026-01-09: "split creator fees across up to 10 wallets", set after launch, available to creators and CTO admins. [S9][S14]

**Instructions.**

| Step | Instruction | Signer | Notes |
|---|---|---|---|
| 1 | `create_fee_sharing_config` | `payer`, which must be the current coin creator or the pump.fun `admin_set_creator_authority` [S4] | Creates `SharingConfig` (`["sharing-config", mint]`) with shareholders `[(creator, 10000)]`. Migrates the creator on the curve, and on the pool if the coin has graduated, to the PDA. A second call is a no-op. |
| 2 | `update_fee_shares` (SOL) / `update_fee_shares_v2` (token quote) | `authority` = `sharing_config.admin` | Arg `Vec<Shareholder{address: Pubkey, share_bps: u16}>`. Distributes pending fees to the old shareholders first, so any curve or pool bucket must be swept first. |
| 3 | `transfer_creator_fees_to_pump(_v2)` (pump-amm) | none (permissionless) | Graduated coins only. Skips if the balance is below ATA rent. |
| 4 | `distribute_creator_fees(_v2)` (pump) | none (permissionless) | Needs the vault to hold at least `get_minimum_distributable_fee`. Remaining accounts must match the shareholders in order. |

The SDK's `buildDistributeCreatorFeesInstructions` builds steps 3 and 4, plus any sweeps. [S6]

**Limits.** **[verified: IDL errors + SDK]**
- 1 to 10 shareholders (`MAX_SHAREHOLDERS = 10`).
- No duplicates and no zero shares.
- Shares must sum to exactly 10,000 bps.
- `SharingConfig` is at most 1,024 bytes.

**Set when, and changeable?**
- It is not part of `create`/`create_v2`, whose arguments contain no shareholder list. It is set after create, which can be in the same transaction **[inferred]**.
- Since 2026-03-25 (the "One-Time Creator Reward Distribution Policy"), the split **can be set only once**. `update_fee_shares` sets `admin_revoked = true`, and further calls fail with `FeeSharesAlreadyUpdated` (6024) or `SharingConfigAdminRevoked` (6009). Configs created before the policy are treated as locked. **[verified: SDK README + IDL]** [S6][S13]
- `revoke_fee_sharing_authority` and `transfer_fee_sharing_authority` are deprecated: their IDL entries now have no accounts and no args.
- The only way to change a locked split is pump.fun's `admin_cto`.

**Social recipients.**
- A shareholder can be a GitHub user's social-fee PDA (`create_social_fee_pda`, claimed only through the pump.fun app). Carbon does not need this.
- GitHub organisations are not supported, and fees sent to one can be lost. **[verified]** [S6]

**Devnet.**
- The SDK README examples connect to `api.devnet.solana.com`.
- The pump-swap-sdk README refers to "the devnet pump program".
- npm carries `devnet` dist-tags: `@pump-fun/pump-sdk@1.31.0-devnet.2` (2026-03-24) and `@pump-fun/pump-swap-sdk@1.18.0-devnet.1` (2026-06-23).
- pump-sdk devnet builds were published on 2026-01-09, the fee-sharing launch day.
- My conclusion is that pump, pump-amm and pump-fees are deployed on devnet under the same program ids, with fee sharing available. **[inferred]**
- That devnet currently runs the one-time-lock, v3 and holder-reward versions is **[unverified]**. The swap README notes that some fee-program features reach devnet later ("once the quote-control fee program is deployed there").

## 4. Can the creator differ from the payer/signer?

**Yes.** **[verified: IDL]** [S1][S3]
- `create` and `create_v2` take `creator: Pubkey` as an **instruction argument**. The signers are `mint` and `user`, and `user` is the payer.
- The only documented constraint on `creator` is that it is not `Pubkey::default()`. [S3]
- The official SDK examples pass different `creator` and `user` keys. [S6]
- So the user's wallet can sign and pay while a per-launch server wallet is the creator, and that wallet does not need to sign `create`.

**Caveats.**
- If fee sharing is used, `create_fee_sharing_config` must be paid and signed by the **creator** [S4]. A per-launch server creator would then have to co-sign that instruction and pay the config rent. Alternatively the user's wallet can be the creator.
- PumpPortal's `trade-local` `create` takes one `publicKey`. Whether it accepts a different creator is **[unverified]** and probably not. **[inferred]**

## 5. Program ids, devnet, IDLs, SDKs

| Program | Id | Mainnet | Devnet |
|---|---|---|---|
| pump (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | yes [S1][S15] | yes [inferred from SDK devnet usage, S6][S8]; not checked on RPC |
| pump-amm (PumpSwap) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | yes [S2][S15] | yes [inferred]; devnet USDC whitelisted per [S8] |
| pump-fees (fees + sharing) | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | yes [S4][S15] | probably [inferred] |
| mayhem | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` | (SDK constant) | |

**IDLs.**
- They are vendored in `@pump-fun/pump-sdk/src/idl/{pump,pump_amm,pump_fees}.json`.
- `github.com/pump-fun/pump-public-docs` has an `idl/` folder and per-instruction docs: COIN_CREATION, COLLECT_CREATOR_FEE, CREATOR_FEE_SHARING, FEE_PROGRAM_README and others. [S3][S4][S5][S16]

**npm versions** (`npm view`, 2026-10-11):
- `@pump-fun/pump-sdk`: **4.0.0** (2026-10-08T12:53Z). Preceded by 3.0.0 to 3.2.0 on 2026-10-07 and 2.0.0 on 2026-09-13. dist-tag `devnet` = 1.31.0-devnet.2.
- `@pump-fun/pump-swap-sdk`: **2.1.0** (2026-10-07T19:49Z). Preceded by 2.0.0 on 2026-10-07 and 1.20.0 on 2026-09-10. dist-tag `devnet` = 1.18.0-devnet.1.
- Both are published by `security-baton` (Baton Corporation, pump.fun's company), MIT licence.
- Three major versions in five weeks: pin exact versions.

## 6. Metadata upload and PumpPortal

**pump.fun IPFS endpoint.**
- PumpPortal's creation docs now say the old `https://pump.fun/api/ipfs` endpoint "is no longer supported" and that pump.fun no longer accepts direct metadata uploads. [S17]
- I could not test this, because `pump.fun` is blocked by the proxy. **[unverified from a pump.fun source]**
- **Use your own IPFS pinning** instead. PumpPortal's examples use Pinata: `POST https://uploads.pinata.cloud/v3/files` with `network=public`, first for the image and then for the metadata JSON (`name`, `symbol`, `image`, `description`, `twitter`, `telegram`, `website`). The resulting URI has the form `https://ipfs.io/ipfs/<cid>`.
- The `uri` must be at most 200 characters. [S3]

**PumpPortal Local Transaction API** (third party, not pump.fun).
- Call `POST https://pumpportal.fun/api/trade-local` with `{publicKey, action:"create", tokenMetadata:{name,symbol,uri}, mint, denominatedInSol, amount, slippage, priorityFee, pool:"pump"}`. It returns a serialized `VersionedTransaction`, which you sign with the mint keypair and the wallet. [S17]

Caveats:
- **0.5% fee per Local trade** (Lightning is 1%); creation itself is free. [S18]
- No documented devnet support.
- No way to set fee sharing or a creator different from the signer is documented.
- It is an opaque, server-built transaction, so Carbon would have to decode and verify it before asking the user to sign.
- It lags program upgrades. **[inferred]**
- `collectCreatorFee` is available ("pump.fun claims creator fees all at once"), but fee-sharing coins are not mentioned. [S19]

**Recommendation.** Build transactions with the official `@pump-fun/pump-sdk`. Use PumpPortal only as a reference.

## 7. Recommendation for Carbon

**Recommended: use native fee sharing for the 50/30/20 split, set atomically in the launch transaction.** Keep the default design as a fallback, used if the devnet spike in step 1 below fails.

### Launch transaction

1. Treasurer builds the transaction server-side. The mint keypair is generated server-side and **partially signs first**, so any change the client makes invalidates the transaction.
2. The transaction contains, in order:
   1. `create_v2(creator = C)`
   2. `create_fee_sharing_config` (payer = C)
   3. `update_fee_shares([launcher 5000, Carbon buyback wallet 3000, Carbon treasury 2000])`
   4. the dev buy
3. The user's wallet signs and pays.
4. The same-transaction ordering is **[inferred]** and must be proven on devnet first. It may need a v0 transaction with a lookup table because of the account count.

### Choosing C

- **C = the user's wallet** is simplest. The user signs everything, and Carbon then holds **no per-launch keys at all**. Once the split is locked, the user cannot change it; only pump.fun's `admin_cto` could.
- **C = a per-launch server wallet** (the SPEC default) also works. That wallet must co-sign and pay the `sharing_config` rent. After this step the creator becomes the `sharing_config` PDA, so the wallet has no further role.
- **I recommend C = user wallet.** It fits "the user's wallet signs and pays" and "Carbon never holds YOUR keys". On `/wallets`, list the `sharing_config` PDA and the two Carbon wallets.

### Trade-offs

**Trust**
- *Native sharing:* pump.fun pays the launcher's 50% directly, so Carbon never holds launcher money. The split is enforced on-chain and locked (one-time policy). The remaining risk is pump.fun's `admin_cto`, which can override it.
- *Default design:* Carbon holds 100% of the fees in server wallets until it splits them, so key custody becomes the main risk.

**Receipts**
- *Native sharing:* `DistributeCreatorFeesEvent`/`TradeEvent` logs plus the transaction signature form a public, chain-native receipt.
- *Default design:* Carbon composes receipts from its own transfers.

**Idempotency**
- *Native sharing:* one `distribute_creator_fees` is atomic, so a crash cannot double-pay. Re-running it pays only new fees.
- *Default design:* needs a durable split ledger and claim→split state machine, because a crash between claim and split is the exact double-pay risk Agent G tests.

**Devnet**
- *Native sharing:* likely available, but **unverified**; spike it first.
- *Default design:* only the basic claim is needed, which has been on devnet since 2025.

**Rigidity**
- *Native sharing:* the 50/30/20 split is permanent per coin. Changing the split policy later affects only new launches.
- *Default design:* the split can be changed at any time, which is also a trust cost.

**Minimum payout**
- *Native sharing:* distribute needs a minimum vault balance (`get_minimum_distributable_fee`).
- *Default design:* no minimum.

**Treasurer still has to:**
1. Run a scheduled crank per coin: sweep any curve/pool buckets (v3), then `transfer_creator_fees_to_pump` (if graduated), then `distribute_creator_fees`, all permissionless with Carbon as fee payer. Each `DistributeCreatorFeesEvent` becomes a receipt.
2. Buy $CARBON with the SOL that lands in the buyback wallet. This remains a Carbon-side, idempotent step: track consumed balance per receipt, so a buyback is keyed to the distribution signature.
3. Watch for `AdminCtoEvent` on Carbon's coins and surface any CTO on `/l/[ca]`.
4. Keep `/receipts` and `/wallets` in sync.

**Fallback.** If fee sharing is unavailable on devnet, or the same-transaction setup fails, use the SPEC default:
- a per-launch creator wallet as `creator`;
- permissionless `collect_creator_fee*` and `collect_coin_creator_fee` (sweep first);
- then Carbon executes the 50/30/20 split with a persisted ledger.

Two points apply to both paths: do not use cashback (deprecated) or holder-reward (pays holders, not Carbon), and pin the SDK versions.

### Open checks before building Treasurer (devnet spike)

1. Program accounts for `6EF8…`, `pAMM…` and `pfee…` exist on devnet, and devnet `Global`/`FeeConfig` decode with SDK 4.0.0.
2. `create_v2` + `create_fee_sharing_config` + `update_fee_shares` + buy work in one transaction, within the size and compute limits.
3. A second `update_fee_shares` fails (lock confirmed).
4. Whether v3 trades are live: if so, the sweep is required before distribute.
5. The bonding-curve creator bps read from the pump `fee_config` PDA.

---

## Sources

All sources were accessed 2026-10-11.

| # | Source | Publish / version date | Used for |
|---|---|---|---|
| S1 | `@pump-fun/pump-sdk@4.0.0` tarball, `src/idl/pump.json`, `pump_fees.json` (https://www.npmjs.com/package/@pump-fun/pump-sdk) | 2026-10-08 | Instructions, accounts, signers, PDA seeds, errors, program ids |
| S2 | `@pump-fun/pump-sdk@4.0.0` `src/idl/pump_amm.json` | 2026-10-08 | `collect_coin_creator_fee`, `transfer_creator_fees_to_pump` |
| S3 | https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md | undated (repo, 2026) | `create_v2` args, `creator` ≠ default, uri ≤ 200 |
| S4 | https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md | undated (repo, 2026) | Fee-sharing lifecycle, signers, limits, once-only update |
| S5 | https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md | undated (repo, 2026) | Permissionless claims, vault PDAs, fail for sharing coins |
| S6 | `@pump-fun/pump-sdk@4.0.0` README.md and `src/sdk.ts`, `src/fees.ts` | 2026-10-08 | v3 sweeps, `admin_cto`, cashback deprecated, holder rewards, one-time policy, `MAX_SHAREHOLDERS = 10`, `isSharingConfigEditable` |
| S7 | `@pump-fun/pump-swap-sdk@2.1.0` `src/__tests__/feeConfigMainnetFixture.ts` (https://www.npmjs.com/package/@pump-fun/pump-swap-sdk) | 2026-10-07 (data captured 2026-09-08) | Mainnet AMM fee tiers |
| S8 | `@pump-fun/pump-swap-sdk@2.1.0` README.md | 2026-10-07 | AMM creator fees, fee schedule by quote mint, devnet pump program note |
| S9 | https://www.theblock.co/amp/post/384975/pump-fun-overhauls-creator-fees-token-launches-highest-daily-september | 2026-01-09 | Fee sharing up to 10 wallets, post-launch, CTO admins |
| S10 | https://blockworks.com/news/pumpdotfun-fee-model | 2025-09-03 | Dynamic fees 0.95% → 0.05% |
| S11 | https://decrypt.co/337872/pump-funs-new-fee-model-hands-out-2m-to-creators-in-first-24-hours | 2025-09-03 | Project Ascend creator tiers |
| S12 | https://blofin.com/academy/education/pumpfun/pump-fun-creator-fees-explained | 2026-09-28 | Curve 0.95% protocol + 0.30% creator (secondary) |
| S13 | https://cointelegraph.com/news/pump-fun-creator-fee-cap-update-memecoin-model | 2026-03-25 | One-time redirect lock; cashback launched 2026-02-17 |
| S14 | https://cointelegraph.com/news/pumpfun-revamps-creator-fees-fee-sharing-cto-controls | ~2026-01-09 (no explicit date on page) | Fee sharing, up to 10 wallets |
| S15 | https://docs.solanatracker.io/guides/pumpfun-program.md | undated | Mainnet program ids (third party) |
| S16 | https://github.com/pump-fun/pump-public-docs | undated (2026) | Doc index, IDL folder |
| S17 | https://pumpportal.fun/creation | undated | trade-local create, pump.fun/api/ipfs deprecated, Pinata |
| S18 | https://pumpportal.fun/fees | undated | 0.5% Local / 1% Lightning |
| S19 | https://pumpportal.fun/creator-fee | undated | `collectCreatorFee` action |
| S20 | `npm view @pump-fun/pump-sdk` / `@pump-fun/pump-swap-sdk` `version time dist-tags` | run 2026-10-11 | Versions, publish times, devnet tags |

**Not verified from a primary source:**
- devnet deployment state of the three programs, and whether devnet runs the current versions (RPC blocked);
- the exact bonding-curve fee bps (pump `fee_config` not readable);
- `pump.fun/api/ipfs` deprecation (pump.fun blocked; from PumpPortal only);
- whether v3 trades are live on mainnet;
- same-transaction create + sharing-config + update;
- that `sharing_config.admin` equals the creator who created it;
- PumpPortal support for a creator different from the signer.

---

## Integrator review (2026-10-11)

Reviewed against SPEC §2. Decision:

- **Primary design: native pump.fun fee sharing**, set once and atomically in the
  launch transaction, `creator = the launcher's wallet`, shares launcher 5000 /
  Carbon buyback wallet 3000 / Carbon treasury 2000 bps. This is the "cleaner
  native option" SPEC §2 allows: Carbon never holds the launcher's 50% or any
  per-launch key, the split is enforced and locked on-chain, and each
  `distribute_creator_fees` is atomic (no double payment by construction).
  The per-launch address shown on `/wallets` is the coin's `sharing-config` PDA
  (the on-chain fee recipient), alongside the two Carbon wallets.
- **Fallback: the SPEC default design** (per-launch server creator wallet,
  encrypted at rest, permissionless collect, ledger-driven idempotent 50/30/20
  split), selected by `CARBON_FEE_MODE=wallet`. Built and tested too, because
  the native path is unverified on devnet.
- Treasurer's remaining money paths in both modes: the scheduled crank, the
  idempotent $CARBON buyback keyed to the distribution/split signature, and
  receipts. It trades nothing else except the launch's own dev buy.
- **Blocking before mainnet:** the five devnet checks above. They cannot run
  from the build sandbox (Solana RPC and pump.fun are blocked); they are an
  open item until the network is opened.
- No PumpPortal: official `@pump-fun/pump-sdk` / `@pump-fun/pump-swap-sdk`,
  exact pinned versions. Metadata to self-hosted IPFS (Pinata), uri ≤ 200 chars.
