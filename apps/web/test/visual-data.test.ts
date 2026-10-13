/** Adapters from the web read model to @argon/visual props: real data in, empty states otherwise. */
import { describe, expect, it } from 'vitest';
import { deriveLaunchView } from '@/lib/launch-view';
import { BOND_WINDOW_MS } from '@argon/core/contracts';
import { computeBonds } from '@argon/core/bonds';
import { foldIntoLogs, liveFromLogs, receiptsFromEvents, toVisualDecay, toVisualLaunch, toVisualLaunches, toVisualReplay } from '@/lib/visual-data';
import { summarize } from '@/server/readmodel';
import { ev } from './helpers';

function launchLog(id: string) {
  const created = ev(id, 'launch.created', { line: 'l', isotope: 'Ar-39', shape: 'ring', heavyAgent: null, launcherWallet: 'W', xConnected: false }, 'user');
  const h = ev(id, 'handoff', { from: 'scout', to: 'forge', topic: 't', summary: 's' }, 'scout');
  const draft = ev(id, 'forge.draft', { name: 'N', ticker: 'TKR', lore: 'x', logoUri: 'u', logoHash: 'h', bannerUri: 'b', siteUri: 's' }, 'forge');
  const dep = ev(id, 'launch.deployed', { ca: `${id}CA`, txSig: 't', creatorWallet: 'c', devBuySol: 0.1, network: 'devnet' });
  return [created, h, draft, dep];
}

describe('visual-data adapters', () => {
  it('empty log → no live stats, no replay, no crystals, no receipts', () => {
    expect(liveFromLogs([], new Map(), 0)).toBeNull();
    expect(toVisualReplay(null)).toBeNull();
    expect(toVisualLaunches([])).toEqual([]);
    expect(receiptsFromEvents([])).toEqual([]);
  });

  it('an undeployed launch is not a crystal; a deployed one carries its deploy event id', () => {
    const log = launchLog('a');
    const undeployed = summarize(log.slice(0, 3))[0]!;
    expect(toVisualLaunch(undeployed)).toBeNull();
    const deployed = summarize(log)[0]!;
    const v = toVisualLaunch(deployed)!;
    expect(v.deployEventId).toBe(log[3]!.id);
    expect(v.ticker).toBe('TKR');
    expect(v.collapsed).toBe(false);
  });

  it('replay is built from the real log with core bonds at deploy', () => {
    const log = launchLog('b');
    const r = toVisualReplay({ launchId: 'b', ca: 'bCA', ticker: 'TKR', date: '2027-01-15', events: log })!;
    expect(r.ticker).toBe('TKR');
    expect(r.handoffs.map((h) => h.id)).toEqual([log[1]!.id]);
    expect(r.bondsAtDeploy?.[0]?.lastHash).toBe(log[1]!.id);
  });

  it('live stats come from logged hand-offs only; BONDS from the active launch full log at display time', () => {
    const log = launchLog('c');
    const live = liveFromLogs(log, new Map([['c', log]]), log[3]!.ts)!;
    expect(live.recentHandoffs.map((f) => f.hash)).toEqual([log[1]!.id]);
    expect(live.molecule).toEqual({ launchId: 'c', ticker: 'TKR' });
    expect(live.agents.scout!.bondOrders).toBe(computeBonds(log, log[3]!.ts)[0]!.order);
    // 2 minutes later with no new event: the bond has aged out of the 60 s window
    const later = liveFromLogs(log, new Map([['c', log]]), log[3]!.ts + 2 * BOND_WINDOW_MS)!;
    expect(later.agents.scout!.bondOrders).toBe(0);
  });

  it('BONDS is unknown (null) until the active launch full log is loaded; never counted from the window', () => {
    const log = launchLog('e');
    const live = liveFromLogs(log.slice(1), new Map(), log[3]!.ts)!;
    expect(live.molecule?.launchId).toBe('e');
    expect(live.agents.scout!.bondOrders).toBeNull();
  });

  it('foldIntoLogs extends only loaded launch logs with newer streamed events', () => {
    const a = launchLog('f');
    const b = launchLog('g');
    const logs = new Map([['f', a.slice(0, 2)]]);
    const next = foldIntoLogs(logs, [...a, ...b]);
    expect(next.get('f')!.map((e) => e.id)).toEqual(a.map((e) => e.id));
    expect(next.has('g')).toBe(false);
    expect(foldIntoLogs(next, a)).toBe(next);
  });

  it('decay: none for stable rules, null for the quiet rule until it collapses, clock from decay.started', () => {
    const log = launchLog('d');
    expect(toVisualDecay(log, deriveLaunchView('d', log).decay)).toBeNull();
    const started = ev('d', 'decay.started', { rule: 'clock', collapseAt: log[3]!.ts + 1000 });
    const withClock = [...log, started];
    const d = toVisualDecay(withClock, deriveLaunchView('d', withClock).decay)!;
    expect(d).toEqual({ kind: 'clock', startedAt: started.ts, deadline: started.payload.collapseAt, collapsedEventId: null });
  });
});
