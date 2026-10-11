/**
 * One-call wiring for servers (worker, Next route handlers):
 *   const core = await createCore();   // reads DATABASE_URL, REDIS_URL, CARBON_AGENT_KEY_SEED
 *   core.bus / core.handoffs / core.approvals / core.budgets
 */
import { PgApprovals } from './approvals.js';
import { PgBudgets } from './budgets.js';
import { createEventBus, type CreateEventBusOptions, type PgEventBus } from './bus/pg-bus.js';
import { migrate } from './bus/migrate.js';
import { EventBusHandoffs } from './handoffs.js';

export interface Core {
  bus: PgEventBus;
  handoffs: EventBusHandoffs;
  approvals: PgApprovals;
  budgets: PgBudgets;
  close(): Promise<void>;
}

export async function createCore(opts: CreateEventBusOptions & { migrate?: boolean } = {}): Promise<Core> {
  const bus = createEventBus(opts);
  if (opts.migrate) await migrate(bus.pool);
  const now = bus.now;
  return {
    bus,
    handoffs: new EventBusHandoffs({ bus, pool: bus.pool, now }),
    approvals: new PgApprovals({ bus, pool: bus.pool, now }),
    budgets: new PgBudgets({ bus, pool: bus.pool, now }),
    close: () => bus.close(),
  };
}
