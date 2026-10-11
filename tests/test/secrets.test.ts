/**
 * SPEC §7: "Grep code, logs and git history for keys or seeds: none."
 * SPEC §8: ".env and details/ never committed."
 * Plus: secrets never reach logs, error messages, JSON or public events.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { KeyRing, resolveSeed } from '@carbon/core';
import { describeConfig, loadSolanaConfig, parseSecretKey, ChainUnavailableError } from '@carbon/solana';
import { TokenCipher, parseTokenKey } from '@carbon/x';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

/** Shapes of real secrets. Hex hashes (sha256 ids) are expected in tests, so 64-hex is checked in context only. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Solana keypair JSON', /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
  ['base58 64-byte secret key', /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{86,88}(?![A-Za-z0-9])/],
  ['BIP39-like seed phrase', /\b(?:abandon|zoo|legal|winner|thank|year|wave|sausage|worth|useful)(?:\s+[a-z]{3,8}){11,23}\b/],
  ['secret env assignment with a value', /^\+?\s*(?:export\s+)?(?:CARBON_AGENT_KEY_SEED|CARBON_VAULT_KEY|CARBON_CRANK_KEY|CARBON_BUYBACK_KEY|CARBON_TOKEN_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|X_CLIENT_SECRET|X_BEARER_TOKEN|PINATA_JWT)[ \t]*=[ \t]*[^\s#]{8,}/m],
];

function scan(text: string): { name: string; sample: string }[] {
  const hits: { name: string; sample: string }[] = [];
  for (const [name, re] of SECRET_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) hits.push({ name, sample: m[0].slice(0, 12) + '…' });
  }
  return hits;
}

describe('no keys or seeds in git history, the working tree, or ignored files that could be committed', () => {
  it('git log -p --all contains no secret-shaped values', () => {
    const history = git('log', '-p', '--all', '--no-color');
    expect(history.length).toBeGreaterThan(10_000);
    expect(scan(history)).toEqual([]);
  });

  it('tracked files contain no secret-shaped values', () => {
    const files = git('ls-files').split('\n').filter((f) => f && !/pnpm-lock\.yaml$|\.(png|jpg|ico|woff2?)$/.test(f));
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = git('show', `HEAD:${f}`);
      } catch {
        continue; // new file not in HEAD yet
      }
      for (const h of scan(text)) hits.push(`${f}: ${h.name} ${h.sample}`);
    }
    expect(hits).toEqual([]);
  });

  it('no .env, details/ or key file was ever committed', () => {
    const everPaths = git('log', '--all', '--name-only', '--pretty=format:').split('\n').filter(Boolean);
    const bad = everPaths.filter((p) => /(^|\/)\.env($|\.(?!example$))|(^|\/)details\/|\.pem$|id_rsa|keypair\.json$|carbon-keys\.json$/.test(p));
    expect(bad).toEqual([]);
  });

  it('.gitignore covers .env (any dir, any suffix except .example) and details/', () => {
    for (const p of ['.env', '.env.local', '.env.production', 'apps/web/.env', 'apps/worker/.env.local', 'details/x.txt', 'details/keys/crank.json']) {
      expect(git('check-ignore', '--no-index', '-v', p).trim(), p).not.toBe('');
    }
    expect(() => git('check-ignore', '--no-index', 'apps/worker/.env.example')).toThrow(); // examples stay tracked (names only)
    const example = git('show', 'HEAD:apps/worker/.env.example');
    for (const line of example.split('\n')) if (/^[A-Z_]+=/.test(line)) expect(line, 'example files hold names only').toMatch(/^[A-Z_]+=$/);
  });
});

describe('secrets never reach logs, JSON, inspect() or error messages', () => {
  it('core KeyRing exposes public keys only; a bad seed error does not echo the seed', () => {
    const seed = randomBytes(32);
    const ring = new KeyRing(seed);
    const all = JSON.stringify(ring) + inspect(ring, { depth: 10, showHidden: true }) + JSON.stringify(ring.publicKeys());
    expect(all).not.toContain(seed.toString('hex'));
    const bad = 'zz' + seed.toString('hex');
    try {
      resolveSeed(undefined, { CARBON_AGENT_KEY_SEED: bad } as unknown as NodeJS.ProcessEnv);
      throw new Error('should have thrown');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(bad);
    }
  });

  it('solana config: JSON, describeConfig and inspect never contain the vault/crank/buyback keys or the Pinata JWT; RPC api keys are redacted', () => {
    const crank = Keypair.generate();
    const buyback = Keypair.generate();
    const vault = randomBytes(32).toString('hex');
    // Built at runtime so this file itself never contains a JWT-shaped literal.
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const jwt = [b64('{"alg":"HS256"}'), b64(`{"sub":"${randomBytes(8).toString('hex')}"}`), b64(randomBytes(24).toString('hex'))].join('.');
    const env = {
      CARBON_VAULT_KEY: vault,
      CARBON_CRANK_KEY: bs58.encode(crank.secretKey),
      CARBON_BUYBACK_KEY: bs58.encode(buyback.secretKey),
      CARBON_BUYBACK_WALLET: buyback.publicKey.toBase58(),
      CARBON_TREASURY_WALLET: Keypair.generate().publicKey.toBase58(),
      CARBON_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=SUPERSECRETRPCKEY123',
      PINATA_JWT: jwt,
    };
    const cfg = loadSolanaConfig(env);
    const dumped = [JSON.stringify(cfg), JSON.stringify(describeConfig(cfg)), inspect(cfg, { depth: 10 }), inspect(describeConfig(cfg), { depth: 10 })].join('\n');
    for (const s of [vault, env.CARBON_CRANK_KEY, env.CARBON_BUYBACK_KEY, jwt]) expect(dumped).not.toContain(s);
    expect(JSON.stringify(describeConfig(cfg))).not.toContain('SUPERSECRETRPCKEY123');
    // upstream error text carrying secrets is redacted
    const err = new ChainUnavailableError(`fetch https://x/?api-key=SUPERSECRETRPCKEY123 failed; key ${env.CARBON_CRANK_KEY}; Bearer ${jwt}`);
    expect(err.message).not.toContain('SUPERSECRETRPCKEY123');
    expect(err.message).not.toContain(env.CARBON_CRANK_KEY);
    expect(err.message).not.toContain(jwt);
  });

  it('malformed secrets produce errors that name the variable, never the value', () => {
    const half = bs58.encode(Keypair.generate().secretKey).slice(0, 60);
    for (const fn of [() => parseSecretKey(half, 'CARBON_CRANK_KEY'), () => parseTokenKey('ab' + half), () => loadSolanaConfig({ CARBON_VAULT_KEY: half })]) {
      try {
        fn();
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as Error).message).not.toContain(half);
      }
    }
  });

  it('X token cipher: sealed tokens do not contain the plaintext; JSON/inspect of the cipher leaks no key', () => {
    const keyHex = randomBytes(32).toString('hex');
    const c = TokenCipher.fromEnv({ CARBON_TOKEN_KEY: keyHex });
    const sealed = Buffer.from(c.seal('access-token-value-12345', 'aad')).toString('latin1');
    expect(sealed).not.toContain('access-token-value-12345');
    expect(JSON.stringify(c) ?? '').not.toContain(keyHex);
    expect(inspect(c, { showHidden: true, depth: 5 })).not.toContain(keyHex);
  });

  it('web route errors never return internals (500 → "internal error")', async () => {
    const { handle } = await import('@/server/http');
    const res = await handle(async () => {
      throw new Error(`db password=hunter2 seed=${randomBytes(32).toString('hex')}`);
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal error"}');
  });

  it('src/ never prints env values (no console.* of process.env, secrets or keys)', () => {
    let out = '';
    try {
      out = git('grep', '-nE', 'console\\.(log|error|warn|info|debug)\\(.*(process\\.env|SECRET|secretKey|_KEY\\b|seed|token|jwt)', '--', 'packages/*/src', 'apps/*/src').trim();
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e; // 1 = no match
    }
    expect(out).toBe('');
  });
});

describe('public events carry no secrets', () => {
  it('no event payload kind in contracts.ts has a field named like a secret', async () => {
    const { readFileSync } = await import('node:fs');
    const contracts = readFileSync(path.join(ROOT, 'packages/core/src/contracts.ts'), 'utf8');
    const payloads = contracts.slice(contracts.indexOf('export interface EventPayloads'), contracts.indexOf('export type EventKind'));
    expect(payloads).not.toMatch(/\b(secret|privateKey|seed|token|jwt|accessToken|refreshToken)\b\s*[?:]/i);
  });
});
