# @carbon/visual

The Carbon 3D scroll story, the live launch views and the HUD (SPEC §5, §6).
It is a React 19 component library for the Next.js 15 app, built on react-three-fiber 9, three,
postprocessing, Lenis and anime.js v4 (`onScroll`).

## Install in the app

```ts
// next.config.ts
export default { transpilePackages: ['@carbon/visual', '@carbon/core'] };

// app/layout.tsx
import '@carbon/visual/styles.css';
import { Nunito, Space_Mono } from 'next/font/google';
const display = Nunito({ weight: '900', subsets: ['latin'], variable: '--font-carbon-display' });
const mono = Space_Mono({ weight: ['400', '700'], subsets: ['latin'], variable: '--font-carbon-mono' });
// <html className={`${display.variable} ${mono.variable}`}>
```

Every component is a client component (`'use client'`) and server-renders a static shell, which the
tests check. The WebGL canvas mounts on the client only.

**No WebGL.** If no WebGL context can be created, or the canvas throws, the 3D layer is replaced by a
plain fog panel with one line ("3D view unavailable on this device"). The HUD, which carries every
real value, is unaffected. Without `ResizeObserver` or `matchMedia`, the HUD layers are driven straight
from the progress store, and native scroll replaces Lenis.

**Sound toggle.** `CarbonStory` and `LaunchScene` render their own toggle unless you pass
`soundToggle={false}`. Pass false when the app layout hosts a global `<SoundToggle />`; apps/web does this.

**Fonts.** Both fonts are SIL OFL 1.1:
- Nunito Black 900 is the heavy rounded display face. It is used for the wordmark and titles.
- Space Mono 400/700 is used for HUD labels, metadata and hashes.

They are exposed as `--font-carbon-display` and `--font-carbon-mono`, which `styles.css` wraps as
`--carbon-font-display` and `--carbon-font-mono`. The library itself ships no font files.

## Public API

| Export | What it is |
| --- | --- |
| `<CarbonStory live replay launches feed receipts onOpenAgent onOpenLaunch onLaunch launchHref />` | The 10-chapter pinned scroll story (00 HERO … 09 REASSEMBLE_LIVE). Other props: `store`, `reducedMotion`, `smoothScroll` (default true; pass false if the app already runs Lenis), `quality`, `maxDpr`, `onFirstFrame`, `onFrame`. |
| `<IsotopeChamber value onChange heavyAgent onHeavyAgentChange />` | The chapter 06 chamber as a form control: C-11/12/13/14, plus heavy-agent selection for C-13. The extra neutron can be dragged. |
| `<ShapePicker value onChange />` | Chain / ring / diamond molecules, with each shape's rules. |
| `<LaunchScene events bonds sentinel decay daughter shape compact />` | The live molecule for one launch. Real hand-offs flash seams with their hash. A Sentinel check grows seams and fills the gauge input by input, then locks on pass or shows a red broken seam on block. Decay dims the molecule and sheds particles. Daughter launches bud a molecule. |
| `<GrapheneSheet launches onOpenLaunch onLaunch launchHref />` | One crystal per real launch, with hover details and empty state. |
| `<EmbedPlayer launch events bonds sentinel decay daughter href />` | A compact 16:9 player for an embed or share card. |
| `<SoundToggle />`, `sound`, `useSoundEnabled`, `useBondChimes` | "Sound: On/Off", off by default. Plays procedural wind, plus a crystalline chime once per real hand-off event id. |
| `HudCorner HudLabel HudMeta HudSection HudReadout HudTag HudPanel HudLeaders` and panels (`ProtonHud ChamberHud ShapesHud ReplayHud GrapheneHud ThinkingPanel ReceiptsPanel SentinelHud`) | HUD primitives. Labels use UPPERCASE_SNAKE, `//` marks metadata and `//////` marks section heads. |
| `createProgressStore`, `progressStore`, `useProgress`, `useChapter` | The single 0..1 progress store, written by Lenis and read by every layer. |
| `CHAPTERS`, `CHAPTER_RANGES`, `chapterAt`, `chapterLocal`, `chapterFade`, `evalStory`, … | The pure chapter table and timeline. |
| `QualityLadder`, `QUALITY_LEVELS`, `createQualityStore` | Adaptive quality. |
| `deriveLive`, `buildReplay`, `launchSummaryFromEvents`, `thinkingFromEvents`, `validLaunches`, … | Pure derivations from `CarbonEvent[]` and core `Bond[]` into the props above. |
| `PALETTE`, `BLOCK_SIGNAL`, `FONTS`, `CSS_VARS` (also `@carbon/visual/tokens`), `styles.css` | Tokens in TS and CSS. A test keeps them in sync. |

Shared types (`CarbonEvent`, `Bond`, `AgentId`, `IsotopeId`, `ShapeId`, `SentinelReport`, …) are
imported from `@carbon/core/contracts`.

Typical wiring:

```tsx
const live = deriveLive(events, handoffs.bonds(launchId, Date.now()));
const replay = buildReplay(lastLaunchEvents, handoffs.bonds(launchId, deployedAt));
const launches = allLaunchLogs.map(launchSummaryFromEvents).filter(Boolean);
<CarbonStory live={live} replay={replay} launches={launches} onOpenAgent={…} onOpenLaunch={…} />
```

## Honesty (enforced in code, tested in `test/honesty.test.tsx`)

