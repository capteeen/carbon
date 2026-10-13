/**
 * THE one import seam for @argon/visual. Every page imports visual components
 * from here and nowhere else. Data adapters (real event log → visual props)
 * live in ./lib/visual-data.ts.
 *
 * No-WebGL devices: the components keep their HUD (every real value) and swap
 * the 3D canvas for a plain fog panel (handled inside @argon/visual's Stage).
 */
export {
  ArgonStory,
  IsotopeChamber,
  ShapePicker,
  LaunchScene,
  GrapheneSheet,
  EmbedPlayer,
  SoundToggle,
  HudLabel,
  HudReadout,
  PALETTE,
  FONTS,
} from '@argon/visual';
export type {
  ArgonStoryProps,
  IsotopeChamberProps,
  ShapePickerProps,
  LaunchSceneProps,
  GrapheneSheetProps,
  EmbedPlayerProps,
} from '@argon/visual';
