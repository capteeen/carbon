/**
 * Renders THE isotope × shape config table (12 rows) as Markdown for /docs and /how.
 * Every cell comes from launchConfig(); nothing here is typed by hand.
 * Browser-safe (imports only contracts).
 */
import {
  AGENT_IDS,
  ISOTOPES,
  ISOTOPE_IDS,
  SHAPES,
  SHAPE_IDS,
  launchConfig,
  type DecayRule,
  type IsotopeId,
  type LaunchConfig,
  type ShapeId,
} from './contracts.js';

export interface ConfigRow {
  isotope: IsotopeId;
  shape: ShapeId;
  /** The row's config. For Ar-40 the heavy agent is a user choice; the row is computed with
   * `heavyExample` only to show the doubled value; every other agent is unaffected. */
  config: LaunchConfig;
  /** Ar-40 only: the doubled LLM capacity of the chosen heavy agent. */
  heavyLlmCallsPerHour: number | null;
  /** Ar-40 only: posts/h with a heavy Herald, replies/h with a heavy Keeper. */
  heavyPostsPerHour: number | null;
  heavyRepliesPerHour: number | null;
}

/** The 12 rows, in ISOTOPE_IDS × SHAPE_IDS order. */
export function configRows(): ConfigRow[] {
  return ISOTOPE_IDS.flatMap((iso) =>
    SHAPE_IDS.map((shape) => {
      if (ISOTOPES[iso].heavyAgent) {
        // Base row = what every non-heavy agent gets; scout is heavy here only to read off 2x.
        const heavy = launchConfig(iso, shape, 'scout');
        const base = launchConfig(iso, shape, 'sentinel');
        return {
          isotope: iso,
          shape,
          config: base,
          heavyLlmCallsPerHour: heavy.capacity.scout.llmCallsPerHour,
          heavyPostsPerHour: launchConfig(iso, shape, 'herald').postsPerHour,
          heavyRepliesPerHour: launchConfig(iso, shape, 'keeper').repliesPerHour,
        };
      }
      return {
        isotope: iso,
        shape,
        config: launchConfig(iso, shape, null),
        heavyLlmCallsPerHour: null,
        heavyPostsPerHour: null,
        heavyRepliesPerHour: null,
      };
    }),
  );
}

export function formatDecay(d: DecayRule): string {
  switch (d.kind) {
    case 'none':
      return 'none (stable)';
    case 'quiet':
      return `after ${d.quietSec / 60} min with no trades`;
    case 'clock':
      return d.clockSec % 86400 === 0 ? `fixed clock, ${d.clockSec / 86400} days` : `fixed clock, ${d.clockSec / 3600} h`;
  }
}

export const CONFIG_TABLE_COLUMNS = [
  'Isotope',
  'Shape',
  'Sentinel threshold',
  'Decay',
  'Dev buy (SOL)',
  'Buyback / tick (SOL)',
  'LLM calls / agent / h',
  'Posts / h',
  'Replies / h',
  'Posting window',
  'Loop',
  'Every action gated',
] as const;

function rowCells(r: ConfigRow): string[] {
  const c = r.config;
  const llm = c.capacity[AGENT_IDS[0]].llmCallsPerHour; // identical for every non-heavy agent
  const heavyNote = r.heavyLlmCallsPerHour !== null ? ` (heavy agent: ${r.heavyLlmCallsPerHour})` : '';
  const posts = r.heavyPostsPerHour !== null ? `${c.postsPerHour} (heavy Herald: ${r.heavyPostsPerHour})` : `${c.postsPerHour}`;
  const replies = r.heavyRepliesPerHour !== null ? `${c.repliesPerHour} (heavy Keeper: ${r.heavyRepliesPerHour})` : `${c.repliesPerHour}`;
  return [
    r.isotope,
    SHAPES[r.shape].label.replace('SHAPE_', ''),
    String(c.sentinelThreshold),
    formatDecay(c.decay),
    String(c.devBuySol),
    String(c.buybackSolPerTick),
    `${llm}${heavyNote}`,
    posts,
    replies,
    c.postingWindowMin === null ? 'none' : `${c.postingWindowMin} min`,
    c.loopMinutes === null ? 'none' : `every ${c.loopMinutes} min`,
    c.gateEveryAction ? 'yes' : 'no',
  ];
}

/** Markdown table of all 12 launch types. */
export function renderConfigTable(): string {
  const lines = [
    `| ${CONFIG_TABLE_COLUMNS.join(' | ')} |`,
    `| ${CONFIG_TABLE_COLUMNS.map(() => '---').join(' | ')} |`,
    ...configRows().map((r) => `| ${rowCells(r).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Section for docs/how: the table plus the notes needed to read it. */
export function renderConfigMarkdown(): string {
  return [
    '## Isotope × shape: the 12 launch types',
    '',
    renderConfigTable(),
    '',
    '- Ar-40 (HEAVY): you choose one agent; its LLM capacity and concurrency double. If you choose Herald, posts per hour double; if Keeper, replies per hour double. No other agent changes.',
    `- Ar-41 budgets are ×${ISOTOPES['Ar-41'].budgetMultiplier} of the shape's base budgets.`,
    "- A buyback tick is the shape's loop period, or 10 minutes when the shape has no loop. Buybacks are funded only by the 30% fee share.",
    '- Every agent has valence 4 (a product rule, not argon chemistry): at most 4 bond orders at once. Extra hand-offs queue.',
  ].join('\n');
}
