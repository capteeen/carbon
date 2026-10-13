/** Regression tests for the core audit fixes: AG-012, AG-015, AG-017 (once-kinds), AG-022 (keyed budget spends). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchConfig, VALENCE, type ArgonEvent } from '../src/contracts.js';
import { analyzeBonds, bondTotals } from '../src/bonds.js';
import { foldMolecule } from '../src/molecule.js';
import { PgBudgets } from '../src/budgets.js';
import { onceProbe } from '../src/bus/pg-bus.js';
import { createLaunch, testEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await testEnv();
});
afterEach(async () => {
  await env.cleanup();
});

function mk(seq: number, ts: number, kind: ArgonEvent['kind'], actor: ArgonEvent['actor'], payload: unknown): ArgonEvent {
  return { id: seq.toString(16).padStart(64, '0'), seq, launchId: 'L', ts, kind, actor, payload, signer: '', sig: '' } as ArgonEvent;
}

describe('AG-012: a row whose ts goes backwards in seq order is not trusted', () => {
  it('is ignored with a reason and never lifts an agent above valence', () => {
    const log = [
      mk(1, 0, 'launch.created', 'user', { line: 'x', isotope: 'Ar-36', shape: 'diamond', heavyAgent: null, launcherWallet: 'w', xConnected: false }),
      ...(['forge', 'herald', 'keeper', 'treasurer'] as const).map((to, i) => mk(2 + i, 100_000, 'handoff', 'scout', { from: 'scout', to, topic: 't', summary: 's' })),
      mk(6, 50_000, 'handoff', 'scout', { from: 'scout', to: 'sentinel', topic: 't', summary: 'backdated' }),
    ];
    const a = analyzeBonds(log, 100_000);
    expect(a.totals.scout).toBe(VALENCE);
    expect(a.ignoredHandoffs).toEqual([{ id: log[5]!.id, reason: 'ts earlier than its predecessor in seq order' }]);
    // A later, monotonic event after the backdated row is still judged normally.
    const later = [...log, mk(7, 200_000, 'handoff', 'scout', { from: 'scout', to: 'sentinel', topic: 't', summary: 'fresh' })];
    expect(bondTotals(later, 200_000).scout).toBe(1);
  });
});

describe('AG-015: the fold uses the config row threshold', () => {
  it('a passed score below the row threshold is blocked; at or above it awaits approval', () => {
    const base = [
      mk(1, 1, 'launch.created', 'user', { line: 'x', isotope: 'Ar-36', shape: 'ring', heavyAgent: null, launcherWallet: 'w', xConnected: false }),
      mk(2, 2, 'scout.proposals', 'scout', { narratives: [] }),
      mk(3, 3, 'forge.draft', 'forge', { name: 'F', ticker: 'F', lore: 'x', logoUri: 'u', logoHash: '0', bannerUri: 'u', siteUri: 'u' }),
    ];
    const score = (s: number, threshold: number) => mk(4, 4, 'sentinel.score', 'sentinel', { score: s, threshold, hardFail: false, passed: true, run: 1, inputs: [] });
    expect(foldMolecule([...base, score(65, 60)]).state).toBe('blocked'); // ring row: 70
    expect(foldMolecule([...base, score(70, 70)]).state).toBe('awaiting_approval');
    expect(launchConfig('Ar-36', 'ring').sentinelThreshold).toBe(70);
  });
});

describe('AG-017: once-kinds are appended once', () => {
  it('re-appending the same snapshot, collapse, airdrop, claim or buyback returns the stored event', async () => {
    const l = await createLaunch(env.bus, 'chain', 'Ar-39');
    const snap = await env.bus.append({ launchId: l, kind: 'holders.snapshot', actor: 'treasurer', payload: { slot: 9, holderCount: 3 } });
    env.clock.advance(1000);
    const again = await env.bus.append({ launchId: l, kind: 'holders.snapshot', actor: 'treasurer', payload: { slot: 9, holderCount: 3 } });
    expect(again).toEqual(snap);
    const claim = await env.bus.append({ launchId: l, kind: 'fee.claimed', actor: 'treasurer', payload: { claimId: 'c1', lamports: '5', txSig: 's1' } });
    expect((await env.bus.append({ launchId: l, kind: 'fee.claimed', actor: 'treasurer', payload: { claimId: 'c1', lamports: '5', txSig: 's1' } })).id).toBe(claim.id);
    const buy = { lamportsIn: '1', argonOut: '2', txSig: 'b1', funding: 'fee-split' as const, splitId: 'sp' };
    const b = await env.bus.append({ launchId: l, kind: 'buyback.executed', actor: 'treasurer', payload: buy });
    expect((await env.bus.append({ launchId: l, kind: 'buyback.executed', actor: 'treasurer', payload: buy })).seq).toBe(b.seq);
    // Different facts are still appended.
    await env.bus.append({ launchId: l, kind: 'holders.snapshot', actor: 'treasurer', payload: { slot: 10, holderCount: 3 } });
    await env.bus.append({ launchId: l, kind: 'buyback.executed', actor: 'treasurer', payload: { ...buy, txSig: 'b2' } });
    expect(await env.bus.list(l, { kinds: ['holders.snapshot'] })).toHaveLength(2);
    expect(await env.bus.list(l, { kinds: ['buyback.executed'] })).toHaveLength(2);
    expect(await env.bus.list(l, { kinds: ['fee.claimed'] })).toHaveLength(1);
    // Kinds that may repeat have no probe.
    expect(onceProbe('handoff', {})).toBeNull();
    expect(onceProbe('post.published', {})).toBeNull();
  });
});

describe('AG-022: a keyed budget spend is recorded once', () => {
  it('a resumed action spending again under the same key is not counted twice', async () => {
    const l = await createLaunch(env.bus, 'ring');
    const b = new PgBudgets({ bus: env.bus, pool: env.bus.pool, now: env.clock.now });
    const cap = Math.round(launchConfig('Ar-36', 'ring').buybackSolPerTick * 1e9);
    await b.spend(l, 'treasurer', 'buyback-lamports', cap, 'buyback:split-1:1');
    await expect(b.spend(l, 'treasurer', 'buyback-lamports', cap, 'buyback:split-1:1')).resolves.toBeUndefined();
    expect(await b.used(l, 'treasurer', 'buyback-lamports')).toBe(cap);
    // A different action in the same window is still capped.
    await expect(b.spend(l, 'treasurer', 'buyback-lamports', 1, 'buyback:split-1:2')).rejects.toThrow(/over its buyback-lamports budget/);
  });
});
