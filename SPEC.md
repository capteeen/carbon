# CARBON ($CARBON) · "Agents that bond."
# ONE BUILD PROMPT FOR CLAUDE CODE

Read this whole file first. Write it to SPEC.md at the repo root and re-read
SPEC.md at the start of every session. Run the build as a team of parallel
subagents (Agent tool). You are the integrator: review every delivery against
this spec and reject anything that fakes data, animates without a real event,
overclaims, or moves money without a receipt.

══════════════════════════════════════════════════════════════════════
0. WHAT WE ARE BUILDING
══════════════════════════════════════════════════════════════════════
A pump.fun launchpad run by a molecule of six AI agents. A user connects their
wallet (and optionally their project's X account), types one line, picks an
isotope and a shape, and the agents bond to research, create, check and launch
a coin. The site is a cinematic, scroll-driven 3D story of the carbon atom that
ends in a live view of every real launch.

Carbon is element 6 because it has 6 protons. Carbon has 6 agents. Isotopes
differ only in neutrons, so each isotope is a different agent configuration
that produces a different launch.

LIVE ONLY. No mock agents, posts, coins, bonds, readouts, receipts or numbers.
Every live visual maps to a logged event. Empty states are honest ("--.--",
"No molecules yet. Launch the first one.").

══════════════════════════════════════════════════════════════════════
1. THE CHEMISTRY — rules enforced in code
══════════════════════════════════════════════════════════════════════
PROTONS = the six core agents (fixed; they make it Carbon). Each has
valence 4: at most 4 bond orders at once; extra work queues visibly.
  SCOUT      finds live trends on X, proposes 3-5 narratives + names
  FORGE      creates the coin: name, ticker, lore, logo, banner, site;
             prepares the pump.fun deploy
  HERALD     drafts posts and, after approval, posts from the user's
             connected X account
  KEEPER     community: replies, holder milestones, recruiting drafts
  TREASURER  per-launch wallet, fee claims, the 50/30/20 split,
             $CARBON buybacks, public receipts
  SENTINEL   risk checks; computes the stability score; can BLOCK a launch

BONDS = real hand-offs between agents on the event bus. Order from traffic
in a rolling 60s window: single = 1 hand-off, double = ≥3 exchanges,
triple = ≥8 or both agents blocked on each other. Displayed bond order
must always equal the order recomputed from the log. Every hand-off is a
signed message; its hash is shown on the bond.

NEUTRONS / ISOTOPES (user picks one per launch):
  C-11  5 neutrons · FLASH · small budget, fast meme. Unstable: decays to a
        daughter after 20 min with no trades (real C-11 half-life ≈ 20.4 min)
  C-12  6 neutrons · CORE · balanced, stable, default
  C-13  7 neutrons · HEAVY · stable; the extra neutron doubles the capacity
        of ONE agent the user chooses (e.g. heavy Herald, heavy Sentinel)
  C-14  8 neutrons · RADIOACTIVE · built-in decay to a daughter on a long,
        visible clock. Copy may mention real C-14's ~5,730-year half-life as
        the story; never imply the coin lasts that long.
DECAY (C-11, C-14): on collapse, a daughter coin launches and mother holders
are airdropped proportionally from a snapshot. Import @qsd/protocol from
the qsd-market repo; never reimplement.

MOLECULES / SHAPES (user picks one per launch; each changes real behaviour):
  CHAIN    linear Scout→Forge→Sentinel→Herald; short posting window;
           Sentinel threshold 60
  RING     benzene ring of all six; timed loop: Herald posts and Treasurer
           buys back every 10 min (configurable), Keeper responds between;
           threshold 70
  DIAMOND  every agent triple-bonded; max budget; every action gated;
           threshold 85
Isotope × shape = 12 launch types. Budget, posting cadence, Sentinel
threshold and decay clock for each live in ONE config table, rendered on /how.
GRAPHENE is not a shape: it is the live homepage sheet of all launches.

STABILITY SCORE (Sentinel), 0-100, formula public on /how. Inputs:
name/ticker collision with live pump.fun coins · perceptual-hash logo match
to existing coins · launching wallet history · bundle/sniper risk · narrative
freshness · content rules (no real people, no protected brands, nothing
sexual or violent). Launch stays locked until the score ≥ the shape's
threshold. Hard fails (content rules, impersonation) block regardless. Every
input shows its points and reason; the user can revise and re-run.

══════════════════════════════════════════════════════════════════════
2. MONEY
══════════════════════════════════════════════════════════════════════
FIRST TASK before any wallet code: research current pump.fun creator-fee
mechanics (who receives creator fees, any native fee sharing or fee
recipients, how claims work). Write /docs/fees-research.md with sources and
dates. The integrator reviews it before Treasurer is built.

DEFAULT DESIGN (change only if the research finds a cleaner native option):
- Each launch gets its own per-launch creator wallet, generated server-side,
  encrypted at rest, keys only in Railway env/KMS, never logged. The user's
  wallet signs and pays the launch and is never stored.
- Copy says "Carbon never holds YOUR keys." Every per-launch wallet address
  is public on /wallets.
- Fee split on every claim: 50% to the launcher's wallet · 30% buys $CARBON
  · 20% to the Carbon treasury. Treasurer executes on a schedule.
- Every split is a public receipt: amounts, tx signatures, time. Idempotent:
  a crashed split resumes without double-paying.
- Budgets enforced in code. Treasurer never trades anything except $CARBON
  buybacks and the launch's own dev buy.
- Devnet by default. Mainnet only behind an env flag the owner sets.

══════════════════════════════════════════════════════════════════════
3. APPROVALS AND SAFETY
══════════════════════════════════════════════════════════════════════
- The user approves every launch and every X post. Approval cards are
  pre-drafted so approval is one tap.
- Optional autopilot, OFF by default, per launch and per action class
  (posts, replies, buybacks), with a kill switch and a full log. Never
  available for launches.
- X: OAuth 2.0 PKCE on the user's own project account. No account creation
  anywhere in the codebase.
- Footer on every page: "Carbon does not run on a quantum computer. Agents
  are powered by Google Gemini; Carbon is not affiliated with or endorsed by
  Google. Coins launch on pump.fun (Solana). A meme, not an investment."

══════════════════════════════════════════════════════════════════════
4. TEAM — spawn A, B, C, D in parallel, then E, F, G
══════════════════════════════════════════════════════════════════════
A core     /packages/core     event bus (Postgres + Redis → SSE), bond
                              calculator, valence enforcement, isotope and
                              shape config, molecule state machine,
                              approval gates, budgets, LLM layer
B agents   /packages/agents   six sub-agents, one per proton
C visual   /packages/visual   the 3D scroll story and live views; three
                              sub-agents: objects+materials, scroll+HUD,
                              performance
D x        /packages/x        OAuth, posting, replies, search, rate limits
E chain    /packages/solana   fees research FIRST, then per-launch wallets,
                              pump.fun deploy, claims, split, $CARBON buy,
                              holder snapshots, decay via @qsd/protocol
F app      /apps/web          onboarding, launch flow, pages, embed
G verify   /tests /docs       adversarial; never saw the code written

LLM LAYER: /packages/core/llm with a provider interface. Gemini is the
default; model id from Google's current docs; GEMINI_API_KEY in env.
Changing the model = one config value. Implement a second provider so dev
and tests run if Gemini is unreachable; production uses Gemini only.

THINKING FEED: each agent emits short reasoning summaries for its actions,
labelled "agent reasoning", tied to event ids, never invented.

══════════════════════════════════════════════════════════════════════
5. VISUAL LANGUAGE + SCROLL STORY (highest effort on the team)
══════════════════════════════════════════════════════════════════════
REFERENCE: igloo.inc. Take its palette, type system, HUD labelling and scroll
grammar (dismantle → glitch → isolate → tunnel → pedestal → reassemble). Do
NOT copy its layout, wordmark, objects, terrain or copy. The subject is the
carbon atom; every object is ours.

PALETTE (cold, near-monochrome, foggy):
  fog-light #B9C0CB · fog-mid #9AA2AF · slate #5C6472 · frost #E6EBF2 ·
  ink #2B313B
  Colour appears ONLY as iridescent chromatic aberration during transitions
  and on bond/hash flashes. No flat accent colours; agents are told apart by
  emblem and label. Fine animated film grain and volumetric fog over all.

TYPE:
  Display: heavy, rounded geometric sans (open licence) for the CARBON
  wordmark and section titles; do not imitate Igloo's wordmark.
  Everything else: typewriter-style mono (Space Mono, IBM Plex Mono or
  similar). Labels UPPERCASE_SNAKE (ATOM_06, PROTON_01_SCOUT, ISOTOPE_C14);
  "//" for metadata, "//////" for section heads. Text sits small in corners;
  the 3D object owns the centre.

HUD: thin 1px frost lines from objects to labels with live mono readouts
(BONDS 3/4 · LOAD 41.08 +02.13). Real values only; "--.--" when there is no
data. "Sound: On/Off" toggle bottom-left: procedural wind and soft
crystalline tones on bond events, off by default.

OBJECTS (frosted, physically lit, matte-icy, slightly rough):
- ATOM: nucleus of 12 frosted nucleons (6 protons with faint engraved agent
  emblems, 6 neutrons plain) inside two translucent electron shells: inner
  2 electrons, outer 4. The 4 outer electrons are the 4 bonds.
- BONDS: frosted bridges with 1, 2 or 3 inner seams by order; seams glow
  frost-white with an iridescent flicker on each real hand-off; the message
  hash (first 8 chars, mono) rides the seam.

SCROLL STORY: one pinned canvas; scroll progress is the only clock. Lenis
smooth scroll; anime.js v4 onScroll for 2D/HUD; react-three-fiber for 3D.
Every layer reads the same progress value, so scrolling back rewinds 3D,
labels and HUD together.
  00 HERO — the atom floats in fog over a frozen, faintly crystalline
     graphite plain. Top-left: CARBON, "// Element 06", "// Agents that
     bond." Top-right: "////// Manifesto" + three mono lines. Drag rotates
     with heavy inertial easing; the cursor disturbs the electron cloud.
  01 DISMANTLE — the 12 nucleons lift apart like blocks, seams glowing,
     fragments catching iridescent light.
  02 GLITCH — pixel-stretch / slit-scan transition with chromatic
     aberration into isolation.
  03 SIX PROTONS — one proton at a time: frosted sphere with agent emblem,
     HUD: PROTON_01 / SCOUT · role · BONDS n/4 · LOAD live · "CLICK TO
     EXPLORE" (opens that agent's live log). Order: Scout, Forge, Herald,
     Keeper, Treasurer, Sentinel. Note: "6 protons make it carbon. 6 agents
     make it a Carbon launch."
  04 SHELLS — camera flies through two concentric frosted rings (2 then 4
     electrons) into a bright core; the 4 outer electrons become the 4 bond
     arms: "Every agent holds exactly 4 bonds."
  05 BONDING — single, double, triple bonds form as frosted bridges with
     1/2/3 seams; hashes ride the seams; copy: light hand-off, partnership,
     locked team.
  06 ISOTOPE CHAMBER — the nucleus re-forms as a point cloud on a circular
     frosted pedestal with a glowing base ring. Bracketed carousel:
     [ C-11 ] [ C-12 ] [ C-13 ] [ C-14 ]. Switching flows neutrons in/out
     and updates NEUTRONS · STABILITY · HALF-LIFE · BEHAVIOUR. C-11 and C-14
     shimmer with a decay readout. On C-13 the visitor drags the extra
     neutron onto a proton to strengthen that agent. This chamber is a
     reusable component also used on /launch.
  07 SHAPES — chain, benzene ring and diamond lattice side by side, HUD
     lines naming what each does.
  08 THE LAUNCH — the chosen isotope + shape condenses into a frosted coin
     with the CA typing beneath it.
  09 REASSEMBLE → LIVE — nucleons fly back into the atom; the camera pulls
     up to a frozen graphene plain where every real live launch is a crystal
     in the hex sheet (shows its isotope and shape). Click to fly in.
     [Launch] in the corner; thinking feed and receipts as small mono panels.

HONESTY RULE: chapters 00-07 are an illustrated explainer and never present
illustration as live activity. Chapter 08 replays a real recorded launch
(its real hand-offs, hashes, score and CA), labelled "replaying $TICKER,
<date>", once one exists. Chapter 09 and every HUD readout are live only.

LAUNCH PAGES (/l/[ca]) reuse the same objects, fully live: the launch's
atoms, bonds forming from real events, Sentinel's check (bonds to every atom
at once, a ring gauge filling input by input, lock flash on pass, a red
broken seam on block), decay as a dimming nucleus that sheds particles, and
the daughter forming beside it on collapse.

