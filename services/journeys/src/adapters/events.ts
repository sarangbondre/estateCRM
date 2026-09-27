// Event consumers for q_journeys (contracts/asyncapi/events.yaml). Handlers run inside the drain transaction
// together with processed_events dedupe (libs/outbox). Unknown event types are dead-lettered (no-handler).
import type { EventHandlers } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { JourneysDb } from './db.js';

export function eventHandlers(deps: AppDeps): EventHandlers<JourneysDb> {
  void deps;
  return {};
}
