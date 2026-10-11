import { existsSync } from 'node:fs';
import path from 'node:path';

/** Absolute path of the repo's docs/how.md (cwd is apps/web under pnpm, Next and vitest). */
export function howDocPath(cwd: string = process.cwd()): string {
  const candidates = [path.resolve(cwd, '../../docs/how.md'), path.resolve(cwd, 'docs/how.md')];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}
