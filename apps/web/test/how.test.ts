import { readFileSync } from 'node:fs';
import { renderConfigMarkdown } from '@carbon/core/render-config';
import { renderFormulaMarkdown } from '@carbon/agents/sentinel/formula';
import { describe, expect, it } from 'vitest';
import { GENERATED_SECTIONS, extractSection, renderFeeSplitMarkdown, renderShapesMarkdown } from '@/lib/how-doc';
import { howDocPath } from '@/lib/how-path';

const doc = readFileSync(howDocPath(), 'utf8');

describe('/how is docs/how.md, and its generated parts equal the code', () => {
  it('shapes table block === SHAPES descriptions (AG-028)', () => {
    expect(extractSection(doc, 'shapes-table')).toBe(renderShapesMarkdown().trim());
  });
  it('config table block === renderConfigMarkdown()', () => {
    expect(extractSection(doc, 'config-table')).toBe(renderConfigMarkdown().trim());
  });
  it('Sentinel formula block === renderFormulaMarkdown()', () => {
    expect(extractSection(doc, 'sentinel-formula')).toBe(renderFormulaMarkdown().trim());
  });
  it('fee split block === FEE_SPLIT_BPS', () => {
    expect(extractSection(doc, 'fee-split')).toBe(renderFeeSplitMarkdown().trim());
  });
  it('every generated block exists', () => {
    for (const s of GENERATED_SECTIONS) expect(extractSection(doc, s)).not.toBeNull();
  });

  it('never claims quantum computing and names Gemini without endorsement', () => {
    expect(doc).toContain('Never runs on a quantum computer.');
    expect(doc).toContain('not affiliated with or');
  });
});
