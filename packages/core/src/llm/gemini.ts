/**
 * Gemini provider (default) on the official @google/genai SDK, using the Interactions
 * API that Google's current docs use for text, structured output, Google Search
 * grounding and native image generation.
 *
 * - Structured output: response_format {type:'text', mime_type:'application/json', schema}
 *   (https://ai.google.dev/gemini-api/docs/structured-output).
 * - Grounding: tools [{type:'google_search'}]; source URLs come from the `url_citation`
 *   annotations on the model's text output (https://ai.google.dev/gemini-api/docs/google-search).
 * - Images: response_format {type:'image', aspect_ratio}; bytes from output_image.data (base64)
 *   (https://ai.google.dev/gemini-api/docs/image-generation).
 * - Temperature: the Interactions API's generation_config in @google/genai 2.24 has no
 *   temperature field (Gemini 3 models are tuned for their default), so req.temperature is
 *   not sent.
 */
import { GoogleGenAI } from '@google/genai';
import type { LlmProvider, LlmRequest, LlmResponse } from '../ports.js';
import { geminiImageModel, geminiModel } from './config.js';
import type { LlmImageInput, VisionLlm } from './vision.js';

/** The slice of the SDK this provider uses (lets tests inject a stub). */
export interface GeminiInteractionsClient {
  interactions: { create(params: Record<string, unknown>): Promise<unknown> };
}

interface InteractionLike {
  status?: string;
  output_text?: string;
  output_image?: { data?: string; mime_type?: string; uri?: string };
  steps?: { type: string; content?: { type: string; text?: string; annotations?: { type: string; url?: string }[] }[]; error?: { message?: string } }[];
}

export class LlmError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'LlmError';
  }
}

/** The SDK supports only these image aspect ratios; '3:1' banners use the nearest wide ratio. */
const ASPECT: Record<'1:1' | '3:1', string> = { '1:1': '1:1', '3:1': '21:9' };

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  imageModel?: string;
  /** Injected client (tests). Defaults to new GoogleGenAI({ apiKey }). */
  client?: GeminiInteractionsClient;
  /** Env to read model ids from (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export class GeminiProvider implements LlmProvider, VisionLlm {
  readonly id = 'gemini';
  readonly model: string;
  readonly imageModel: string;
  private readonly client: GeminiInteractionsClient;

  constructor(opts: GeminiProviderOptions = {}) {
    this.model = opts.model ?? geminiModel(opts.env);
    this.imageModel = opts.imageModel ?? geminiImageModel(opts.env);
    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) throw new LlmError('GEMINI_API_KEY is not set');
      this.client = new GoogleGenAI({ apiKey }) as unknown as GeminiInteractionsClient;
    }
  }

  /** Request body for a text generation (exported for tests and audits). */
  buildRequest(req: LlmRequest, images: LlmImageInput[] = []): Record<string, unknown> {
    // With images, the input is a list of content parts: the prompt text, then each image inline.
    const input = images.length
      ? [{ type: 'text', text: req.prompt }, ...images.map((i) => ({ type: 'image', data: Buffer.from(i.bytes).toString('base64'), mime_type: i.mime }))]
      : req.prompt;
    const body: Record<string, unknown> = { model: this.model, input };
    if (req.system) body.system_instruction = req.system;
    if (req.grounding) body.tools = [{ type: 'google_search' }];
    if (req.jsonSchema) body.response_format = { type: 'text', mime_type: 'application/json', schema: req.jsonSchema };
    return body;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    return this.run(req, []);
  }

  /** Vision: the prompt plus inline images (Interactions API image content parts). */
  async generateWithImages(req: LlmRequest, images: LlmImageInput[]): Promise<LlmResponse> {
    if (!images.length) throw new LlmError('generateWithImages needs at least one image');
    return this.run(req, images);
  }

  private async run(req: LlmRequest, images: LlmImageInput[]): Promise<LlmResponse> {
    const res = (await this.client.interactions.create(this.buildRequest(req, images))) as InteractionLike;
    assertCompleted(res);
    const text = res.output_text ?? textFromSteps(res);
    let json: unknown;
    if (req.jsonSchema) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError('Gemini returned text that is not valid JSON for the requested schema');
      }
    }
    return { text, ...(req.jsonSchema ? { json } : {}), provider: this.id, model: this.model, sources: citationUrls(res) };
  }

  async generateImage(prompt: string, aspect: '1:1' | '3:1'): Promise<{ bytes: Uint8Array; mime: string; model: string }> {
    const res = (await this.client.interactions.create({
      model: this.imageModel,
      input: prompt,
      response_format: { type: 'image', aspect_ratio: ASPECT[aspect] },
    })) as InteractionLike;
    assertCompleted(res);
    const img = res.output_image;
    if (!img?.data) throw new LlmError('Gemini returned no image');
    return { bytes: new Uint8Array(Buffer.from(img.data, 'base64')), mime: img.mime_type ?? 'image/png', model: this.imageModel };
  }
}

function assertCompleted(res: InteractionLike): void {
  if (!res || typeof res !== 'object') throw new LlmError('empty Gemini response');
  if (res.status && res.status !== 'completed') {
    const err = res.steps?.find((s) => s.error)?.error?.message;
    throw new LlmError(`Gemini interaction ${res.status}${err ? `: ${err}` : ''}`);
  }
}

function textFromSteps(res: InteractionLike): string {
  const outs = (res.steps ?? []).filter((s) => s.type === 'model_output');
  const last = outs[outs.length - 1];
  return (last?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

/** Unique url_citation URLs from model output, in order of appearance. */
export function citationUrls(res: InteractionLike): string[] {
  const urls: string[] = [];
  for (const s of res.steps ?? []) {
    if (s.type !== 'model_output') continue;
    for (const c of s.content ?? []) {
      for (const a of c.annotations ?? []) {
        if (a.type === 'url_citation' && a.url && /^https?:\/\//.test(a.url) && !urls.includes(a.url)) urls.push(a.url);
      }
    }
  }
  return urls;
}
