/** `pnpm --filter @carbon/worker migrate`: core + x + worker + chain migrations against DATABASE_URL. */
import pg from 'pg';
import { migrateAll } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const applied = await migrateAll(pool);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
} finally {
  await pool.end();
}
