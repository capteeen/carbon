/**
 * Agent G e2e support (TEST ONLY): creates a throwaway schema in carbon_test and,
 * with --replay, appends ONE recorded launch through the real core bus (signed
 * hand-offs via Handoffs.send, so valence/topology are enforced as in production).
 * The Next production build is then started against this schema. Nothing here is
 * imported by product code; the data never leaves the test database.
 *
 *   tsx e2e/seed.ts <schema> [--replay]
 * Prints the DATABASE_URL for the schema and the seeded launch's facts as JSON.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import bs58 from 'bs58';
import { createCore } from '@argon/core';
import { migrateAll } from '../../apps/worker/src/migrate.js';

const DB = process.env.ARGON_TEST_DATABASE_URL ?? 'postgres://carbon:carbon@localhost:5432/carbon_test';
const schema = process.argv[2];
if (!schema || !/^g2_[a-z0-9_]+$/.test(schema)) throw new Error('schema must match g2_*');
const replay = process.argv.includes('--replay');
const seed = process.env.ARGON_AGENT_KEY_SEED ?? randomBytes(32).toString('hex');

const admin = new pg.Pool({ connectionString: DB });
await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.end();

const core = await createCore({ databaseUrl: DB, redisUrl: process.env.ARGON_TEST_REDIS_URL ?? 'redis://localhost:6379', seed, schema });
await migrateAll(core.bus.pool);
const out: Record<string, unknown> = { schema, seed, dbUrl: `${DB}?options=${encodeURIComponent(`-c search_path=${schema}`)}` };

if (replay) {
  const launchId = randomUUID();
  const { bus, handoffs } = core;
  await bus.append({ launchId, kind: 'launch.created', actor: 'user', payload: { line: 'agent g e2e replay', isotope: 'Ar-40', shape: 'ring', heavyAgent: 'herald', launcherWallet: bs58.encode(randomBytes(32)), xConnected: false } });
  const hs: string[] = [];
  const send = async (from: Parameters<typeof handoffs.send>[1], to: Parameters<typeof handoffs.send>[2], topic: string) => {
    const e = await handoffs.send(launchId, from, to, topic, `e2e ${topic}`);
    hs.push(e.id);
  };
  await send('scout', 'forge', 'narratives');
  await bus.append({ launchId, kind: 'forge.draft', actor: 'forge', payload: { name: 'Agent G Probe', ticker: 'GPROBE', lore: 'e2e', logoUri: 'ipfs://x', logoHash: '0'.repeat(16), bannerUri: 'ipfs://y', siteUri: 'ipfs://z', metadataUri: 'ipfs://m' } });
  await send('forge', 'sentinel', 'coin-draft');
  await send('forge', 'sentinel', 'coin-draft-2');
  await send('sentinel', 'forge', 'cleared');
  await bus.append({ launchId, kind: 'sentinel.score', actor: 'sentinel', payload: { score: 82, threshold: 70, inputs: [], hardFail: false, passed: true, run: 1 } });
  await send('sentinel', 'treasurer', 'score');
  await send('treasurer', 'herald', 'launch-ready');
  await send('herald', 'keeper', 'loop-posted');
  const ca = bs58.encode(randomBytes(32));
  const dep = await bus.append({ launchId, kind: 'launch.deployed', actor: 'treasurer', payload: { ca, txSig: bs58.encode(randomBytes(64)), creatorWallet: bs58.encode(randomBytes(32)), devBuySol: 0.25, network: 'devnet' } });
  Object.assign(out, { launchId, ca, ticker: 'GPROBE', handoffs: hs, deployEventId: dep.id, deployDate: new Date(dep.ts).toISOString().slice(0, 10) });
}
await core.close();
console.log(JSON.stringify(out));
