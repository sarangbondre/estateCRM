// @11e/outbox: transactional outbox, relay, queue drains, DLQ replay and retention (F-09, ADR-0003).
export { buildEnvelope, writeEvent, writeEvents } from './write.js';
export type { NewEvent } from './write.js';
export { relayOutbox } from './relay.js';
export type { EventRoutes, RelayOptions, RelayResult } from './relay.js';
export {
  drainEvents,
  drainWork,
  purgeProcessedEvents,
  purgePublishedOutbox,
  replayDeadLetters,
} from './drain.js';
export type {
  DrainOptions,
  DrainResult,
  EventHandler,
  EventHandlerContext,
  EventHandlers,
  WorkHandler,
  WorkHandlerContext,
} from './drain.js';
export { queueDepth, queueSend } from './queue.js';
export type {
  EventDataMap,
  EventEnvelope,
  EventType,
  OutboxDb,
  OutboxTable,
  ProcessedEventsTable,
  QueueContext,
  QueueMessage,
} from './types.js';
