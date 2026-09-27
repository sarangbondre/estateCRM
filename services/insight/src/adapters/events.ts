// Event consumers for q_insight (contracts/asyncapi/events.yaml, the 64 insight routes of event-topology.json).
// Handlers run inside the drain transaction together with the processed_events dedupe (libs/outbox); the read-model
// writes, the rollup deltas and rm_state commit with it. Unknown event types are dead-lettered (no-handler).
import type { EventType } from '@11e/contracts/events';
import type { EventHandler, EventHandlers } from '@11e/outbox';
import { HANDLED_EVENTS, applyEvent } from '../application/projection.js';
import type { AppDeps } from '../deps.js';
import type { InsightDb } from './db.js';
import { createReadModelStore } from './readModelStore.js';

export function eventHandlers(deps: AppDeps): EventHandlers<InsightDb> {
  const out: Record<string, EventHandler<InsightDb, EventType>> = {};
  for (const type of HANDLED_EVENTS) {
    out[type] = async (event, { trx }) => {
      await applyEvent(
        createReadModelStore(trx, event.tenantId),
        {
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          producer: event.producer,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
          data: event.data,
        },
        deps.clock.now(),
      );
    };
  }
  return out as EventHandlers<InsightDb>;
}
