/**
 * Claude provider, for dev and tests when Gemini is unreachable. Never used in production
 * (createLlm enforces that). No image generation.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmRequest, LlmResponse } from '../ports.js';
import { anthropicModel } from './config.js';
import { LlmError } from './gemini.js';

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

export class AnthropicProvider implements LlmProvider {
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

  buildRequest(req: LlmRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content: req.prompt }],
    };
    if (req.system) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.jsonSchema) body.output_config = { format: { type: 'json_schema', schema: req.jsonSchema } };
    if (req.grounding) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    return body;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const msg = (await this.client.messages.create(this.buildRequest(req))) as MessageLike;
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
