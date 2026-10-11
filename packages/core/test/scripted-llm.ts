/**
 * Scripted LlmProvider for unit tests. TEST-ONLY: lives under test/, never exported from src/.
 * Each generate() call pops the next scripted response and records the request.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/ports.js';

export class ScriptedLlm implements LlmProvider {
  readonly id = 'scripted-test';
  readonly model = 'scripted-test';
  readonly calls: LlmRequest[] = [];
  constructor(private readonly script: (Partial<LlmResponse> & { text: string })[]) {}

  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedLlm: script exhausted');
    return { provider: this.id, model: this.model, sources: [], ...next };
  }
}
