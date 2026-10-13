import { readFileSync } from 'node:fs';
import type { LlmProvider, LlmSelection } from '@argon/core';
import { describe, expect, it } from 'vitest';
import { chooseWorkerLlm, describeLlm, fallbackAllowed, LlmFallbackRefusedError } from '../src/llm.js';

const provider = (id: string, model: string) => ({ id, model }) as unknown as LlmProvider;
const gemini: LlmSelection = { provider: provider('gemini', 'gemini-3.8-flash'), fallbackReason: null };
const claude: LlmSelection = { provider: provider('anthropic', 'claude-haiku-5-5'), fallbackReason: 'GEMINI_API_KEY is not set' };

describe('worker LLM choice (AG-013)', () => {
  it('the deploy pins NODE_ENV=production in both the start script and railway.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    const rail = JSON.parse(readFileSync(new URL('../railway.json', import.meta.url), 'utf8')) as { deploy: { startCommand: string } };
    expect(pkg.scripts.start).toMatch(/^NODE_ENV=production /);
    expect(rail.deploy.startCommand).toMatch(/^NODE_ENV=production /);
  });

  it('a fallback is refused by default, and always in production', async () => {
    expect(fallbackAllowed({})).toBe(false);
    expect(fallbackAllowed({ ARGON_LLM_ALLOW_FALLBACK: 'true' })).toBe(true);
    expect(fallbackAllowed({ NODE_ENV: 'production', ARGON_LLM_ALLOW_FALLBACK: 'true' })).toBe(false);
    await expect(chooseWorkerLlm({}, async () => claude)).rejects.toBeInstanceOf(LlmFallbackRefusedError);
    await expect(chooseWorkerLlm({ NODE_ENV: 'production', ARGON_LLM_ALLOW_FALLBACK: 'true' }, async () => claude)).rejects.toBeInstanceOf(LlmFallbackRefusedError);
    const dev = await chooseWorkerLlm({ ARGON_LLM_ALLOW_FALLBACK: 'true' }, async () => claude);
    expect(dev.line).toMatch(/FALLBACK \(not Gemini\): GEMINI_API_KEY is not set/);
  });

  it('the boot line names provider and model and contains no key', async () => {
    const env = { NODE_ENV: 'production', GEMINI_API_KEY: 'k-secret-value' };
    const r = await chooseWorkerLlm(env, async () => gemini);
    expect(r.line).toBe('llm: provider=gemini model=gemini-3.8-flash');
    expect(r.line).not.toContain('k-secret-value');
    expect(describeLlm(gemini)).not.toMatch(/FALLBACK/);
  });

  it('production with the real selector and no Gemini key refuses to boot', async () => {
    await expect(chooseWorkerLlm({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'x' })).rejects.toThrow(/GEMINI_API_KEY/);
  });
});
