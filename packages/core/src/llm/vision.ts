/**
 * Optional vision input for LLM providers (AG-035: Sentinel classifies the generated
 * logo and banner against the content rules). Not yet on the LlmProvider port in
 * ports.ts; proposed there as `generateWithImages?`. Gemini (production) and the
 * Claude dev fallback both implement it.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from '../ports.js';

export interface LlmImageInput {
  bytes: Uint8Array;
  mime: string;
}

export interface VisionLlm {
  /** Same as generate(), with images attached to the user turn (in order, after the prompt). */
  generateWithImages(req: LlmRequest, images: LlmImageInput[]): Promise<LlmResponse>;
}

export function hasVision(p: LlmProvider): p is LlmProvider & VisionLlm {
  return typeof (p as Partial<VisionLlm>).generateWithImages === 'function';
}

/** Image types both providers accept inline. */
export const VISION_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
