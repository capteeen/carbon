import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/llm/gemini.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { hasVision } from '../src/llm/vision.js';
import { createLlm, selectLlm } from '../src/llm/create.js';
import { DEFAULT_GEMINI_IMAGE_MODEL, DEFAULT_GEMINI_MODEL, geminiImageModel, geminiModel } from '../src/llm/config.js';
import { ScriptedLlm } from './scripted-llm.js';

const FAKE_KEY = 'test-key-not-real';

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** Stubs global fetch so the REAL @google/genai SDK builds and sends its request into our hands. */
function stubFetch(respond: (c: Captured) => unknown, status = 200) {
  const captured: Captured[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const c: Captured = {
      url: req.url,
      method: init?.method ?? req.method,
      headers: new Headers(init?.headers ?? req.headers),
      body: typeof raw === 'string' && raw ? JSON.parse(raw) : raw,
    };
    captured.push(c);
    return new Response(JSON.stringify(respond(c)), { status, headers: { 'content-type': 'application/json' } });
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LLM config', () => {
  it('one value per model, env-overridable', () => {
    expect(geminiModel({})).toBe(DEFAULT_GEMINI_MODEL);
    expect(geminiModel({ ARGON_LLM_MODEL: 'gemini-x' })).toBe('gemini-x');
    expect(geminiImageModel({})).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
    expect(geminiImageModel({ ARGON_LLM_IMAGE_MODEL: 'img-x' })).toBe('img-x');
  });
});

