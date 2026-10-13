import type { ArgonEvent, LaunchConfig, XPost } from '@argon/core';
import { expect } from 'vitest';
import type { LaunchUser } from '../src/molecule-runner.js';
import { FORGE_SYSTEM, HERALD_SYSTEM, KEEPER_SYSTEM, SCOUT_SYSTEM, SENTINEL_CONTENT_SYSTEM, SENTINEL_IMAGE_SYSTEM } from '../src/prompts/index.js';
import { xPostUrl } from '../src/scout/index.js';
import { AGENTS, type FakeBus, type Harness, type Script, harness, snowflake } from './fakes.js';

export const GROUNDED = 'https://web.test/grounded-article';

export function xPosts(now: number): XPost[] {
  return [
    { id: snowflake(now - 2 * 3_600_000, 1), text: 'frost cats are everywhere today', authorId: 'a1', createdAt: new Date(now - 2 * 3_600_000).toISOString() },
    { id: snowflake(now - 5 * 3_600_000, 2), text: 'the ice age meta is back', authorId: 'a2', createdAt: new Date(now - 5 * 3_600_000).toISOString() },
  ];
}

export interface ScriptOpts {
  posts: XPost[];
  name?: string;
  ticker?: string;
  violations?: { rule: string; evidence: string }[];
  classifierThrows?: boolean;
  /** What the image (vision) classifier reports for the logo and banner. */
  imageViolations?: { rule: string; evidence: string }[];
  imageClassifierThrows?: boolean;
}

export function standardScript(o: ScriptOpts): Script {
  return (req) => {
    if (req.system === SCOUT_SYSTEM) {
      const [p1, p2] = o.posts;
      const narratives = [
        { title: 'Frost cats', names: [{ name: o.name ?? 'Frost Cat', ticker: o.ticker ?? 'FROSTCAT' }], why: 'Cats in ice are trending on X today.', sources: [p1 ? xPostUrl(p1.id) : GROUNDED, 'https://made.up/never-returned'] },
        { title: 'Ice age meta', names: [{ name: 'Glacier', ticker: '$glac' }], why: 'Ice-age jokes are spreading.', sources: [p2 ? p2.id : GROUNDED] },
        { title: 'Invented', names: [{ name: 'Nope', ticker: 'NOPE' }], why: 'No real source.', sources: ['https://invented.test/x'] },
      ];
      return { json: { narratives, reasoning: 'Two live clusters around frost cats and ice-age jokes.' }, sources: [GROUNDED] };
    }
    if (req.system === FORGE_SYSTEM) {
      return {
        json: {
          name: o.name ?? 'Frost Cat',
          ticker: o.ticker ?? 'FROSTCAT',
          lore: 'A cat that fell asleep on a glacier and woke up as a meme.',
          tagline: 'Cold paws, warm hearts.',
          logoPrompt: 'frosted cat emblem',
          bannerPrompt: 'foggy glacier plain',
          reasoning: 'Kept the chosen name; leaned into frost visuals.',
        },
      };
    }
    if (req.system === SENTINEL_CONTENT_SYSTEM) {
      if (o.classifierThrows) throw new Error('classifier 503');
      return { json: { violations: o.violations ?? [], reasoning: 'No rule hits.' } };
    }
    if (req.system === SENTINEL_IMAGE_SYSTEM) {
      if (o.imageClassifierThrows) throw new Error('vision 503');
      return { json: { violations: o.imageViolations ?? [], reasoning: 'Nothing in the images breaks a rule.' } };
    }
    if (req.system === HERALD_SYSTEM) {
      return { json: { text: 'Frost Cat is live. A meme on a glacier.', reasoning: 'Short, factual announcement.' } };
    }
    if (req.system === KEEPER_SYSTEM) {
      if (req.prompt.includes('Mention from')) return { json: { reply: 'Thanks for stopping by the glacier!', reasoning: 'Friendly mention; thank them.' } };
      return { json: { text: 'Help us build the glacier: memes, art, translations.', reasoning: 'Invite helpers without promises.' } };
    }
    throw new Error(`unscripted system prompt: ${req.system.slice(0, 40)}`);
  };
}

export const user: LaunchUser = {
  chooseNarrative: async () => ({ narrative: 0, name: 0 }),
  signLaunchTx: async ({ txBase64 }) => `signed:${txBase64}`,
};

export async function created(h: Harness, cfg: LaunchConfig, line = 'frost cats on a glacier'): Promise<ArgonEvent<'launch.created'>> {
  return h.bus.append({
    launchId: h.ctx.launchId,
    kind: 'launch.created',
    actor: 'user',
    payload: { line, isotope: cfg.isotope, shape: cfg.shape, heavyAgent: cfg.heavyAgent, launcherWallet: 'LauncherWa11et11111111111111111111111111111', xConnected: true },
  });
}

/** Kinds that are not agent actions (bookkeeping emitted by core on the agent's behalf, or reasoning itself). */
const NOT_ACTIONS = new Set(['reasoning', 'handoff.queued', 'agent.blocked', 'agent.unblocked', 'budget.exceeded']);

/** Every agent action has a reasoning event, by the same agent, pointing at that real event id. */
export function expectReasoningForEveryAction(bus: FakeBus) {
  const ids = new Set(bus.events.map((e) => e.id));
  const reasons = bus.ofKind('reasoning');
  for (const r of reasons) {
    expect(ids.has(r.payload.forEventId), `reasoning points at a real event: ${r.payload.text}`).toBe(true);
    expect(r.payload.text.length).toBeLessThanOrEqual(240);
    expect(r.payload.text.length).toBeGreaterThan(0);
  }
  const actions = bus.events.filter((e) => AGENTS.has(e.actor) && !NOT_ACTIONS.has(e.kind));
  expect(actions.length).toBeGreaterThan(0);
  for (const a of actions) {
    const r = reasons.filter((x) => x.payload.forEventId === a.id && x.payload.agent === a.actor);
    expect(r.length, `reasoning for ${a.kind} by ${a.actor}`).toBeGreaterThanOrEqual(1);
  }
}

export function makeHarness(cfg: LaunchConfig, o: Partial<ScriptOpts> = {}): Harness {
  let posts: XPost[] = [];
  const h = harness(cfg, (req) => standardScript({ posts, ...o })(req));
  posts = o.posts ?? xPosts(h.clock.now());
  h.x.searchResult = posts;
  return h;
}
