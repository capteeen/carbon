/**
 * THE one import seam for @carbon/visual. Every page imports visual components
 * from here and nowhere else.
 *
 * Until @carbon/visual lands on main, this re-exports the honest 2D fallbacks
 * (text/HUD only, no fake data, no fake animation). At integration, replace the
 * line below with:
 *
 *   export { CarbonStory, IsotopeChamber, ShapePicker, LaunchScene, GrapheneSheet,
 *            EmbedPlayer, SoundToggle, HudLabel, HudReadout, tokens } from '@carbon/visual';
 *
 * The props each component receives are defined in ./visual-types.ts.
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
  tokens,
} from './visual-fallback';
export type * from './visual-types';