PERFORMANCE: one shared renderer; instanced nucleons, particles and point
clouds; grain and fog as cheap post-passes; no heap growth. 60fps at 390px on
a mid-range phone; degrade grain → fog density → point-cloud count →
aberration, never HUD truth or bond accuracy. First frame under 2s (hero atom
first). Reduced motion: stepped fades with the same information.
twitter:card=player embed per launch and a real 1200×630 OG image per launch.

══════════════════════════════════════════════════════════════════════
6. PAGES (phone first, 390px)
══════════════════════════════════════════════════════════════════════
/            the scroll story ending in the live graphene
/launch      connect wallet (+ optional X) → one line → isotope chamber →
             shape picker → Scout proposals → Forge output → Sentinel score →
             approve → deploy
/l/[ca]      live launch view, thinking feed, receipts, Sentinel report,
             posts, holders, approvals, autopilot toggles, decay status
/receipts    every fee split with tx links
/wallets     every per-launch wallet address
/how         chemistry rules, isotope × shape table, stability formula,
             fee split, what Carbon never does; rendered verbatim from /docs
/embed/[ca]  player-card view

══════════════════════════════════════════════════════════════════════
7. VERIFY (Agent G)
══════════════════════════════════════════════════════════════════════
- Try to give an agent a 5th bond: must fail.
- Displayed bond orders = orders recomputed from logs, always.
- Each isotope × shape applies exactly its config row (budget, cadence,
  threshold, decay); C-13's extra neutron affects only the chosen agent.
