/**
 * @carbon/worker (Railway): migrations at boot, then the launch supervisor
 * (molecule runners, RING loops, Treasurer schedules, decay watchers).
 * Reads every secret from env; prints names and states only, never values.
 */
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { createCore } from '@carbon/core';
import { PgAssetStore } from './assets.js';
import { createChainClient } from './chain.js';
import { chooseWorkerLlm } from './llm.js';
import { migrateAll } from './migrate.js';
import { Supervisor } from './supervisor.js';
import { createWorkerX } from './x.js';

const log = (m: string) => console.log(`[carbon/worker] ${m}`);

async function main(): Promise<void> {
  const publicUrl = process.env.CARBON_PUBLIC_URL;
  if (!publicUrl) throw new Error('CARBON_PUBLIC_URL is not set (the web app origin that serves /api/assets)');
  const core = await createCore();
  const applied = await migrateAll(core.bus.pool);
  log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations up to date');

  log(`NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}`);
  const { provider: llm, line } = await chooseWorkerLlm();
  log(line);
  const x = createWorkerX(core.bus.pool);
  const chain = createChainClient({ pool: core.bus.pool, bus: core.bus });
  log(chain.kind === 'solana' ? `chain: ${chain.client.network}` : `chain: unavailable (${chain.reason})`);

  const supervisor = new Supervisor({
    core,
    pool: core.bus.pool,
    llm,
    x,
    chain,
    assets: new PgAssetStore(core.bus.pool, publicUrl),
    workerId: `${hostname()}:${process.pid}`,
    feeMode: process.env.CARBON_FEE_MODE === 'wallet' ? 'wallet' : 'native',
  });
  await supervisor.start();
  log('supervisor started');

  const port = Number(process.env.PORT ?? 8080);
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chain: chain.kind, jobs: supervisor.jobs().length }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, () => log(`health on :${port}/health`));

  const shutdown = async () => {
    log('shutting down');
    server.close();
    await supervisor.stop();
    await core.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(`[carbon/worker] fatal: ${err instanceof Error ? `${err.name}: ${err.message}` : 'error'}`);
  process.exit(1);
});
