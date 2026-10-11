/**
 * Source guards: no account creation anywhere in @carbon/x, no logging that
 * could leak tokens, no test doubles reachable from src/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(pkgRoot, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(srcDir).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));

const ACCOUNT_CREATION = [
  /sign[\s_-]?up/i,
  /register(?!ed)/i,
  /create[\s_-]?(an[\s_-]?)?account/i,
  /account[\s_-]?creat/i,
  /new[\s_-]?account/i,
  /i\/flow\//i,
  /onboarding\/task/i,
  /\/1\.1\/account\//i,
  /guest[\s_-]?token/i,
  /\/2\/users(?!\/me|\/\$\{|\/:id)[^'"`\s]*['"`]\s*,\s*\{\s*method:\s*['"]POST/i,
];

describe('no account creation', () => {
  it('src never references signup / account-creation endpoints or flows', () => {
    const hits: string[] = [];
    for (const { path, text } of sources) {
      for (const re of ACCOUNT_CREATION) {
        const m = text.match(re);
        if (m) hits.push(`${path}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('only talks to the documented OAuth and v2 endpoints', () => {
    const urls = new Set<string>();
    for (const { text } of sources) for (const m of text.matchAll(/['"`](\/2\/[a-z0-9_/:${}.-]*|https:\/\/[a-z.]+x\.com[^'"`]*)/gi)) urls.add(m[1]!);
    const allowed = [
      /^https:\/\/api\.x\.com$/,
      /^https:\/\/x\.com\/i\/oauth2\/authorize$/,
      /^https:\/\/x\.com\/\$\{/, // status URL
      /^\/2\/oauth2\/(token|revoke)$/,
      /^\/2\/tweets(\/search\/recent.*)?$/,
      /^\/2\/users\/me$/,
      /^\/2\/users\/(:id\/mentions|\$\{encodeURIComponent)$/,
      /^\/2\/trends\/by\/woeid\/.*$/,
    ];
    const unexpected = [...urls].filter((u) => !allowed.some((a) => a.test(u)));
    expect(unexpected).toEqual([]);
  });
});

describe('no token leakage paths', () => {
  it('src has no console/logging calls', () => {
    const hits = sources.filter(({ text }) => /\bconsole\.|\bprocess\.stdout|\bprocess\.stderr|\bdebug\(/.test(text)).map((s) => s.path);
    expect(hits).toEqual([]);
  });
  it('src never imports from test/', () => {
    const hits = sources.filter(({ text }) => /from ['"][^'"]*\/test\//.test(text)).map((s) => s.path);
    expect(hits).toEqual([]);
  });
});
