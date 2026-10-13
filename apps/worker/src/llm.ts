/**
 * The worker's LLM choice (AG-013). Production is Gemini only, whatever NODE_ENV a
 * host defaults to:
 * - The deploy pins NODE_ENV=production (package.json start, railway.json).
 * - A non-Gemini fallback is refused unless ARGON_LLM_ALLOW_FALLBACK=true, and is
 *   never allowed when NODE_ENV=production. The default is false everywhere.
 * - The boot line names the active provider and model, and the fallback reason when
 *   one was used. It never contains a key.
 */
import { selectLlm, type LlmProvider, type LlmSelection } from '@argon/core';

export class LlmFallbackRefusedError extends Error {
  constructor(reason: string) {
    super(`Gemini is not usable (${reason}) and the fallback provider is not allowed (ARGON_LLM_ALLOW_FALLBACK is not "true", or NODE_ENV=production)`);
    this.name = 'LlmFallbackRefusedError';
  }
}

export function fallbackAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== 'production' && env.ARGON_LLM_ALLOW_FALLBACK?.trim() === 'true';
}

/** One boot line: provider id, model, and the fallback reason if any. No secrets. */
export function describeLlm(sel: LlmSelection): string {
  const base = `llm: provider=${sel.provider.id} model=${sel.provider.model}`;
  return sel.fallbackReason === null ? base : `${base} FALLBACK (not Gemini): ${sel.fallbackReason}`;
}

export async function chooseWorkerLlm(
  env: NodeJS.ProcessEnv = process.env,
  select: (opts: { env: NodeJS.ProcessEnv }) => Promise<LlmSelection> = selectLlm,
): Promise<{ provider: LlmProvider; line: string }> {
  const sel = await select({ env });
  if (sel.fallbackReason !== null && !fallbackAllowed(env)) throw new LlmFallbackRefusedError(sel.fallbackReason);
  return { provider: sel.provider, line: describeLlm(sel) };
}
