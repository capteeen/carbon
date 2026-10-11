/**
 * SPEC §7: "Every user-facing claim (chemistry, half-lives, Gemini, quantum, fee split,
 * 'Carbon never holds YOUR keys', devnet/mainnet) checked against /docs and code."
 * SPEC §3: "Footer on every page" (exact text). SPEC §7: no fake/sample/mock data in
 * src/, no animations untied to events.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES, FEE_SPLIT_BPS, FOOTER_TEXT, ISOTOPES, SHAPES, VALENCE, launchConfig, selectLlm } from '@carbon/core';
import { renderSite } from '@carbon/agents';
import { carbonShares } from '@carbon/solana';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const git = (...a: string[]) => {
  try {
    return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    if ((e as { status?: number }).status === 1) return ''; // grep: no match
    throw e;
  }
};
const how = read('docs/how.md');

describe('footer: exact SPEC text everywhere it is shown', () => {
  it('FOOTER_TEXT is the SPEC §3 literal, word for word', () => {
    const spec = read('SPEC.md');
    const m = /Footer on every page: "([\s\S]*?)"/.exec(spec);
    expect(m).not.toBeNull();
    expect(FOOTER_TEXT).toBe(m![1]!.replace(/\s+/g, ' ').trim());
  });

  it('the coin site Forge generates carries the same footer', () => {
    const html = renderSite({ name: 'N', ticker: 'T', lore: 'l', tagline: 't', logoUri: 'ipfs://a', bannerUri: 'ipfs://b' });
    const m = /<footer>([\s\S]*?)<\/footer>/.exec(html);
    const text = m![1]!.replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(text).toBe(FOOTER_TEXT);
  });

  it('only the root layout renders <Footer/>, and no nested layout replaces it', () => {
    const layouts = git('ls-files', 'apps/web/src/app/**/layout.tsx', 'apps/web/src/app/layout.tsx').split('\n').filter(Boolean);
    expect(layouts).toEqual(['apps/web/src/app/layout.tsx']);
    expect(read('apps/web/src/app/layout.tsx')).toMatch(/<Footer \/>/);
    expect(read('apps/web/src/components/Footer.tsx')).toMatch(/\{FOOTER_TEXT\}/);
  });
});

describe('chemistry and half-lives', () => {
  it('neutrons are mass number minus 6 protons; 6 agents for 6 protons; valence 4', () => {
    for (const [id, iso] of Object.entries(ISOTOPES)) expect(iso.neutrons).toBe(Number(id.slice(2)) - 6);
    expect(Object.keys(AGENT_ROLES)).toHaveLength(6);
    expect(VALENCE).toBe(4);
    expect(how).toMatch(/Carbon is element 6 because it has 6 protons/);
  });

  it('half-life copy matches physics (C-11 ≈ 20.4 min, C-14 ≈ 5,730 y) and never implies the coin lasts that long', () => {
    expect(how).toMatch(/carbon-11 has a half-life\s+of about 20\.4 minutes/);
    expect(how).toMatch(/carbon-14 has a half-life of about 5,730 years/);
    expect(ISOTOPES['C-14'].decay).toEqual({ kind: 'clock', clockSec: 7 * 24 * 3600 });
    expect(ISOTOPES['C-11'].decay).toEqual({ kind: 'quiet', quietSec: 20 * 60 });
    expect(ISOTOPES['C-12'].stable && ISOTOPES['C-13'].stable).toBe(true);
  });

  // DIAMOND's copy says every agent is TRIPLE-bonded to every other. With valence 4 and five
  // neighbours that is impossible (5 × 3 = 15 bond orders > 4), and the runtime never does it.
  it('[AG-020] shape copy is chemically possible under valence 4 (DIAMOND is not "every agent triple-bonded")', () => {
    expect(SHAPES.diamond.description).not.toMatch(/triple-bonded/i);
  });

  // how.md: "The decay mechanics come from @qsd/protocol; Carbon does not reimplement them."
  // packages/solana/src/decay.ts: qsd's decay state machine is NOT used; collapse timing is
  // Carbon's own deterministic rule. Only naming and airdrop allocation come from qsd.
  it('[AG-014] how.md does not claim decay mechanics come from @qsd/protocol when the code says they do not', () => {
    const decay = read('packages/solana/src/decay.ts');
    const qsdStateMachineUnused = /state machine[\s\S]{0,120}is NOT[\s*]+used/.test(decay);
    expect(qsdStateMachineUnused).toBe(true);
    expect(how).not.toMatch(/decay mechanics come from `@qsd\/protocol`; Carbon\s+does not reimplement them/);
  });

  it('[AG-014] how.md names exactly the @qsd/protocol functions decay.ts imports', () => {
    const decay = read('packages/solana/src/decay.ts');
    const imported = /import \{([^}]*)\} from '@qsd\/protocol'/.exec(decay)![1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('type '));
    const section = how.slice(how.indexOf('### Decay'), how.indexOf('## Shapes'));
    const named = [...section.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]).filter((n) => n !== 'qsd');
    expect(new Set(named)).toEqual(new Set(imported));
    expect(section).toMatch(/not a half-life/);
  });

  // Second pass. AG-020 was fixed in contracts.ts, but the hand-written shapes table in
  // docs/how.md (rendered on /how) still says "Every agent bonded to every other." With valence
  // 4 and five neighbours an agent can never hold all five bonds at once.
  it.fails('[AG-028] how.md does not claim DIAMOND bonds every agent to every other at once', () => {
    const shapes = how.slice(how.indexOf('## Shapes'), how.indexOf('<!-- generated:config-table:start -->'));
    expect(shapes).not.toMatch(/Every agent bonded to every other/);
  });

  // Chapter 04's copy "Every agent holds exactly 4 bonds." (a SPEC §5 literal) contradicts the
  // rule the code and /how state: AT MOST 4 bond orders. An agent with no hand-offs holds 0.
  it.fails('[AG-030] no copy says an agent holds EXACTLY 4 bonds while the rule is at most 4', () => {
    expect(read('packages/visual/src/copy.ts')).not.toMatch(/holds exactly 4 bonds/);
  });

  it('[AG-026] the isotope chamber labels the collapse rule DECAY_RULE, not HALF-LIFE', () => {
    expect(read('packages/visual/src/hud/panels.tsx')).not.toMatch(/label="HALF-LIFE"/);
    expect(read('packages/visual/src/copy.ts')).not.toMatch(/'HALF-LIFE'/);
    expect(read('packages/visual/src/hud/panels.tsx')).toMatch(/label="DECAY_RULE"/);
  });
});

