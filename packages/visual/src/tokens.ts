/**
 * Carbon design tokens (SPEC §5). Pure data, safe to import from server code.
 *
 * Palette is cold, near-monochrome and foggy. Colour appears ONLY as iridescent
 * chromatic aberration during transitions and on bond/hash flashes; that colour
 * is generated in shaders (thin-film hue), never stored as a flat accent here.
 */

export const PALETTE = {
  fogLight: '#B9C0CB',
  fogMid: '#9AA2AF',
  slate: '#5C6472',
  frost: '#E6EBF2',
  ink: '#2B313B',
} as const;

export type PaletteKey = keyof typeof PALETTE;

/**
 * The single non-palette colour in the system: SPEC §5 asks for "a red broken
 * seam on block" when Sentinel blocks a launch. Used for that seam and nothing else.
 */
export const BLOCK_SIGNAL = '#B5525A' as const;

/**
 * Fonts. Both are SIL Open Font License 1.1.
 *  - Display: Nunito Black (900), a heavy rounded sans by Vernon Adams et al.
 *    https://fonts.google.com/specimen/Nunito (OFL). Used for the CARBON wordmark
 *    and section titles only.
 *  - Mono: Space Mono 400/700 by Colophon Foundry. https://fonts.google.com/specimen/Space+Mono (OFL).
 *
 * The app loads them with next/font and exposes them as CSS variables
 * `--font-carbon-display` and `--font-carbon-mono`; the stacks below fall back
 * to the family names (e.g. when loaded via @fontsource in the harness).
 */
export const FONTS = {
  display: {
    family: 'Nunito',
    weight: 900,
    licence: 'SIL OFL 1.1',
    cssVar: '--font-carbon-display',
    stack: "var(--font-carbon-display, 'Nunito'), ui-rounded, 'Arial Rounded MT Bold', system-ui, sans-serif",
  },
  mono: {
    family: 'Space Mono',
    weight: 400,
    licence: 'SIL OFL 1.1',
    cssVar: '--font-carbon-mono',
    stack: "var(--font-carbon-mono, 'Space Mono'), ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
  },
} as const;

/** CSS custom properties defined in styles.css (kept in sync by a test). */
export const CSS_VARS = {
  fogLight: '--carbon-fog-light',
  fogMid: '--carbon-fog-mid',
  slate: '--carbon-slate',
  frost: '--carbon-frost',
  ink: '--carbon-ink',
  blockSignal: '--carbon-block-signal',
  fontDisplay: '--carbon-font-display',
  fontMono: '--carbon-font-mono',
} as const;

/** Linear 0..1 RGB of a #RRGGBB hex string (sRGB, not linearised). */
export function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
