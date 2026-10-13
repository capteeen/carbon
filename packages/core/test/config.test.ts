import { describe, expect, it } from 'vitest';
import { AGENT_IDS, ISOTOPE_IDS, SHAPE_IDS, launchConfig, type LaunchConfig } from '../src/contracts.js';
import { CONFIG_TABLE_COLUMNS, configRows, formatDecay, renderConfigTable } from '../src/render-config.js';

function parseTable(md: string): Record<string, string>[] {
  const [head, , ...rows] = md.trim().split('\n');
  const cells = (l: string) => l.slice(1, -1).split('|').map((c) => c.trim());
  const cols = cells(head!);
  return rows.map((r) => Object.fromEntries(cells(r).map((c, i) => [cols[i]!, c])));
}

describe('config table', () => {
  it('has exactly the 12 isotope × shape rows', () => {
    const rows = configRows();
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => `${r.isotope}/${r.shape}`)).toEqual(ISOTOPE_IDS.flatMap((i) => SHAPE_IDS.map((s) => `${i}/${s}`)));
  });

  it('every rendered row equals launchConfig()', () => {
    const parsed = parseTable(renderConfigTable());
    expect(parsed).toHaveLength(12);
    expect(Object.keys(parsed[0]!)).toEqual([...CONFIG_TABLE_COLUMNS]);
    for (const row of parsed) {
      const iso = row.Isotope as (typeof ISOTOPE_IDS)[number];
      const shape = row.Shape!.toLowerCase() as (typeof SHAPE_IDS)[number];
      const heavy = iso === 'Ar-40';
      const c: LaunchConfig = launchConfig(iso, shape, heavy ? 'sentinel' : null); // a non-herald, non-keeper heavy
      expect(Number(row['Sentinel threshold'])).toBe(c.sentinelThreshold);
      expect(row.Decay).toBe(formatDecay(c.decay));
      expect(Number(row['Dev buy (SOL)'])).toBe(c.devBuySol);
      expect(Number(row['Buyback / tick (SOL)'])).toBe(c.buybackSolPerTick);
      expect(parseInt(row['LLM calls / agent / h']!, 10)).toBe(c.capacity.scout.llmCallsPerHour);
      expect(parseInt(row['Posts / h']!, 10)).toBe(c.postsPerHour);
      expect(parseInt(row['Replies / h']!, 10)).toBe(c.repliesPerHour);
      expect(row['Posting window']).toBe(c.postingWindowMin === null ? 'none' : `${c.postingWindowMin} min`);
      expect(row.Loop).toBe(c.loopMinutes === null ? 'none' : `every ${c.loopMinutes} min`);
      expect(row['Every action gated']).toBe(c.gateEveryAction ? 'yes' : 'no');
      if (heavy) {
        expect(row['LLM calls / agent / h']).toContain(`(heavy agent: ${launchConfig(iso, shape, 'scout').capacity.scout.llmCallsPerHour})`);
        expect(row['Posts / h']).toContain(`(heavy Herald: ${launchConfig(iso, shape, 'herald').postsPerHour})`);
        expect(row['Replies / h']).toContain(`(heavy Keeper: ${launchConfig(iso, shape, 'keeper').repliesPerHour})`);
      }
    }
  });

  it('configRows carries the exact launchConfig object for each row', () => {
    for (const r of configRows()) {
      expect(r.config).toEqual(launchConfig(r.isotope, r.shape, r.config.heavyAgent));
    }
  });

  it("Ar-40's extra neutron changes only the chosen agent", () => {
    for (const shape of SHAPE_IDS) {
      const base = launchConfig('Ar-36', shape);
      for (const heavy of AGENT_IDS) {
        const c = launchConfig('Ar-40', shape, heavy);
        for (const a of AGENT_IDS) {
          const k = a === heavy ? 2 : 1;
          expect(c.capacity[a]).toEqual({ llmCallsPerHour: base.capacity[a].llmCallsPerHour * k, concurrency: base.capacity[a].concurrency * k });
        }
        expect(c.postsPerHour).toBe(base.postsPerHour * (heavy === 'herald' ? 2 : 1));
        expect(c.repliesPerHour).toBe(base.repliesPerHour * (heavy === 'keeper' ? 2 : 1));
        const strip = (x: LaunchConfig) => ({ ...x, isotope: null, heavyAgent: null, capacity: null, postsPerHour: null, repliesPerHour: null });
        expect(strip(c)).toEqual(strip(base));
      }
    }
    expect(() => launchConfig('Ar-40', 'ring', null)).toThrow();
    expect(() => launchConfig('Ar-36', 'ring', 'herald')).toThrow();
  });
});
