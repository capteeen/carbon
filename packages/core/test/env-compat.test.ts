import { describe, expect, it } from 'vitest';
import { applyLegacyEnv } from '../src/env-compat.js';

describe('applyLegacyEnv', () => {
  it('copies CARBON_* onto unset ARGON_* names and never overrides a set one', () => {
    const env: NodeJS.ProcessEnv = { CARBON_NETWORK: 'devnet', CARBON_TOKEN_KEY: 'old', ARGON_TOKEN_KEY: 'new', CARBON_RPC_URL: 'x', ARGON_RPC_URL: '' };
    expect(applyLegacyEnv(env).sort()).toEqual(['ARGON_NETWORK', 'ARGON_RPC_URL']);
    expect(env.ARGON_NETWORK).toBe('devnet');
    expect(env.ARGON_TOKEN_KEY).toBe('new');
    expect(env.ARGON_RPC_URL).toBe('x');
  });
});
