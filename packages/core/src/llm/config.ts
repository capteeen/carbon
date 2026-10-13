/**
 * LLM model ids. Changing the model = changing ONE value here (or its env override).
 *
 * Source: Google Gemini API "Models" page, https://ai.google.dev/gemini-api/docs/models
 * (page last updated 2026-10-09 UTC; read 2026-10-11). It recommends "3.5 Flash-Lite or
 * 3.8 Flash" for new projects; Argon's agents need Google Search grounding together with
 * JSON-schema structured output (supported on Gemini 3 series models per
 * https://ai.google.dev/gemini-api/docs/structured-output, updated 2026-09-23), so the
 * default is the stable `gemini-3.8-flash`.
 *
 * Image model: the same Models page lists `gemini-nano-banana-2.1` (stable, new) for
 * image generation and editing; https://ai.google.dev/gemini-api/docs/image-generation
 * (read 2026-10-11) uses it in its examples via the Interactions API.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1';

/** Dev fallback only (never used in production). */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';

/** THE text model: ARGON_LLM_MODEL, else the documented default above. */
export function geminiModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARGON_LLM_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/** THE image model: ARGON_LLM_IMAGE_MODEL, else the documented default above. */
export function geminiImageModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARGON_LLM_IMAGE_MODEL?.trim() || DEFAULT_GEMINI_IMAGE_MODEL;
}

export function anthropicModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARGON_ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
}

export const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com';