describe('Gemini and quantum', () => {
  it('copy: Gemini, not affiliated with Google, not a quantum computer', () => {
    expect(FOOTER_TEXT).toMatch(/Agents are powered by Google Gemini; Carbon is not affiliated with or endorsed by Google/);
    expect(how).toMatch(/Never runs on a quantum computer/);
    // no copy anywhere claims quantum computation
    const hits = git('grep', '-niE', 'runs on a quantum|quantum[- ]powered|quantum computer powers', '--', 'apps/*/src', 'packages/*/src', 'docs/how.md');
    expect(hits.split('\n').filter((l) => l && !/never runs on a quantum|does not run on a quantum/i.test(l))).toEqual([]);
  });

  it('in production the LLM is Gemini only (never a fallback)', async () => {
    await expect(selectLlm({ env: { NODE_ENV: 'production', ANTHROPIC_API_KEY: 'x' } })).rejects.toThrow(/GEMINI_API_KEY/);
    const s = await selectLlm({ env: { NODE_ENV: 'production', GEMINI_API_KEY: 'k' } });
    expect(s.fallbackReason).toBeNull();
  });

  // Gemini-only hinges on NODE_ENV=production. The worker deploy (apps/worker/railway.json
  // startCommand "pnpm --filter @carbon/worker start" → "tsx src/main.ts") does not set it, and
  // createLlm() drops fallbackReason, so a Gemini outage with ANTHROPIC_API_KEY present would
  // silently switch the agents to Claude while every page says "powered by Google Gemini".
  it('[AG-013] the worker deploy pins NODE_ENV=production (or the fallback is impossible / visible)', () => {
    const rail = JSON.parse(read('apps/worker/railway.json')) as { deploy: { startCommand: string } };
    const start = (JSON.parse(read('apps/worker/package.json')) as { scripts: Record<string, string> }).scripts.start!;
    expect(`${rail.deploy.startCommand} ${start}`).toMatch(/NODE_ENV=production/);
  });
});

