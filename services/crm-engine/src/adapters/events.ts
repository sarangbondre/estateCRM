// Event consumers for q_crm_engine (contracts/asyncapi/events.yaml). Handlers run inside the drain transaction
// together with processed_events dedupe (libs/outbox). Unknown event types are dead-lettered (no-handler).
import type { EventHandlers } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { CrmEngineDb } from './db.js';

export function eventHandlers(deps: AppDeps): EventHandlers<CrmEngineDb> {
  void deps;
  return {};
}
