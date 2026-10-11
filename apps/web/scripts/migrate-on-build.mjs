/**
 * Runs before `next build` (Vercel). When DATABASE_URL is set, applies every
 * Carbon migration (core, x, worker, chain) so the site never waits on the
 * worker's first boot to have its tables. Idempotent and lock-protected (each
 * migration set takes a Postgres advisory lock and records what it applied),
 * so running it on every deploy and alongside the worker is safe.
 *
 * A failure is reported but does not fail the build: the site still deploys
 * and shows honest empty states until the tables exist. Prints names only.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) {
  console.log('[carbon] DATABASE_URL not set: skipping migrations');
  process.exit(0);
}
const root = fileURLToPath(new URL('../../../', import.meta.url));
const r = spawnSync('pnpm', ['--filter', '@carbon/worker', 'migrate'], { cwd: root, stdio: 'inherit', env: process.env });
if (r.status !== 0) console.warn('[carbon] migrations did not complete; the site will show empty states until they do');
