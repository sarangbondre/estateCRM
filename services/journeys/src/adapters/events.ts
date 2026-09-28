// Event consumers for q_journeys (contracts/asyncapi/events.yaml). Handlers run inside the drain transaction
// together with processed_events dedupe (libs/outbox). Unknown event types are dead-lettered (no-handler).
import type { EventType } from '@11e/contracts/events';
import type { EventHandler, EventHandlers } from '@11e/outbox';
import { handlers } from '../application/handlers.js';
import type { Handler, Incoming } from '../application/handlers.js';
import type { AppDeps } from '../deps.js';
import type { JourneysDb } from './db.js';
import { txOn } from './store.js';

export function eventHandlers(deps: AppDeps): EventHandlers<JourneysDb> {
  const out: Record<string, EventHandler<JourneysDb, EventType>> = {};
  for (const [type, handler] of Object.entries(handlers) as [EventType, Handler<EventType>][]) {
    out[type] = async (event, { trx }) => {
      const tx = txOn(trx, event.tenantId, deps.clock.now(), event.correlationId);
      await handler(tx, event as unknown as Incoming<EventType>);
    };
  }
  return out as EventHandlers<JourneysDb>;
}
