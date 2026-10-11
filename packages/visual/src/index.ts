/**
 * @carbon/visual: the 3D scroll story and live views (SPEC §5).
 * Import '@carbon/visual/styles.css' once in the app layout.
 */

// components
export { CarbonStory, type CarbonStoryProps } from './story/CarbonStory.js';
export { IsotopeChamber, type IsotopeChamberProps } from './components/IsotopeChamber.js';
export { ShapePicker, type ShapePickerProps } from './components/ShapePicker.js';
export { LaunchScene, type LaunchSceneProps } from './components/LaunchScene.js';
export { GrapheneSheet, type GrapheneSheetProps } from './components/GrapheneSheet.js';
export { EmbedPlayer, type EmbedPlayerProps } from './components/EmbedPlayer.js';
export { SoundToggle } from './sound/SoundToggle.js';
export { sound, useSoundEnabled, useBondChimes } from './sound/sound.js';

// HUD primitives
export { AgentPanel } from './hud/AgentPanel.js';
export type { InspectTarget } from './three/inspect.js';
export { HudCorner, HudLabel, HudMeta, HudSection, HudReadout, HudTag, HudPanel, HudLeaders, type Corner } from './hud/Hud.js';
export { ProtonHud, ChamberHud, ShapesHud, ShapeLabel, ReplayHud, GrapheneHud, ThinkingPanel, ReceiptsPanel, SentinelHud } from './hud/panels.js';
export { LeaderRegistry, type LeaderAnchor } from './hud/leaders.js';
export * from './hud/format.js';

// progress store + chapter timeline
export { createProgressStore, progressStore, useProgress, useChapter, type ProgressStore } from './story/progress.js';
export * from './story/chapters.js';
export { evalStory, createStoryState, fitFor, type StoryState } from './story/timeline.js';
export { useReducedMotion } from './story/scroll.js';

// quality ladder
export { QualityLadder, QUALITY_LEVELS, DEGRADE_ORDER, MAX_LEVEL, initialLevel, type QualitySettings, type LadderOptions } from './quality/ladder.js';
export { createQualityStore, createDeviceQualityStore, useQualityLevel, type QualityStore } from './quality/store.js';

// data → view models (pure; real events only)
export {
  deriveLive,
  buildReplay,
  isValidReplay,
  launchSummaryFromEvents,
  validLaunches,
  validBonds,
  validFlashes,
  flashesFromEvents,
  thinkingFromEvents,
  latestSentinel,
  realEvents,
} from './data/derive.js';
export { gaugeSegments, sentinelPhase } from './data/sentinel.js';
export type { AgentLiveStats, BondFlash, DaughterView, DecayView, LaunchReplay, LaunchSummary, LiveMolecule, LiveStats, ReceiptItem, ThinkingItem } from './types.js';

// tokens + copy
export { PALETTE, BLOCK_SIGNAL, FONTS, CSS_VARS, type PaletteKey } from './tokens.js';
export { COPY } from './copy.js';