- Launch below threshold or with a hard fail: blocked.
- Post or launch without approval: impossible.
- Kill the fee split mid-run and resume: no double payment; receipts match
  the chain.
- Grep code, logs and git history for keys or seeds: none.
- Empty event stream → live views still; recorded stream → identical replay.
- Scroll forward and back: 3D, HUD and labels stay in sync at every point.
- Frame-time test on a throttled phone profile ≥ 55fps median.
- Check every user-facing claim (chemistry, half-lives, Gemini, quantum)
  against /docs; flag any overclaim.
- Write /docs/security.md and /docs/audit-log.md. Nothing ships with an open
  blocking finding.

══════════════════════════════════════════════════════════════════════
8. HOSTING AND DELIVERY
══════════════════════════════════════════════════════════════════════
Site on Vercel. Agents, Treasurer schedules, decay watchers and the event bus
on Railway. Secrets only in Vercel/Railway env. .env and details/ never
committed.

Deliver one recorded phone run in a single take: scroll the full story →
connect wallet + X → one line → pick C-13 with a heavy Herald → pick RING →
Scout proposals → Sentinel score passes → approve → real devnet coin → bonds
forming from real events → approved CA post from the connected account →
first fee-split receipt → the launch appears as a crystal in the live
graphene.
Report: what works, what is devnet-only, the fees research findings, Agent
G's open findings, env vars for mainnet, and cost per launch.
