/** Boot migrations: core (events, approvals, budgets), x (tokens, dedupe), worker tables, then chain. */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { migrate as migrateCore } from '@carbon/core';
import { migrate as migrateX } from '@carbon/x';
import type pg from 'pg';
import { chainMigrations } from './chain.js';

const DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const PREFIX = 'worker/';

/** Applies src/migrations/*.sql once each (tracked in core's carbon_migrations as worker/<file>). */
export async function migrateWorker(pool: pg.Pool): Promise<string[]> {
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('carbon:migrate:worker'))");
    await client.query('CREATE TABLE IF NOT EXISTS carbon_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM carbon_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(PREFIX + f)) continue;
      const sql = await readFile(DIR + f, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO carbon_migrations (name) VALUES ($1)', [PREFIX + f]);
        await client.query('COMMIT');
        applied.push(PREFIX + f);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('carbon:migrate:worker'))").catch(() => {});
    client.release();
  }
  return applied;
}

export async function migrateAll(pool: pg.Pool): Promise<string[]> {
  const applied = [...(await migrateCore(pool))];
  await migrateX(pool);
  applied.push(...(await migrateWorker(pool)));
  applied.push(...(await chainMigrations(pool)));
  return applied;
}
