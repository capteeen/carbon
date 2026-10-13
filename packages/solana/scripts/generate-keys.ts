/**
 * Generate Argon's operator keys.
 *
 *   pnpm --filter @argon/solana generate-keys -- --out /secure/path/argon-keys.json
 *
 * Prints PUBLIC keys only. Secrets (crank key, buyback key, treasury key,
 * vault key) are written as JSON to the path you choose, created with mode
 * 0600. The script refuses a path inside this repository, an existing file,
 * and stdout. Load the secrets into your secret manager; never commit them.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync, writeSync, closeSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml')) || existsSync(resolve(dir, '.git'))) return realpathSync(dir);
    const up = dirname(dir);
    if (up === dir) return realpathSync(dirname(fileURLToPath(import.meta.url)));
    dir = up;
  }
}

function outPath(argv: string[]): string {
  const i = argv.indexOf('--out');
  const p = i >= 0 ? argv[i + 1] : undefined;
  if (!p || p === '-' || p.startsWith('/dev/')) {
    console.error('usage: generate-keys --out <absolute path outside the repository>');
    process.exit(2);
  }
  const abs = resolve(p);
  if (!isAbsolute(p)) console.error(`note: resolved --out to ${abs}`);
  const parent = realpathSync(dirname(abs));
  const root = repoRoot();
  const rel = relative(root, resolve(parent, basename(abs)));
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    console.error(`refusing to write secrets inside the repository (${root}); choose a path outside it`);
    process.exit(2);
  }
  if (existsSync(abs)) {
    console.error(`refusing to overwrite ${abs}`);
    process.exit(2);
  }
  return abs;
}

const out = outPath(process.argv.slice(2));
const crank = Keypair.generate();
const buyback = Keypair.generate();
const treasury = Keypair.generate();
const vaultKey = randomBytes(32);

const secrets = {
  ARGON_CRANK_KEY: bs58.encode(crank.secretKey),
  ARGON_BUYBACK_KEY: bs58.encode(buyback.secretKey),
  ARGON_TREASURY_KEY_BACKUP: bs58.encode(treasury.secretKey),
  ARGON_VAULT_KEY: vaultKey.toString('hex'),
};
const fd = openSync(out, 'wx', 0o600); // fails if the file appeared meanwhile
try {
  writeSync(fd, JSON.stringify(secrets, null, 2) + '\n');
} finally {
  closeSync(fd);
}
vaultKey.fill(0);

console.log(`Secrets written to ${out} (mode 0600). Move them into your secret manager.`);
console.log('Public keys (safe to share):');
console.log(`  crank (fee payer, cranks, daughters, airdrops)  ${crank.publicKey.toBase58()}`);
console.log(`  ARGON_BUYBACK_WALLET                           ${buyback.publicKey.toBase58()}`);
console.log(`  ARGON_TREASURY_WALLET                          ${treasury.publicKey.toBase58()}`);
console.log('Fund the crank wallet on devnet before running scripts/devnet-spike.ts.');