describe('GeminiProvider request shape (real SDK, stubbed fetch)', () => {
  it('structured output + Google Search grounding → Interactions API body; sources from url_citation', async () => {
    const captured = stubFetch(() => ({
      id: 'int_1',
      status: 'completed',
      steps: [
        { type: 'google_search_call', id: 'c1', arguments: { queries: ['frog memes'] } },
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text: '{"narratives":["frog"]}',
              annotations: [
                { type: 'url_citation', url: 'https://news.example.org/a', title: 'A', start_index: 0, end_index: 5 },
                { type: 'url_citation', url: 'https://news.example.org/a', title: 'A' },
                { type: 'url_citation', url: 'https://blog.example.net/b', title: 'B' },
              ],
            },
          ],
        },
      ],
    }));
    const g = new GeminiProvider({ apiKey: FAKE_KEY, env: {} });
    const schema = { type: 'object', properties: { narratives: { type: 'array', items: { type: 'string' } } }, required: ['narratives'] };
    const res = await g.generate({ system: 'You are Scout.', prompt: 'Find trends', jsonSchema: schema, grounding: true });

    expect(captured).toHaveLength(1);
    const c = captured[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(c.headers.get('x-goog-api-key')).toBe(FAKE_KEY);
    expect(c.url).not.toContain(FAKE_KEY);
    expect(c.body).toEqual({
      model: DEFAULT_GEMINI_MODEL,
      input: 'Find trends',
      system_instruction: 'You are Scout.',
      tools: [{ type: 'google_search' }],
      response_format: { type: 'text', mime_type: 'application/json', schema },
    });
    expect(res).toEqual({
      text: '{"narratives":["frog"]}',
      json: { narratives: ['frog'] },
      provider: 'gemini',
      model: DEFAULT_GEMINI_MODEL,
      sources: ['https://news.example.org/a', 'https://blog.example.net/b'],
    });
  });

  it('plain text without grounding or schema sends neither', async () => {
    const captured = stubFetch(() => ({ id: 'i', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hello' }] }] }));
    const res = await new GeminiProvider({ apiKey: FAKE_KEY, env: { ARGON_LLM_MODEL: 'gemini-override' } }).generate({ system: '', prompt: 'hi' });
    expect(captured[0]!.body).toEqual({ model: 'gemini-override', input: 'hi' });
    expect(res).toMatchObject({ text: 'hello', sources: [], model: 'gemini-override' });
    expect(res).not.toHaveProperty('json');
  });

  it('image generation uses the image model and returns bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const captured = stubFetch(() => ({
      id: 'i',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'image', data: png.toString('base64'), mime_type: 'image/png' }] }],
    }));
    const g = new GeminiProvider({ apiKey: FAKE_KEY, env: {} });
    const out = await g.generateImage('frosted frog coin', '1:1');
    expect(captured[0]!.body).toEqual({
      model: DEFAULT_GEMINI_IMAGE_MODEL,
      input: 'frosted frog coin',
      response_format: { type: 'image', aspect_ratio: '1:1' },
    });
    expect(Buffer.from(out.bytes)).toEqual(png);
    expect(out).toMatchObject({ mime: 'image/png', model: DEFAULT_GEMINI_IMAGE_MODEL });
    await g.generateImage('banner', '3:1');
    expect((captured[1]!.body as { response_format: unknown }).response_format).toEqual({ type: 'image', aspect_ratio: '21:9' });
  });

  it('[AG-035] vision: the prompt and inline images go as Interactions content parts', async () => {
    const captured = stubFetch(() => ({ id: 'i', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"violations":[]}' }] }] }));
    const g = new GeminiProvider({ apiKey: FAKE_KEY, env: {} });
    expect(hasVision(g)).toBe(true);
    const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
    const banner = new Uint8Array([0xff, 0xd8, 0xff, 7]);
    const schema = { type: 'object' };
    const res = await g.generateWithImages({ system: 'Classify.', prompt: 'Image 1 is the logo.', jsonSchema: schema }, [
      { bytes: logo, mime: 'image/png' },
      { bytes: banner, mime: 'image/jpeg' },
    ]);
    expect(captured[0]!.body).toEqual({
      model: DEFAULT_GEMINI_MODEL,
      input: [
        { type: 'text', text: 'Image 1 is the logo.' },
        { type: 'image', data: Buffer.from(logo).toString('base64'), mime_type: 'image/png' },
        { type: 'image', data: Buffer.from(banner).toString('base64'), mime_type: 'image/jpeg' },
      ],
      system_instruction: 'Classify.',
      response_format: { type: 'text', mime_type: 'application/json', schema },
    });
    expect(res.json).toEqual({ violations: [] });
    await expect(g.generateWithImages({ system: '', prompt: 'x' }, [])).rejects.toThrow(/at least one image/);
  });

  it('surfaces API errors and invalid JSON instead of inventing output', async () => {
    stubFetch(() => ({ error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } }), 403);
    await expect(new GeminiProvider({ apiKey: FAKE_KEY, env: {} }).generate({ system: '', prompt: 'x' })).rejects.toThrow();
    vi.unstubAllGlobals();
    stubFetch(() => ({ id: 'i', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'not json' }] }] }));
    await expect(
      new GeminiProvider({ apiKey: FAKE_KEY, env: {} }).generate({ system: '', prompt: 'x', jsonSchema: { type: 'object' } }),
    ).rejects.toThrow(/not valid JSON/);
    vi.unstubAllGlobals();
    stubFetch(() => ({ id: 'i', status: 'failed', steps: [] }));
    await expect(new GeminiProvider({ apiKey: FAKE_KEY, env: {} }).generate({ system: '', prompt: 'x' })).rejects.toThrow(/failed/);
  });

  it('needs a key', () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      expect(() => new GeminiProvider({ env: {} })).toThrow(/GEMINI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });
});

