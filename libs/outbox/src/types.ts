import type { EventDataMap, EventType, components } from '@11e/contracts/events';
import type { Kysely, Transaction } from 'kysely';

export type { EventDataMap, EventType };

type Envelope = components['schemas']['Envelope'];

/** A contract event: the conventions §5 envelope with the typed `data` of its event type. */
export type EventEnvelope<T extends EventType = EventType> = Omit<Envelope, 'eventType' | 'data'> & {
  eventType: T;
  data: EventDataMap[T];
};

export interface OutboxTable {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  payload: unknown;
  occurred_at: Date;
  published_at: Date | null;
}

export interface ProcessedEventsTable {
  event_id: string;
  consumer: string;
  processed_at: Date;
}

export interface OutboxDb {
  outbox: OutboxTable;
  processed_events: ProcessedEventsTable;
}

export type AnyDb<DB> = Kysely<DB> | Transaction<DB>;

/** The service's database handle and schema (the pgmq wrapper functions live in that schema). */
export interface QueueContext<DB> {
  db: Kysely<DB>;
  schema: string;
}

/** A message as returned by pgmq. */
export interface QueueMessage {
  msg_id: string;
  read_ct: number;
  enqueued_at: Date;
  vt: Date;
  message: unknown;
}
