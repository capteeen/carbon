# How Carbon works

Carbon is a pump.fun launchpad run by a molecule of six AI agents. You connect
your Solana wallet (and, if you want, your project's X account), type one line,
pick an isotope and a shape, and the agents research, create, check and launch
a coin. You approve the launch and every post.

Carbon is element 6 because it has 6 protons. Carbon has 6 agents.

## The six protons

| Proton | Agent | Role |
|---|---|---|
| PROTON_01 | SCOUT | Finds live trends on X, proposes 3-5 narratives and names |
| PROTON_02 | FORGE | Creates the coin: name, ticker, lore, logo, banner, site; prepares the pump.fun deploy |
| PROTON_03 | HERALD | Drafts posts and, after approval, posts from your connected X account |
| PROTON_04 | KEEPER | Community: replies, holder milestones, recruiting drafts |
| PROTON_05 | TREASURER | The launch's fee address, fee claims, the 50/30/20 split, $CARBON buybacks, public receipts |
| PROTON_06 | SENTINEL | Risk checks; computes the stability score; can block a launch |

## Valence

Every agent has valence 4: it holds at most 4 bond orders at once. A hand-off
that would give an agent a fifth is queued (a `handoff.queued` event) until a
bond frees up. Valence is not configurable.

## Bonds

A bond is real traffic between two agents on the event bus. Every hand-off is
a signed event: its id is the sha256 of its canonical JSON, signed with the
sending agent's ed25519 key. The first 8 characters of the id are the hash
shown on the bond.

The order of a bond comes from hand-offs between the pair in the last 60
seconds:

| Order | Rule |
|---|---|
| Single | 1 hand-off |
| Double | 3 or more exchanges |
| Triple | 8 or more exchanges, or both agents blocked on each other |

The bond order on screen is always recomputed from the log, never stored.
Hand-offs are only allowed along the bonds of the launch's shape.

## Isotopes

Isotopes differ only in neutrons, so each isotope is a different agent
configuration.

| Isotope | Neutrons | Name | Behaviour |
|---|---|---|---|
| C-11 | 5 | FLASH | Small budget (half of the shape's base), fast meme. Unstable: decays to a daughter after 20 minutes with no trades. |
| C-12 | 6 | CORE | Balanced and stable. The default. |
| C-13 | 7 | HEAVY | Stable. The extra neutron doubles the capacity of one agent you choose. No other agent changes. |
| C-14 | 8 | RADIOACTIVE | Decays to a daughter on a visible 7-day clock. Trades do not reset it. |

The isotope names are the story, not a promise. Real carbon-11 has a half-life
of about 20.4 minutes. Real carbon-14 has a half-life of about 5,730 years; a
C-14 coin decays after 7 days and does not last anywhere near that long.

### Decay

When a C-11 or C-14 coin collapses, Carbon snapshots the mother coin's holders,
launches a daughter coin and airdrops it to the mother's holders in proportion
to their snapshot balances. The snapshot, the collapse, the daughter and every
airdrop are public events. The decay mechanics come from `@qsd/protocol`; Carbon
does not reimplement them.

## Shapes

| Shape | What it does |
|---|---|
| CHAIN | Linear Scout→Forge→Sentinel→Herald, with Treasurer on Sentinel and Keeper on Herald. Short posting window. |
| RING | A benzene ring of all six. A timed loop: Herald posts and Treasurer buys back every loop; Keeper responds between loops. |
| DIAMOND | Every agent bonded to every other. Maximum budget. Every action needs your approval, and autopilot is unavailable. |

Graphene is not a shape: it is the live sheet of every real launch on the home
page.

<!-- generated:config-table:start -->
## Isotope × shape: the 12 launch types

| Isotope | Shape | Sentinel threshold | Decay | Dev buy (SOL) | Buyback / tick (SOL) | LLM calls / agent / h | Posts / h | Replies / h | Posting window | Loop | Every action gated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-11 | CHAIN | 60 | after 20 min with no trades | 0.05 | 0 | 10 | 1 | 3 | 120 min | none | no |
| C-11 | RING | 70 | after 20 min with no trades | 0.125 | 0.005 | 20 | 3 | 10 | none | every 10 min | no |
| C-11 | DIAMOND | 85 | after 20 min with no trades | 0.25 | 0.01 | 40 | 3 | 15 | none | none | yes |
| C-12 | CHAIN | 60 | none (stable) | 0.1 | 0 | 20 | 2 | 6 | 120 min | none | no |
| C-12 | RING | 70 | none (stable) | 0.25 | 0.01 | 40 | 6 | 20 | none | every 10 min | no |
| C-12 | DIAMOND | 85 | none (stable) | 0.5 | 0.02 | 80 | 6 | 30 | none | none | yes |
| C-13 | CHAIN | 60 | none (stable) | 0.1 | 0 | 20 (heavy agent: 40) | 2 (heavy Herald: 4) | 6 (heavy Keeper: 12) | 120 min | none | no |
| C-13 | RING | 70 | none (stable) | 0.25 | 0.01 | 40 (heavy agent: 80) | 6 (heavy Herald: 12) | 20 (heavy Keeper: 40) | none | every 10 min | no |
| C-13 | DIAMOND | 85 | none (stable) | 0.5 | 0.02 | 80 (heavy agent: 160) | 6 (heavy Herald: 12) | 30 (heavy Keeper: 60) | none | none | yes |
| C-14 | CHAIN | 60 | fixed clock, 7 days | 0.1 | 0 | 20 | 2 | 6 | 120 min | none | no |
| C-14 | RING | 70 | fixed clock, 7 days | 0.25 | 0.01 | 40 | 6 | 20 | none | every 10 min | no |
| C-14 | DIAMOND | 85 | fixed clock, 7 days | 0.5 | 0.02 | 80 | 6 | 30 | none | none | yes |

- C-13 (HEAVY): you choose one agent; its LLM capacity and concurrency double. If you choose Herald, posts per hour double; if Keeper, replies per hour double. No other agent changes.
- C-11 budgets are ×0.5 of the shape's base budgets.
- A buyback tick is the shape's loop period, or 10 minutes when the shape has no loop. Buybacks are funded only by the 30% fee share.
- Every agent has valence 4: at most 4 bond orders at once. Extra hand-offs queue.
<!-- generated:config-table:end -->

<!-- generated:sentinel-formula:start -->
## Stability score (Sentinel)

Score is 0-100: the sum of six inputs. A launch stays locked until the score reaches the shape's threshold. Content-rule and impersonation failures are hard fails: they block regardless of score. A content check that could not run is also a hard fail. If a data source cannot be reached, that input scores 0 with the reason "source unavailable"; Sentinel never guesses.

| Input | Max points |
|---|---|
| Name/ticker collision with live pump.fun coins | 25 |
| Perceptual-hash logo match to existing coins | 15 |
| Launching wallet history | 15 |
| Bundle/sniper risk (dev buy vs bonding curve) | 15 |
| Narrative freshness (age of Scout sources) | 10 |
| Content rules (no real people, protected brands, sexual or violent content) | 20 |

### Thresholds by shape

| Shape | Threshold |
|---|---|
| SHAPE_CHAIN | 60 |
| SHAPE_RING | 70 |
| SHAPE_DIAMOND | 85 |

### Collision

| Condition | Points | Hard fail |
|---|---|---|
| An existing coin has the same name AND the same ticker (impersonation) | 0 | yes |
| Existing coins share the exact name and (another) the exact ticker | 4 | no |
| An existing coin has the exact ticker or the exact name | 8 | no |
| An existing coin name/ticker contains ours or vice versa (≥4 chars) | 18 | no |
| No collision | 25 | no |

### Logo (64-bit difference hash, Hamming distance to the closest coin returned by the name/ticker search)

| Condition | Points | Hard fail |
|---|---|---|
| dHash distance ≤ 4 of 64 bits: near-identical logo (impersonation) | 0 | yes |
| distance 5-10: very similar | 5 | no |
| distance 11-16: somewhat similar | 10 | no |
| distance > 16: distinct | 15 | no |
No coin with a comparable logo: full points. Coins found but no image readable: 0, source unavailable.

### Launching wallet

Age: ≥30d → 7, ≥7d → 4, ≥1d → 2, ≥0d → 0.
Transactions: ≥100 → 4, ≥20 → 3, ≥5 → 1, ≥0 → 0.
Prior launches: ≤2 → 4, ≤10 → 2, ≤∞ → 0.

### Bundle/sniper risk

Share of supply the dev buy takes on the pump.fun curve (30 virtual SOL, 1,073,000,000 virtual tokens, 1,000,000,000 supply): ≤1% → 15, ≤2% → 13, ≤4% → 9, ≤8% → 4, ≤∞% → 0.

### Narrative freshness

Median age of the dated sources Scout cited (X post time): ≤24h → 10, ≤72h → 7, ≤168h → 4, ≤∞h → 1. No dated source: 0, source unavailable.

### Content rules

A deterministic denylist and an LLM classifier check name, ticker and lore for real people, protected brands, sexual and violent content. Any finding is a hard fail. Clean: 20. Classifier unreachable: 0, "source unavailable: content check could not run", and the launch is blocked (hard fail) until it runs.

Denylist (whole-word, case-insensitive): **real_person**: elon, musk, trump, biden, obama, kamala, harris, putin, zelensky, xi jinping, modi, macron, bezos, zuckerberg, zuck, gates, vitalik, buterin, saylor, cz, changpeng, sbf, bankman, taylor swift, kanye, ye west, drake, rihanna, beyonce, mrbeast, pope, king charles, satoshi nakamoto; **protected_brand**: disney, pixar, marvel, pokemon, pikachu, nintendo, mario, sonic, nike, adidas, gucci, apple, google, gemini, microsoft, openai, chatgpt, tesla, spacex, starlink, amazon, meta, facebook, instagram, tiktok, coca cola, cocacola, pepsi, mcdonalds, starbucks, netflix, spotify, ferrari, lamborghini, rolex, louis vuitton, mickey, hello kitty, shrek, spongebob, pepe, doge, shiba inu, binance, coinbase, solana, pump fun, pumpfun, phantom; **sexual**: sex, sexy, porn, nsfw, nude, nudes, naked, onlyfans, hentai, xxx, boobs, tits, dick, cum, milf, horny, fetish; **violent**: kill, killer, murder, shoot, shooting, bomb, bombing, terror, terrorist, isis, jihad, genocide, massacre, rape, nazi, hitler, suicide, behead, school shooter, gun, guns.
<!-- generated:sentinel-formula:end -->

## Approvals and autopilot

- You approve every launch and every X post. Approval cards are pre-drafted
  with the exact values that will be used, so approval is one tap.
- Every approval is signed by your wallet (a message signature, not a
  transaction) and checked against the wallet that created the launch.
- Autopilot is off by default. You can turn it on per launch and per action
  class: posts, replies, buybacks. Autopilot is never available for launches,
  and never on DIAMOND.
- The kill switch turns autopilot off for that launch for good. Every
  approval, autopilot change and kill is a public event.

## Money

Carbon uses pump.fun's native creator-fee sharing. The launch transaction sets
the coin's fee shares once, on chain: the coin's fee address is its
sharing-config account, and every distribution pays the shares below directly.
Carbon never holds your 50% and never holds your keys. Your wallet signs and
pays the launch; Carbon never stores your wallet's keys.

<!-- generated:fee-split:start -->
## Fee split

| Recipient | Share of every claimed creator fee | Basis points |
|---|---|---|
| The launcher's wallet | 50% | 5000 |
| $CARBON buyback wallet | 30% | 3000 |
| Carbon treasury | 20% | 2000 |
<!-- generated:fee-split:end -->

- Treasurer runs the claim on a schedule (every RING loop, otherwise hourly)
  and publishes a receipt for every split: amounts, transaction signatures and
  time. A split that is interrupted resumes without paying twice.
- $CARBON buybacks are funded only by the 30% share and are capped per tick.
- Treasurer trades nothing except $CARBON buybacks and the launch's own dev
  buy.
- Every launch's fee address and Carbon's two wallets are public on /wallets.
  Every receipt is public on /receipts.
- Carbon runs on Solana devnet by default. Mainnet needs a setting only the
  owner can change.

## The agents' model

The agents are powered by Google Gemini. Carbon is not affiliated with or
endorsed by Google. Each agent writes a short reasoning summary for its
actions, labelled "agent reasoning" and tied to the event it explains.

## What Carbon never does

- Never holds your wallet's keys.
- Never launches a coin without your approval, and never autopilots a launch.
- Never posts to X without your approval or the posts autopilot you turned on.
- Never creates X accounts. It only connects your own project account, with
  OAuth.
- Never trades anything except $CARBON buybacks and the launch's own dev buy.
- Never moves money without a public receipt.
- Never shows a number it did not log. Missing data is shown as `--.--`.
- Never runs on a quantum computer.
- Never offers investment advice. A coin launched here is a meme, not an
  investment.