describe('AnthropicProvider request shape (injected client)', () => {
  it('maps schema to output_config and grounding to web search; reads citations', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (p: Record<string, unknown>) => {
          calls.push(p);
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '{"ok":true}', citations: [{ type: 'web_search_result_location', url: 'https://x.example.com/' }] }],
          };
        },
      },
    };
    const a = new AnthropicProvider({ client, model: 'claude-haiku-5-5' });
    const res = await a.generate({ system: 'sys', prompt: 'p', jsonSchema: { type: 'object' }, grounding: true, temperature: 0.2 });
    expect(calls[0]).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'p' }],
      system: 'sys',
      temperature: 0.2,
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    });
    expect(res).toEqual({ text: '{"ok":true}', json: { ok: true }, provider: 'anthropic', model: 'claude-haiku-5-5', sources: ['https://x.example.com/'] });
    expect('generateImage' in a).toBe(false);
  });

  it('[AG-035] vision: base64 image blocks before the prompt text', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = { messages: { create: async (p: Record<string, unknown>) => (calls.push(p), { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) } };
    const a = new AnthropicProvider({ client, model: 'claude-haiku-5-5' });
    expect(hasVision(a)).toBe(true);
    const img = new Uint8Array([1, 2, 3]);
    await a.generateWithImages({ system: 's', prompt: 'p' }, [{ bytes: img, mime: 'image/png' }]);
    expect(calls[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(img).toString('base64') } }, { type: 'text', text: 'p' }] },
    ]);
  });
});

describe('createLlm', () => {
  const anthropicClient = { messages: { create: async () => ({ content: [] }) } };

  it('production: Gemini only, and throws without GEMINI_API_KEY', async () => {
    await expect(createLlm({ env: { NODE_ENV: 'production', ANTHROPIC_API_KEY: 'a' } })).rejects.toThrow(/GEMINI_API_KEY is required in production/);
    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const p = await createLlm({ env: { NODE_ENV: 'production', GEMINI_API_KEY: FAKE_KEY, ANTHROPIC_API_KEY: 'a' }, fetch: unreachable as never });
    expect(p.id).toBe('gemini');
    expect(unreachable).not.toHaveBeenCalled(); // no fallback probing in production
  });

  it('dev: Gemini when reachable', async () => {
    const ok = vi.fn(async (_u: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe(FAKE_KEY);
      return new Response('{"models":[]}', { status: 200 });
    });
    const s = await selectLlm({ env: { NODE_ENV: 'development', GEMINI_API_KEY: FAKE_KEY }, fetch: ok as never });
    expect(s.provider.id).toBe('gemini');
    expect(s.fallbackReason).toBeNull();
    expect(String(ok.mock.calls[0]![0])).not.toContain(FAKE_KEY);
  });

  it('dev: falls back to Claude when Gemini is unconfigured or unreachable', async () => {
    const a = await selectLlm({ env: { NODE_ENV: 'development' }, anthropicClient });
    expect(a.provider.id).toBe('anthropic');
    expect(a.fallbackReason).toBe('GEMINI_API_KEY is not set');
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    const b = await selectLlm({ env: { NODE_ENV: 'test', GEMINI_API_KEY: FAKE_KEY }, fetch: down as never, anthropicClient });
    expect(b.provider.id).toBe('anthropic');
    expect(b.fallbackReason).toMatch(/unreachable/);
    expect(b.fallbackReason).not.toContain(FAKE_KEY);
    await expect(selectLlm({ env: { NODE_ENV: 'development' } })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('ScriptedLlm (test-only double)', () => {
  it('replays its script', async () => {
    const s = new ScriptedLlm([{ text: 'one' }]);
    await expect(s.generate({ system: '', prompt: 'p' })).resolves.toMatchObject({ text: 'one', provider: 'scripted-test' });
    await expect(s.generate({ system: '', prompt: 'p' })).rejects.toThrow(/exhausted/);
  });
});

describe.skipIf(!process.env.GEMINI_API_KEY)('Gemini live (runs only when GEMINI_API_KEY is set)', () => {
  it('generates grounded structured output', async () => {
    const g = new GeminiProvider();
    const res = await g.generate({
      system: 'Answer briefly.',
      prompt: 'Name one news headline from today with its source.',
      grounding: true,
      jsonSchema: { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] },
    });
    expect(typeof (res.json as { headline: string }).headline).toBe('string');
    expect(res.sources.length).toBeGreaterThan(0);
  }, 60_000);

  it('generates an image', async () => {
    const out = await new GeminiProvider().generateImage('a frosted crystal argon atom on grey fog', '1:1');
    expect(out.bytes.length).toBeGreaterThan(1000);
  }, 120_000);
});
