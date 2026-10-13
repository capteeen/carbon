/**
 * docs/how.md is rendered verbatim on /how. Parts of it are generated from code
 * (the shapes table, the config table, the Sentinel formula, the fee split) between markers:
 *
 *   <!-- generated:NAME:start -->
 *   ...generated markdown...
 *   <!-- generated:NAME:end -->
 *
 * `pnpm --filter @argon/web gen:how` rewrites those blocks; a test fails if the
 * file and the code ever disagree.
 */
import { FEE_SPLIT_BPS, SHAPES, SHAPE_IDS } from '@argon/core/contracts';

export const GENERATED_SECTIONS = ['shapes-table', 'config-table', 'sentinel-formula', 'fee-split'] as const;
export type GeneratedSection = (typeof GENERATED_SECTIONS)[number];

const start = (n: string) => `<!-- generated:${n}:start -->`;
const end = (n: string) => `<!-- generated:${n}:end -->`;

export function extractSection(doc: string, name: GeneratedSection): string | null {
  const a = doc.indexOf(start(name));
  const b = doc.indexOf(end(name));
  if (a < 0 || b < 0 || b < a) return null;
  return doc.slice(a + start(name).length, b).trim();
}

export function spliceSection(doc: string, name: GeneratedSection, body: string): string {
  const a = doc.indexOf(start(name));
  const b = doc.indexOf(end(name));
  if (a < 0 || b < 0 || b < a) throw new Error(`docs/how.md has no ${name} markers`);
  return `${doc.slice(0, a + start(name).length)}\n${body.trim()}\n${doc.slice(b)}`;
}

/** The fee split section, from FEE_SPLIT_BPS. */
export function renderFeeSplitMarkdown(): string {
  const pct = (bps: number) => `${bps / 100}%`;
  return [
    '## Fee split',
    '',
    '| Recipient | Share of every claimed creator fee | Basis points |',
    '|---|---|---|',
    `| The launcher's wallet | ${pct(FEE_SPLIT_BPS.launcher)} | ${FEE_SPLIT_BPS.launcher} |`,
    `| $ARGON buyback wallet | ${pct(FEE_SPLIT_BPS.argonBuyback)} | ${FEE_SPLIT_BPS.argonBuyback} |`,
    `| Argon treasury | ${pct(FEE_SPLIT_BPS.treasury)} | ${FEE_SPLIT_BPS.treasury} |`,
  ].join('\n');
}

/** The shapes table, from SHAPES (one row per shape, the description the code ships). */
export function renderShapesMarkdown(): string {
  return [
    '| Shape | What it does |',
    '|---|---|',
    ...SHAPE_IDS.map((id) => {
      const sh = SHAPES[id];
      const gate = sh.gateEveryAction ? ' Autopilot is unavailable.' : '';
      return `| ${sh.label.replace(/^SHAPE_/, '')} | ${sh.description}${gate} |`;
    }),
  ].join('\n');
}
