import type { LlmProvider } from '../ports.js';
import { AnthropicProvider, type AnthropicMessagesClient } from './anthropic.js';
import { GEMINI_API_ORIGIN, anthropicModel } from './config.js';
import { GeminiProvider, LlmError, type GeminiInteractionsClient } from './gemini.js';

export interface CreateLlmOptions {
  env?: NodeJS.ProcessEnv;
  /** Used for the Gemini reachability probe (outside production only). */
  fetch?: typeof fetch;
  probeTimeoutMs?: number;
  geminiClient?: GeminiInteractionsClient;
  anthropicClient?: AnthropicMessagesClient;
}

export interface LlmSelection {
  provider: LlmProvider;
  /** Why a fallback was chosen; null when Gemini was selected. Contains no secrets. */
  fallbackReason: string | null;
}

/** Is the Gemini API reachable with this key? Sends the key only as a header to Google. */
export async function probeGemini(apiKey: string, f: typeof fetch = fetch, timeoutMs = 4000): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await f(`${GEMINI_API_ORIGIN}/v1beta/models?pageSize=1`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? { ok: true, reason: 'reachable' } : { ok: false, reason: `Gemini API answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: `Gemini API unreachable (${err instanceof Error ? err.name : 'error'})` };
  }
}

/**
 * Picks the LLM provider.
 * - NODE_ENV=production: Gemini ONLY; throws if GEMINI_API_KEY is missing. Never falls back.
 * - Otherwise: Gemini when GEMINI_API_KEY is set and the API answers; else Claude
 *   (ANTHROPIC_API_KEY) for development; throws if neither is usable.
 */
export async function selectLlm(opts: CreateLlmOptions = {}): Promise<LlmSelection> {
  const env = opts.env ?? process.env;
  const geminiKey = env.GEMINI_API_KEY;
  const gemini = () =>
    new GeminiProvider({
      ...(geminiKey ? { apiKey: geminiKey } : {}),
      ...(opts.geminiClient ? { client: opts.geminiClient } : {}),
      env,
    });

  if (env.NODE_ENV === 'production') {
    if (!geminiKey) throw new LlmError('GEMINI_API_KEY is required in production (Gemini is the only production provider)');
    return { provider: gemini(), fallbackReason: null };
  }

  let reason: string;
  if (geminiKey) {
    const probe = await probeGemini(geminiKey, opts.fetch ?? fetch, opts.probeTimeoutMs);
    if (probe.ok) return { provider: gemini(), fallbackReason: null };
    reason = probe.reason;
  } else {
    reason = 'GEMINI_API_KEY is not set';
  }
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey && !opts.anthropicClient) {
    throw new LlmError(`${reason}, and ANTHROPIC_API_KEY is not set for the development fallback`);
  }
  return {
    provider: new AnthropicProvider({
      ...(anthropicKey ? { apiKey: anthropicKey } : {}),
      ...(opts.anthropicClient ? { client: opts.anthropicClient } : {}),
      model: anthropicModel(env),
    }),
    fallbackReason: reason,
  };
}

export async function createLlm(opts: CreateLlmOptions = {}): Promise<LlmProvider> {
  return (await selectLlm(opts)).provider;
}
