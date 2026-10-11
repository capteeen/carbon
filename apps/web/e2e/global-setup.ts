/** Fresh, EMPTY event log for the smoke run: drop and re-create the e2e schema, then migrate core. */
import pg from 'pg';
import { migrate } from '@carbon/core';

export default async function globalSetup(): Promise<void> {
  const db = process.env.CARBON_TEST_DATABASE_URL ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';
  const admin = new pg.Pool({ connectionString: db });
  await admin.query('DROP SCHEMA IF EXISTS web_e2e CASCADE');
  await admin.query('CREATE SCHEMA web_e2e');
  await admin.end();
  const pool = new pg.Pool({ connectionString: db, options: '-c search_path=web_e2e' });
  await migrate(pool);
  await pool.end();
}