- **Chapters 00–07** are an illustrated explainer. They show no live values, and their motion
  is driven only by scroll. (The on-screen illustration badge and note were removed at the owner's request.)
- **BONDS n/4 and LOAD** come only from the `live` prop. If it is missing they show `--.--`.
  Bond orders are core's (`Bond[]`) and are never recomputed here.
- **Chapter 08** replays `replay` and is labelled `replaying $TICKER, YYYY-MM-DD`. If there is no
  valid replay it shows an honest empty state.
- **Chapter 09** shows `launches`, or `No molecules yet. Launch the first one.` if there are none.
- Bond flashes, hashes on seams, and chimes come only from props that carry real 64-hex event ids
  (`isEventId`). Anything else is dropped (`validFlashes`, `validBonds`, `isValidReplay`, `validLaunches`).
- `src/` contains no sample launches, hashes or numbers. A test greps for them. Test doubles live in
  `test/fixtures` and are never exported. When the harness uses them it shows a TEST FIXTURE banner.

## Rendering, scroll and performance

- **Rendering.**
  - One `<Canvas>` (a single WebGL renderer) serves all ten chapters.
  - Nucleons, seams, crystals and point clouds are instanced.
  - Materials are custom shaders: frost GGX with wrap scatter, emblem atlas and thin-film iridescence.
  - One merged post effect does slit-scan glitch, chromatic aberration, depth fog, frost flash and grain.
  - The render loop does not allocate per frame: scratch objects are preallocated, the leader
    projection iterates an array, and the timeline writes into a reused state.
- **Scroll.**
  - Lenis writes the progress store.
  - r3f reads it in `useFrame` through the pure `evalStory(p)`.
  - The HUD/2D layers are anime.js `onScroll` observers whose markers come from the same chapter
    table. A jump guard re-pins layers after large jumps.
  - Because nothing keeps its own clock, scrolling back rewinds everything.
  - Reduced motion uses stepped chapter fades that carry the same copy and readouts.
- **Shader precompile.** After the first frame, during idle time, every material in the scene is
  compiled, including those of chapters not yet visible, with `compileAsync` where available. This
  avoids hitches the first time each chapter is visited.
- **Starting quality.** `createDeviceQualityStore()` is the default for every component. It picks
  the start level from cores, memory and width (phone-width devices with 4 or fewer cores start at
  level 2). Every level caps DPR at 1.5 or below.
- **Quality ladder.** It degrades in this order: grain off, then fog density, then point clouds
  ½ and ¼, then aberration off, then DPR 1 and 0.75. It reads a median and p90 over a 45-frame
  window, with hysteresis. It never touches HUD values, labels, seam counts or hashes.

### Harness and perf

```sh
pnpm --filter @carbon/visual harness          # vite dev on :5179  (?view=story|chamber|shapes|launch|graphene|embed&fixture=1&reduced=1)
pnpm --filter @carbon/visual harness:build
npx tsx perf/perf.ts --throttle=4 --seconds=12 --cycles=3 [--dpr=0.3] [--empty]
npx tsx perf/perf.ts --url=http://127.0.0.1:3124/ [--dpr=0.3]   # the shipped app page (Next production build)
npx tsx perf/shots.ts [outDir] [--url=…]      # screenshots per chapter, 390x844
```

`perf/perf.ts` sets up the run as follows:
- Playwright Chromium from `/opt/pw-browsers`, a 390×844 viewport at DPR 2, and a 4× CDP CPU throttle.
- It scrolls forward and back through the story and records frame times, first frame, and heap
  after forced GC per cycle.
- It runs a sync check: for each chapter it checks that the 3D chapter (`data-chapter3d`), the
  visible HUD layer, and the copy agree. It does this when scrolling forward, backward, shuffled,
  with Lenis wheel input, and with reduced motion.

Results are written to `perf/results/latest*.json`. In this sandbox, headless Chromium has no GPU
and rasterises with SwiftShader on the CPU, so fps here is a very pessimistic lower bound. It is
not a phone measurement.

Last results, all with a 4× CPU throttle, 390×844, fixture data, 3 forward/back cycles and the minified build:

| run | first frame | median fps | p95 frame | sync (fwd/back/shuffle/wheel/reduced) |
| --- | --- | --- | --- | --- |
| DPR 1.5 (SwiftShader raster-bound) | 1.29 s | 7.5 | 367 ms | 36/36, 36/36, 36/36, 28/28, 36/36 |
| DPR 0.3 (isolates JS/CPU cost) | 1.38 s | 59.9 | 33 ms | all agree |
| **Next app `/`**, production build, empty log, device DPR 2 (ladder ≤1.5 → 0.75) | 1.73 s | 15.0 | 233 ms | 36/36, 36/36, 36/36, 28/28, 36/36 |
| **Next app `/`**, device DPR 0.3 | 1.85 s | 59.9 | 50 ms | all agree |

At DPR 0.3 the heap after forced GC grew 560 → 161 → 96 KB per cycle, which looks like V8 warming
code up rather than linear growth. An earlier leak, where the EffectPass was rebuilt on every
re-render, is fixed. At idle, about 5 KB per frame of short-lived garbage still comes from
three.js/r3f internals (render-list sort, uniform upload). None of it comes from our per-frame code.

## Proposed contract changes (`packages/core/src/contracts.ts`)

The view-model types in `src/types.ts` are local today and are proposed for contracts:
- `BondFlash {pairKey, hash, at}`
- `LiveStats` / `AgentLiveStats`: `bondOrders` from core bonds, and `load` as hand-offs/min over
  `BOND_WINDOW_MS`.
- `LaunchReplay`, including `bondsAtDeploy: Bond[]`.
- `LaunchSummary`, including `deployEventId` and `collapsed`.
- `DecayView`, `DaughterView`, `ThinkingItem`.
