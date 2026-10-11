/**
 * THE one import seam for @carbon/visual. Every page imports visual components
 * from here and nowhere else. Data adapters (real event log → visual props)
 * live in ./lib/visual-data.ts.
 *
 * No-WebGL devices: the components keep their HUD (every real value) and swap
 * the 3D canvas for a plain fog panel (handled inside @carbon/visual's Stage).
 */
export {
  CarbonStory,
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
} from '@carbon/visual';
export type {
  CarbonStoryProps,
  IsotopeChamberProps,
  ShapePickerProps,
  LaunchSceneProps,
  GrapheneSheetProps,
  EmbedPlayerProps,
} from '@carbon/visual';
