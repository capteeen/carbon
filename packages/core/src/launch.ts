import { launchConfig, type ArgonEvent, type EventPayloads, type LaunchConfig } from './contracts.js';
import type { EventBus } from './ports.js';

export type LaunchCreated = EventPayloads['launch.created'];

export class UnknownLaunchError extends Error {
  constructor(launchId: string) {
    super(`unknown launch ${launchId} (no launch.created event)`);
    this.name = 'UnknownLaunchError';
  }
}

/** The launch's creation event (first launch.created in the log). */
export async function getLaunchCreated(bus: EventBus, launchId: string): Promise<ArgonEvent<'launch.created'>> {
  const [e] = await bus.list(launchId, { kinds: ['launch.created'], limit: 1 });
  if (!e) throw new UnknownLaunchError(launchId);
  return e as ArgonEvent<'launch.created'>;
}

/** The launch's config row, derived from its launch.created event via the ONE config table. */
export async function getLaunchConfig(bus: EventBus, launchId: string): Promise<LaunchConfig> {
  const e = await getLaunchCreated(bus, launchId);
  return configFromCreated(e.payload);
}

export function configFromCreated(p: LaunchCreated): LaunchConfig {
  return launchConfig(p.isotope, p.shape, p.heavyAgent);
}
