import { SHAPES, type SentinelInput, launchConfig } from '@carbon/core';
import { describe, expect, it } from 'vitest';
import { Forge } from '../src/forge/index.js';
import { Scout } from '../src/scout/index.js';
import { Sentinel, assertLaunchCleared, draftContentHash, siteText, xSnowflakeTime } from '../src/sentinel/index.js';
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
      expect(by[k]!.hardFail).toBe(k === 'content');
    }
    expect(by.content!.reason).toContain('content check could not run');
    expect(e.payload.hardFail).toBe(true);
    expect(by.sniper!.points).toBeGreaterThan(0);
    expect(e.payload.passed).toBe(false);
  });

  it('an unreachable content classifier blocks even when every other input is full', async () => {
    const { score } = await setup(launchConfig('C-12', 'chain'), { classifierThrows: true });
    const e = await score();
    expect(e.payload.score).toBe(80);
    expect(e.payload.score).toBeGreaterThanOrEqual(e.payload.threshold);
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

describe('[AG-035] the score is bound to the draft it checked, and the images and site are content-checked', () => {
  it('sentinel.score records the scored draft event id and its content hash', async () => {
    const { draft, score } = await setup();
    const e = await score();
    expect(e.payload.passed).toBe(true);
    expect(e.payload).toMatchObject({ draftEventId: draft.id, contentHash: draftContentHash(draft.payload) });
  });

  it('the logo and banner bytes go to the vision classifier; an image finding is a hard fail', async () => {
    const { h, draft, score } = await setup(launchConfig('C-12', 'chain'), { imageViolations: [{ rule: 'protected_brand', evidence: 'logo: a franchise mascot' }] });
    const e = await score();
    const content = e.payload.inputs.find((i) => i.key === 'content')!;
    expect(content.hardFail).toBe(true);
    expect(content.reason).toContain('image-classifier: logo: a franchise mascot');
    const call = h.llm.visionCalls.at(-1)!;
    expect(call.images.map((i) => i.bytes)).toEqual([h.assets.files.get(draft.payload.logoUri), h.assets.files.get(draft.payload.bannerUri)]);
  });

  it('if the image check cannot run (no vision, unreadable image, classifier error, logo not the hashed one) the launch is blocked', async () => {
    const noVision = await setup();
    const llm = noVision.h.ctx.llm;
    noVision.h.ctx.llm = { id: 'text-only', model: 'x', generate: (r) => llm.generate(r) };
    const a = (await noVision.score()).payload.inputs.find((i) => i.key === 'content')!;
    expect([a.hardFail, a.points]).toEqual([true, 0]);
    expect(a.reason).toContain('image check: LLM provider text-only has no image input');

    const throws = await setup(launchConfig('C-12', 'chain'), { imageClassifierThrows: true });
    expect((await throws.score()).payload.inputs.find((i) => i.key === 'content')!.reason).toContain('image check: vision 503');

    const missing = await setup();
    missing.h.assets.files.delete(missing.draft.payload.bannerUri);
    const m = (await missing.score()).payload;
    expect(m.hardFail).toBe(true);
    expect(m.inputs.find((i) => i.key === 'content')!.reason).toContain('image check: 404');

    const swapped = await setup();
    swapped.h.assets.files.set(swapped.draft.payload.logoUri, makePng(99));
    expect((await swapped.score()).payload.inputs.find((i) => i.key === 'content')!.reason).toContain('logo bytes do not match');
  });

  it('the generated site text is checked too (denylist), and an unreadable site blocks', async () => {
    const { h, draft, score } = await setup();
    const html = new TextDecoder().decode(h.assets.files.get(draft.payload.siteUri)!);
    h.assets.files.set(draft.payload.siteUri, new TextEncoder().encode(html.replace(/<p class="tag">[^<]*<\/p>/, '<p class="tag">// the pikachu of glaciers</p>')));
    const e = await score();
    expect(e.payload.inputs.find((i) => i.key === 'content')!.reason).toContain('"pikachu" in site');
    // the Carbon footer (which names Google Gemini and pump.fun) is not coin content
    expect(siteText(html)).not.toMatch(/Gemini/);
    expect(siteText(html)).toContain('Cold paws, warm hearts.');
    h.assets.files.delete(draft.payload.siteUri);
    expect((await score()).payload.inputs.find((i) => i.key === 'content')!.reason).toContain('site text unreadable');
  });

  it('the gate refuses a draft appended while Sentinel ran, an unbound score, and a score naming another draft', async () => {
    const { h, draft, forge, narrative, score } = await setup();
    const s = await score();
    await expect(assertLaunchCleared(h.ctx)).resolves.toMatchObject({ draft: { id: draft.id } });

    // A different draft lands between the scored draft and its score (a concurrent runner).
    const other = await forge.draft(narrative, narrative.names[0]!, { revision: { name: 'Other Cat', ticker: 'OCAT' }, previous: draft });
    await h.bus.append({ launchId: h.ctx.launchId, kind: 'sentinel.score', actor: 'sentinel', payload: { ...s.payload, run: 9 } });
    expect(other.seq).toBeLessThan(h.bus.ofKind('sentinel.score').at(-1)!.seq);
    await expect(assertLaunchCleared(h.ctx)).rejects.toThrow(/Draft changed/);

    // A score without the binding, or naming a draft whose content it did not hash, is not accepted.
    const { draftEventId: _d, contentHash: _c, ...unbound } = s.payload as typeof s.payload & { draftEventId: string; contentHash: string };
    await h.bus.append({ launchId: h.ctx.launchId, kind: 'sentinel.score', actor: 'sentinel', payload: unbound });
    await expect(assertLaunchCleared(h.ctx)).rejects.toThrow(/does not name the draft/);
    await h.bus.append({ launchId: h.ctx.launchId, kind: 'sentinel.score', actor: 'sentinel', payload: { ...s.payload, draftEventId: other.id } as typeof s.payload });
    await expect(assertLaunchCleared(h.ctx)).rejects.toThrow(/content hash does not match/);
  });

  it('a banner or site swapped after the score is a content change (blocked)', async () => {
    for (const field of ['bannerUri', 'siteUri'] as const) {
      const { h, draft, score } = await setup();
      await score();
      await h.bus.append({ launchId: h.ctx.launchId, kind: 'forge.draft', actor: 'forge', payload: { ...draft.payload, [field]: `${draft.payload[field]}-other` } });
      await expect(assertLaunchCleared(h.ctx)).rejects.toThrow(/Draft changed/);
    }
  });
});
