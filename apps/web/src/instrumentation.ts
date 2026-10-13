/** Runs once when the server starts: accept the pre-rename CARBON_* env names as ARGON_*. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('@argon/core/env-compat');
}
