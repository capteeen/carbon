import type { LlmResponse } from '@argon/core';

/** Structured output: provider json, else the text parsed as JSON (code fences stripped). Throws if neither. */
export function llmJson(res: LlmResponse): unknown {
  if (res.json !== undefined && res.json !== null) return res.json;
  const t = res.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`LLM (${res.provider}/${res.model}) did not return JSON`);
  }
}

export function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what}: expected object`);
  return v as Record<string, unknown>;
}

export function str(v: unknown, what: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof v !== 'string' || (!opts.allowEmpty && !v.trim())) throw new Error(`${what}: expected non-empty string`);
  return v.trim();
}

export function optStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what}: expected array`);
  return v;
}

/** pump.fun-safe ticker: A-Z0-9, 2-10 chars. */
export function normalizeTicker(t: string): string {
  return t.replace(/^\$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

export function normalizeName(n: string): string {
  return n.replace(/\s+/g, ' ').trim().slice(0, 32);
}
