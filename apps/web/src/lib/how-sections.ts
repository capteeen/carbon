/**
 * Producers for the generated blocks of docs/how.md (Node only: the Sentinel
 * formula comes from @argon/agents). Used by scripts/gen-how.ts and the test
 * that asserts the doc equals the code; never by the browser.
 */
import { renderFormulaMarkdown } from '@argon/agents/sentinel/formula';
import { renderConfigMarkdown } from '@argon/core/render-config';
import { renderFeeSplitMarkdown, renderShapesMarkdown, type GeneratedSection } from './how-doc';

export function generatedSections(): Record<GeneratedSection, string> {
  return {
    'shapes-table': renderShapesMarkdown(),
    'config-table': renderConfigMarkdown(),
    'sentinel-formula': renderFormulaMarkdown(),
    'fee-split': renderFeeSplitMarkdown(),
  };
}
