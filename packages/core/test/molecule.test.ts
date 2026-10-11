import { describe, expect, it } from 'vitest';
import { foldMolecule } from '../src/molecule.js';
import { LogBuilder, WALLET } from './helpers.js';

const score = (passed: boolean, hardFail = false) => ({
  score: passed ? 80 : 40,
  threshold: 70,
  inputs: [],
  hardFail,
  passed,
  run: 1,
});
const draft = { name: 'N', ticker: 'T', lore: 'l', logoUri: 'u', logoHash: 'h', bannerUri: 'b', siteUri: 's' };

function happyPath(isotope: 'C-12' | 'C-11' = 'C-12') {
  const log = new LogBuilder();
  log.created('ring', 0, isotope);
  log.add(1, 'reasoning', 'scout', { agent: 'scout', forEventId: log.events[0]!.id, text: 'searching trends' });
  log.add(2, 'scout.proposals', 'scout', { narratives: [] });
  log.add(3, 'forge.draft', 'forge', draft);
  return log;
}

describe('molecule state machine', () => {
  it('walks draft → … → live via events only', () => {
    const log = happyPath();
    log.add(4, 'sentinel.score', 'sentinel', score(true));
    log.add(5, 'approval.requested', 'forge', { approvalId: 'a1', action: 'launch', draft: {}, expiresAt: null });
    log.add(6, 'approval.granted', 'user', { approvalId: 'a1', by: WALLET, viaAutopilot: false });
    log.add(7, 'launch.deployed', 'treasurer', { ca: 'CA1', txSig: 'sig', creatorWallet: 'w', devBuySol: 0.25, network: 'devnet' });
    const s = foldMolecule(log.events);
    expect(s.history.map((h) => h.state)).toEqual(['draft', 'scouting', 'forging', 'checking', 'awaiting_approval', 'deploying', 'live']);
    expect(s.state).toBe('live');
    expect(s.ca).toBe('CA1');
  });

  it('Sentinel below threshold or hard fail blocks; a revised draft re-checks', () => {
    const log = happyPath();
    log.add(4, 'sentinel.score', 'sentinel', score(false));
    expect(foldMolecule(log.events).state).toBe('blocked');
    // Cannot deploy while blocked.
    log.add(5, 'launch.deployed', 'treasurer', { ca: 'X', txSig: 's', creatorWallet: 'w', devBuySol: 0, network: 'devnet' });
    expect(foldMolecule(log.events).state).toBe('blocked');
    log.add(6, 'forge.draft', 'forge', { ...draft, name: 'N2' });
    expect(foldMolecule(log.events).state).toBe('checking');
    log.add(7, 'sentinel.score', 'sentinel', { ...score(true), hardFail: true, passed: false });
    expect(foldMolecule(log.events).state).toBe('blocked');
  });

  it('a launch approval granted via autopilot, or for another approval, does not deploy', () => {
    const log = happyPath();
    log.add(4, 'sentinel.score', 'sentinel', score(true));
    log.add(5, 'approval.requested', 'forge', { approvalId: 'a1', action: 'launch', draft: {}, expiresAt: null });
    log.add(6, 'approval.granted', 'system', { approvalId: 'a1', by: 'autopilot', viaAutopilot: true });
    log.add(7, 'approval.granted', 'user', { approvalId: 'other', by: WALLET, viaAutopilot: false });
    expect(foldMolecule(log.events).state).toBe('awaiting_approval');
  });

  it('unstable isotopes decay and collapse; stable ones do not', () => {
    for (const iso of ['C-11', 'C-12'] as const) {
      const log = happyPath(iso);
      log.add(4, 'sentinel.score', 'sentinel', score(true));
      log.add(5, 'approval.requested', 'forge', { approvalId: 'a1', action: 'launch', draft: {}, expiresAt: null });
      log.add(6, 'approval.granted', 'user', { approvalId: 'a1', by: WALLET, viaAutopilot: false });
      log.add(7, 'launch.deployed', 'treasurer', { ca: 'CA', txSig: 's', creatorWallet: 'w', devBuySol: 0.1, network: 'devnet' });
      const snap = log.add(8, 'holders.snapshot', 'treasurer', { slot: 1, holderCount: 3 });
      log.add(9, 'decay.collapsed', 'system', { at: 9, reason: 'quiet', snapshotEventId: snap.id });
      const s = foldMolecule(log.events);
      expect(s.state).toBe(iso === 'C-11' ? 'collapsed' : 'live');
    }
  });

  it('deploy error → failed', () => {
    const log = happyPath();
    log.add(4, 'sentinel.score', 'sentinel', score(true));
    log.add(5, 'approval.requested', 'forge', { approvalId: 'a1', action: 'launch', draft: {}, expiresAt: null });
    log.add(6, 'approval.granted', 'user', { approvalId: 'a1', by: WALLET, viaAutopilot: false });
    log.add(7, 'error', 'treasurer', { agent: 'treasurer', message: 'tx failed' });
    expect(foldMolecule(log.events).state).toBe('failed');
  });

  it('replay is identical (pure fold, order-independent input)', () => {
    const log = happyPath();
    log.add(4, 'sentinel.score', 'sentinel', score(true));
    const a = foldMolecule(log.events);
    const b = foldMolecule(JSON.parse(JSON.stringify([...log.events].reverse())));
    expect(b).toEqual(a);
  });

  it('no launch.created → no state', () => {
    const log = new LogBuilder();
    log.add(1, 'scout.proposals', 'scout', { narratives: [] });
    expect(foldMolecule(log.events).state).toBeNull();
  });
});
