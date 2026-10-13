import type { AgentId, ArgonEvent } from './contracts.js';
import type { EventBus } from './ports.js';

export class ReasoningError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ReasoningError';
  }
}

export const MAX_REASONING_CHARS = 600;

/**
 * Appends an "agent reasoning" summary tied to an existing event of the same launch.
 * Refuses empty text and a forEventId that is not in the launch's log: reasoning is
 * never invented and never floats free of the action it explains.
 */
export async function emitReasoning(
  bus: EventBus,
  launchId: string,
  agent: AgentId,
  forEventId: string,
  text: string,
): Promise<ArgonEvent<'reasoning'>> {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new ReasoningError('reasoning text is empty');
  if (t.length > MAX_REASONING_CHARS) throw new ReasoningError(`reasoning is a short summary (max ${MAX_REASONING_CHARS} chars)`);
  if (!/^[0-9a-f]{64}$/.test(forEventId)) throw new ReasoningError('forEventId is not an event id');
  const target = await findEvent(bus, launchId, forEventId);
  if (!target) throw new ReasoningError(`event ${forEventId.slice(0, 8)} is not in launch ${launchId}'s log`);
  return bus.append({ launchId, kind: 'reasoning', actor: agent, payload: { agent, forEventId, text: t } });
}

async function findEvent(bus: EventBus, launchId: string, id: string): Promise<ArgonEvent | undefined> {
  const withGet = bus as EventBus & { get?: (id: string) => Promise<ArgonEvent | null> };
  if (typeof withGet.get === 'function') {
    const e = await withGet.get(id);
    return e && e.launchId === launchId ? e : undefined;
  }
  return (await bus.list(launchId)).find((e) => e.id === id);
}
