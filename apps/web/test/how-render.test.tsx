// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { configRows, renderConfigMarkdown } from '@carbon/core/render-config';
import { describe, expect, it } from 'vitest';
import HowPage from '@/app/how/page';
import { Markdown } from '@/components/Markdown';

describe('/how renders docs/how.md', () => {
  it('the rendered /how table has exactly the 12 config rows from code', async () => {
    const { container } = render(await HowPage());
    const tables = [...container.querySelectorAll('table')];
    const configTable = tables.find((t) => t.querySelector('th')?.textContent === 'Isotope' && t.textContent?.includes('Sentinel threshold'));
    expect(configTable).toBeDefined();
    const rows = [...configTable!.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    const expected = configRows();
    expect(rows).toHaveLength(12);
    rows.forEach((cells, i) => {
      const r = expected[i]!;
      expect(cells[0]).toBe(r.isotope);
      expect(cells[1]).toBe(r.shape.toUpperCase());
      expect(cells[2]).toBe(String(r.config.sentinelThreshold));
      expect(cells[4]).toBe(String(r.config.devBuySol));
    });
    // The rendered table text equals the table rendered straight from code.
    const fromCode = render(<Markdown source={renderConfigMarkdown()} />).container.querySelector('table')!;
    expect(configTable!.outerHTML).toBe(fromCode.outerHTML);
  });

});
