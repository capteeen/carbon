/**
 * The project was renamed from Carbon to Argon, and its env vars from CARBON_* to ARGON_*.
 * A deployment still configured with the old names keeps working: every CARBON_X is
 * copied to ARGON_X unless ARGON_X is already set. Importing this module applies it once,
 * so import it before anything that reads env (worker entry, web instrumentation).
 */
const OLD = 'CARBON_';
const NEW = 'ARGON_';

/** Copies legacy CARBON_* values onto unset ARGON_* names. Returns the names it filled. */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const filled: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(OLD) || value === undefined) continue;
    const next = NEW + key.slice(OLD.length);
    if (env[next] === undefined || env[next] === '') {
      env[next] = value;
      filled.push(next);
    }
  }
  return filled;
}

if (typeof process !== 'undefined' && process.env) applyLegacyEnv();
