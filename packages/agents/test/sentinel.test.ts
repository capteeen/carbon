import { SHAPES, type SentinelInput, launchConfig } from '@carbon/core';
import { describe, expect, it } from 'vitest';
import { Forge } from '../src/forge/index.js';
import { Scout } from '../src/scout/index.js';
import { Sentinel, xSnowflakeTime } from '../src/sentinel/index.js';
import { WEIGHTS, devBuySupplyPct, finalize, renderFormulaMarkdown, scoreCollision } from '../src/sentinel/formula.js';
import { makePng, snowflake } from './fakes.js';
import { GROUNDED, created, expectReasoningForEveryAction, makeHarness } from './script.js';

async function setup(cfg = launchConfig('C-12', 'chain'), o: Parameters<typeof makeHarness>[1] = {}) {
  const h = makeHarness(cfg, o);
  const c = await created(h, cfg);
  const proposals = await new Scout(h.ctx).propose(c.payload.line);
  const narrative = proposals.payload.narratives[0]!;
  const forge = new Forge(h.ctx);
  const draft = await forge.draft(narrative, narrative.names[0]!);
  const sentinel = new Sentinel(h.ctx);
  const score = () => sentinel.score({ draft, narrative, launcherWallet: c.payload.launcherWallet });
  return { h, narrative, draft, score, forge };
}

const full = (key: SentinelInput['key'], hardFail = false): SentinelInput => ({ key, points: WEIGHTS[key], max: WEIGHTS[key], reason: 'x', hardFail });

