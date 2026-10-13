/**
 * True when this deployment has an event log to read (DATABASE_URL and the key
 * seed are set). Without one, read paths return honest empty states (there is
 * no log, so there is nothing to show) and write paths refuse with 503; nothing
 * is ever made up.
 */
import '@argon/core/env-compat';
export function logConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DATABASE_URL?.trim() && env.ARGON_AGENT_KEY_SEED?.trim());
}
