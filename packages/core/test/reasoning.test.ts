import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitReasoning, ReasoningError } from '../src/reasoning.js';
import { createLaunch, testEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await testEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe('emitReasoning', () => {
  it('ties reasoning to an existing event of the same launch', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const h = await env.bus.append({ launchId: l, kind: 'handoff', actor: 'scout', payload: { from: 'scout', to: 'forge', topic: 'narratives', summary: 's' } });
    const r = await emitReasoning(env.bus, l, 'scout', h.id, '  Picked the frog narrative: 3 sources in the last hour.  ');
    expect(r.payload).toEqual({ agent: 'scout', forEventId: h.id, text: 'Picked the frog narrative: 3 sources in the last hour.' });
    expect(r.actor).toBe('scout');
    expect(env.bus.verify(r)).toBe(true);
  });

  it('refuses empty text and unknown or foreign event ids', async () => {
    const l = await createLaunch(env.bus, 'chain');
    const other = await createLaunch(env.bus, 'chain');
    const [created] = await env.bus.list(l);
    const [otherCreated] = await env.bus.list(other);
    await expect(emitReasoning(env.bus, l, 'scout', created!.id, '   ')).rejects.toThrow(ReasoningError);
    await expect(emitReasoning(env.bus, l, 'scout', 'f'.repeat(64), 'why')).rejects.toThrow(/not in launch/);
    await expect(emitReasoning(env.bus, l, 'scout', otherCreated!.id, 'why')).rejects.toThrow(/not in launch/);
    await expect(emitReasoning(env.bus, l, 'scout', 'abc', 'why')).rejects.toThrow(/not an event id/);
    expect(await env.bus.list(l, { kinds: ['reasoning'] })).toEqual([]);
  });
});
