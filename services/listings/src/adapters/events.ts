// Event consumers for q_listings (contracts/asyncapi/events.yaml, the 26 listings subscriptions). Handlers run inside
// the drain transaction together with processed_events dedupe (libs/outbox), so each input change, its ceiling
// recomputation, auto-downgrade, projection, change-feed row and outbox events commit together.
import type { EventHandler, EventHandlers } from '@11e/outbox';
import type { EventType } from '@11e/contracts/events';
import { withEventSpan } from '@11e/observability';
import { handlers } from '../application/ingest.js';
import type { Handler, Incoming } from '../application/ingest.js';
import type { AppDeps } from '../deps.js';
import type { ListingsDb } from './db.js';
import { storeIn } from './store.js';

export function eventHandlers(deps: AppDeps): EventHandlers<ListingsDb> {
  const out: Record<string, EventHandler<ListingsDb, EventType>> = {};
  for (const [type, handler] of Object.entries(handlers) as [EventType, Handler<EventType>][]) {
    out[type] = (event, ctx) =>
      withEventSpan(
        event,
        () =>
          handler(
            deps.services,
            storeIn(ctx.trx, event.tenantId, event.correlationId),
            event as unknown as Incoming<EventType>,
          ),
        { queue: 'q_listings' },
      );
  }
  return out as EventHandlers<ListingsDb>;
}