describe('Sentinel', () => {
  it('weights sum to 100 and /how renders the formula', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const md = renderFormulaMarkdown();
    expect(md).toContain('| Name/ticker collision with live pump.fun coins | 25 |');
    expect(md).toContain('SHAPE_DIAMOND | 85');
    expect(md).toContain('source unavailable');
  });

  it('unreachable sources score 0 with reason "source unavailable", never a guess', async () => {
    const { h, score } = await setup(launchConfig('C-12', 'chain'), { classifierThrows: true });
    h.chain.coins = new Error('pump.fun 503');
    h.chain.history = new Error('rpc timeout');
    const e = await score();
    const by = Object.fromEntries(e.payload.inputs.map((i) => [i.key, i]));
    for (const k of ['collision', 'logo', 'wallet', 'content'] as const) {
      expect(by[k]!.points).toBe(0);
      expect(by[k]!.reason.startsWith('source unavailable')).toBe(true);
      expect(by[k]!.hardFail).toBe(false);
    }
    expect(by.sniper!.points).toBeGreaterThan(0);
    expect(e.payload.passed).toBe(false);
  });

  it('a hard fail blocks even at 100 points', () => {
    const inputs = [full('collision'), full('logo'), full('wallet'), full('sniper'), full('freshness'), full('content', true)];
    const r = finalize(inputs, 60, 1);
    expect(r.score).toBe(100);
    expect(r.hardFail).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('threshold per shape: the same 75 points pass CHAIN and RING but not DIAMOND', () => {
    const inputs = [full('collision'), full('logo'), full('wallet'), full('sniper'), full('freshness'), { ...full('content'), points: 0 }];
    const s = (shape: 'chain' | 'ring' | 'diamond') => finalize(inputs, SHAPES[shape].sentinelThreshold, 1);
    expect(s('chain').score).toBe(80);
    const seventyFive = inputs.map((i) => (i.key === 'freshness' ? { ...i, points: 5 } : i));
    const t = (shape: 'chain' | 'ring' | 'diamond') => finalize(seventyFive, SHAPES[shape].sentinelThreshold, 1).passed;
    expect([t('chain'), t('ring'), t('diamond')]).toEqual([true, true, false]);
    expect(s('ring').passed).toBe(true);
  });

  it('content-rule violations (denylist or classifier) are hard fails', async () => {
    const a = await setup(launchConfig('C-12', 'chain'), { name: 'Elon Cat', ticker: 'ECAT' });
    const ea = await a.score();
    expect(ea.payload.hardFail).toBe(true);
    expect(ea.payload.passed).toBe(false);
    expect(ea.payload.inputs.find((i) => i.key === 'content')!.reason).toContain('real_person');

    const b = await setup(launchConfig('C-12', 'chain'), { violations: [{ rule: 'protected_brand', evidence: 'looks like a franchise mascot' }] });
    const eb = await b.score();
    expect(eb.payload.hardFail).toBe(true);
    expect(eb.payload.score).toBeGreaterThanOrEqual(60); // would pass on points alone
  });

  it('impersonation: same name+ticker, or a near-identical logo, is a hard fail', async () => {
    const { h, score, draft } = await setup();
    h.chain.coins = [{ mint: 'M1', name: 'Frost Cat', symbol: 'FROSTCAT' }];
    expect((await score()).payload.inputs.find((i) => i.key === 'collision')!.hardFail).toBe(true);

    // Same logo bytes as ours on another coin.
    const ours = h.assets.files.get(draft.payload.logoUri)!;
    h.assets.files.set('https://img.test/copy.png', ours);
    h.assets.files.set('https://img.test/other.png', makePng(42));
    h.chain.coins = [
      { mint: 'M2', name: 'Other', symbol: 'OTHER', imageUri: 'https://img.test/other.png' },
      { mint: 'M3', name: 'Copy', symbol: 'COPY', imageUri: 'https://img.test/copy.png' },
    ];
    const e = await score();
    const logo = e.payload.inputs.find((i) => i.key === 'logo')!;
    expect(logo.hardFail).toBe(true);
    expect(logo.reason).toContain('0/64');
    expect(e.payload.passed).toBe(false);
    expect(e.payload.run).toBe(2);
  });

  it('collision tiers', () => {
    expect(scoreCollision('Frost Cat', 'FCAT', [{ mint: 'a', name: 'Frost Cat', symbol: 'X' }]).points).toBe(8);
    expect(scoreCollision('Frost Cat', 'FCAT', [{ mint: 'a', name: 'Frost Catalyst', symbol: 'X' }]).points).toBe(18);
    expect(scoreCollision('Frost Cat', 'FCAT', []).points).toBe(25);
  });

  it('freshness comes from the real X post time; web-only scores 0 "source unavailable"', async () => {
    const now = Date.UTC(2026, 9, 11);
    expect(xSnowflakeTime(snowflake(now))).toBe(now);
    const { h, narrative, draft } = await setup();
    const s = new Sentinel(h.ctx);
    const webOnly = { ...narrative, sources: [GROUNDED] };
    const e = await s.score({ draft, narrative: webOnly, launcherWallet: 'W' });
    const f = e.payload.inputs.find((i) => i.key === 'freshness')!;
    expect(f.points).toBe(0);
    expect(f.reason).toMatch(/^source unavailable/);
    const e2 = await s.score({ draft, narrative, launcherWallet: 'W' });
    expect(e2.payload.inputs.find((i) => i.key === 'freshness')!.points).toBe(10);
  });

  it('re-run after revision increments the run counter', async () => {
    const { score } = await setup();
    expect((await score()).payload.run).toBe(1);
    expect((await score()).payload.run).toBe(2);
  });

  it('dev buy vs curve', () => {
    expect(devBuySupplyPct(0)).toBe(0);
    expect(devBuySupplyPct(0.25)).toBeCloseTo(0.887, 2);
  });

  it('Scout says when X is unavailable and cites only grounded web sources', async () => {
    const cfg = launchConfig('C-12', 'chain');
    const h = makeHarness(cfg, { posts: [] });
    h.x.searchResult = new Error('X 503');
    await created(h, cfg);
    const p = await new Scout(h.ctx).propose('frost cats');
    for (const n of p.payload.narratives) expect(n.sources).toEqual([GROUNDED]);
    const r = h.bus.ofKind('reasoning').find((x) => x.payload.forEventId === p.id)!;
    expect(r.payload.text).toMatch(/^X unavailable/);
    expectReasoningForEveryAction(h.bus);
  });
});