describe('fee split: native pump.fun fee sharing, 50/30/20', () => {
  it('the on-chain shareholder list is launcher 5000 / buyback 3000 / treasury 2000, summing to 10000', () => {
    const [l, b, t] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const shares = carbonShares(l, b, t);
    expect(shares.map((s) => [s.address.toBase58(), s.bps])).toEqual([
      [l.toBase58(), 5000],
      [b.toBase58(), 3000],
      [t.toBase58(), 2000],
    ]);
    expect(FEE_SPLIT_BPS).toEqual({ launcher: 5000, carbonBuyback: 3000, treasury: 2000 });
    expect(() => carbonShares(l, l, t)).toThrow();
  });

  it('how.md and /wallets state the same split', () => {
    expect(how).toMatch(/\| The launcher's wallet \| 50% \| 5000 \|/);
    expect(how).toMatch(/\| \$CARBON buyback wallet \| 30% \| 3000 \|/);
    expect(how).toMatch(/\| Carbon treasury \| 20% \| 2000 \|/);
    const wallets = read('apps/web/src/components/WalletsView.tsx');
    expect(wallets).toMatch(/50% to the launcher, 30% to the buyback wallet and 20% to the treasury/);
  });

  it('buybacks per tick in how.md come from the one config table', () => {
    expect(launchConfig('C-12', 'ring').buybackSolPerTick).toBe(0.01);
    expect(how).toMatch(/\| C-12 \| RING \| 70 \| none \(stable\) \| 0\.25 \| 0\.01 \|/);
  });

  // The Treasurer's role (contracts.ts AGENT_ROLES, shown on the home page) still says
  // "Per-launch wallet", the pre-native design; how.md says "The launch's fee address".
  it('[AG-021] the Treasurer role copy matches native fee sharing (no "per-launch wallet")', () => {
    expect(AGENT_ROLES.treasurer).not.toMatch(/per-launch wallet/i);
  });

  // how.md: "Carbon never holds your 50%". True in native mode only. With CARBON_FEE_MODE=wallet
  // (a supported fallback, apps/worker/src/main.ts) Carbon's per-launch wallet receives ALL fees
  // and pays the 50% out; /wallets still says "Native pump.fun fee sharing" for every launch.
  it('[AG-019] the "never holds your 50%" copy is conditional on, or the wallet fallback is absent', () => {
    const walletModeExists = /CARBON_FEE_MODE === 'wallet'/.test(read('apps/worker/src/main.ts'));
    const copyUnconditional = /Carbon never holds your 50%/.test(how) && !/CARBON_FEE_MODE|wallet mode|fallback/i.test(how.slice(how.indexOf('## Money')));
    const walletsPageStatic = /Native pump\.fun fee sharing: the address is the coin/.test(read('apps/web/src/components/WalletsView.tsx'));
    expect(walletModeExists && (copyUnconditional || walletsPageStatic)).toBe(false);
  });

  // Posts autopilot is a real feature (off by default; apps/web /api/autopilot, core approvals),
  // so "you approve every post" is false for a launcher who turned it on. how.md's own "What
  // Carbon never does" gets it right ("without your approval or the posts autopilot you turned
  // on"); the hero manifesto and how.md's intro state it unconditionally.
  it.fails('[AG-029] no copy says the user approves EVERY post without the posts-autopilot exception', () => {
    const hero = read('packages/visual/src/copy.ts');
    expect(hero).not.toMatch(/You approve every launch and post\./);
    const intro = how.slice(0, how.indexOf('## The six protons'));
    expect(intro).not.toMatch(/You approve the launch and every post\./);
  });
});

describe('"Carbon never holds YOUR keys"', () => {
  it('no web route or input type accepts a user secret key or seed phrase', () => {
    expect(git('grep', '-niE', 'secretKey|privateKey|mnemonic|seed ?phrase', '--', 'apps/web/src')).toBe('');
  });

  it('the launch transaction is signed by the user wallet in the browser (signTransaction), never server-side with a user key', () => {
    const flow = read('apps/web/src/components/LaunchFlow.tsx');
    expect(flow).toMatch(/signTx\(tx\.txBase64\)/);
    expect(read('apps/web/src/server/tx.ts')).not.toMatch(/Keypair\.fromSecretKey|fromSeed/);
  });
});

describe('devnet by default', () => {
  it('how.md says devnet by default and mainnet needs an owner setting; the web default is devnet', async () => {
    expect(how).toMatch(/Carbon runs on Solana devnet by default\. Mainnet needs a setting only the\s+owner can change\./);
    const { network } = await import('@/server/env');
    expect(network({} as NodeJS.ProcessEnv)).toBe('devnet');
  });
});

describe('no fake data, no untied animation in src/', () => {
  it('src/ has no Math.random, faker, lorem, or sample/mock/dummy data', () => {
    expect(git('grep', '-nE', 'Math\\.random|faker|lorem|ipsum', '--', 'packages/*/src', 'apps/*/src', ':!packages/visual')).toBe('');
    expect(git('grep', '-niE', '\\b(mock|dummy|fake)[A-Z_a-z]*\\s*[:=(]', '--', 'packages/*/src', 'apps/*/src', ':!packages/visual')).toBe('');
  });

  it('no CSS keyframes or time-driven animation; timers only drive clocks, polling and heartbeats', () => {
    expect(git('grep', '-nE', '@keyframes|requestAnimationFrame', '--', 'apps/*/src', 'packages/*/src', ':!packages/visual')).toBe('');
    const anim = git('grep', '-nE', 'animation\\s*:', '--', 'apps/*/src', ':!packages/visual');
    expect(anim.split('\n').filter(Boolean).every((l) => /animation:\s*none/.test(l))).toBe(true);
  });

  it('test doubles are never exported from src/', () => {
    expect(git('grep', '-nE', 'class (Fake|Mock|Stub|InMemory)|export .*\\b(Fake|Mock|Stub)[A-Z]', '--', 'packages/*/src', 'apps/*/src')).toBe('');
  });
});
