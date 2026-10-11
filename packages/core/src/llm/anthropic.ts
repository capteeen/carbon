/**
 * Claude provider, for dev and tests when Gemini is unreachable. Never used in production
 * (createLlm enforces that). No image generation; vision input (generateWithImages) is supported.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmRequest, LlmResponse } from '../ports.js';
import { anthropicModel } from './config.js';
import { LlmError } from './gemini.js';
import type { LlmImageInput, VisionLlm } from './vision.js';

/** The slice of the SDK this provider uses (lets tests inject a stub). */
export interface AnthropicMessagesClient {
  messages: { create(params: Record<string, unknown>): Promise<unknown> };
}

interface MessageLike {
  stop_reason?: string | null;
  content?: { type: string; text?: string; citations?: { type?: string; url?: string }[] | null }[];
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  client?: AnthropicMessagesClient;
  maxTokens?: number;
}

export class AnthropicProvider implements LlmProvider, VisionLlm {
  readonly id = 'anthropic';
  readonly model: string;
  private readonly client: AnthropicMessagesClient;
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.model = opts.model ?? anthropicModel();
    this.maxTokens = opts.maxTokens ?? 4096;
    if (opts.client) this.client = opts.client;
    else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new LlmError('ANTHROPIC_API_KEY is not set');
      this.client = new Anthropic({ apiKey }) as unknown as AnthropicMessagesClient;
    }
  }

  buildRequest(req: LlmRequest, images: LlmImageInput[] = []): Record<string, unknown> {
    const content = images.length
      ? [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: Buffer.from(i.bytes).toString('base64') } })),
          { type: 'text', text: req.prompt },
        ]
      : req.prompt;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content }],
    };
    if (req.system) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.jsonSchema) body.output_config = { format: { type: 'json_schema', schema: req.jsonSchema } };
    if (req.grounding) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    return body;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    return this.run(req, []);
  }

  /** Vision: images as base64 image blocks before the prompt text. */
  async generateWithImages(req: LlmRequest, images: LlmImageInput[]): Promise<LlmResponse> {
    if (!images.length) throw new LlmError('generateWithImages needs at least one image');
    return this.run(req, images);
  }

  private async run(req: LlmRequest, images: LlmImageInput[]): Promise<LlmResponse> {
    const msg = (await this.client.messages.create(this.buildRequest(req, images))) as MessageLike;
    if (msg.stop_reason === 'refusal') throw new LlmError('Claude declined the request');
    const blocks = (msg.content ?? []).filter((b) => b.type === 'text');
    const text = blocks.map((b) => b.text ?? '').join('');
    let json: unknown;
    if (req.jsonSchema) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError('Claude returned text that is not valid JSON for the requested schema');
      }
    }
    const sources: string[] = [];
    for (const b of blocks) for (const c of b.citations ?? []) if (c.url && !sources.includes(c.url)) sources.push(c.url);
    return { text, ...(req.jsonSchema ? { json } : {}), provider: this.id, model: this.model, sources };
  }
}
