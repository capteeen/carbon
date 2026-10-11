import { describe, it, expect } from 'vitest';
import { checkHealth } from '../src/server/health';

describe('/api/health', () => {
  it('names every missing setting without leaking values', async () => {
    const h = await checkHealth({} as NodeJS.ProcessEnv);
    expect(h.ok).toBe(false);
    const states = Object.fromEntries(h.checks.map((c) => [c.name, c.state]));
    expect(states).toMatchObject({ CARBON_AGENT_KEY_SEED: 'missing', DATABASE_URL: 'missing', REDIS_URL: 'missing', schema: 'skipped' });
  });

  it('reports unreachable services and an invalid seed, never echoing the values', async () => {
    const env = { CARBON_AGENT_KEY_SEED: 'nothex', DATABASE_URL: 'postgres://u:secretpw@127.0.0.1:1/db', REDIS_URL: 'redis://:secretpw@127.0.0.1:1' } as unknown as NodeJS.ProcessEnv;
    const h = await checkHealth(env);
    const states = Object.fromEntries(h.checks.map((c) => [c.name, c.state]));
    expect(states).toMatchObject({ CARBON_AGENT_KEY_SEED: 'invalid', DATABASE_URL: 'unreachable', REDIS_URL: 'unreachable' });
    expect(JSON.stringify(h)).not.toMatch(/secretpw|127\.0\.0\.1|nothex/);
  });

  it('is ok against the local services with a migrated schema', async () => {
    const env = { CARBON_AGENT_KEY_SEED: 'ab'.repeat(32), DATABASE_URL: 'postgres://carbon:carbon@localhost:5432/carbon', REDIS_URL: 'redis://localhost:6379' } as unknown as NodeJS.ProcessEnv;
    const h = await checkHealth(env);
    const states = Object.fromEntries(h.checks.map((c) => [c.name, c.state]));
    expect(states.DATABASE_URL).toBe('ok');
    expect(states.REDIS_URL).toBe('ok');
    expect(['ok', 'not_migrated']).toContain(states.schema);
  });
});
