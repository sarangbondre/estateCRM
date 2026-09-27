// Transactional outbox write (CLAUDE.md §3.4): call inside the same transaction as the state change.
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { AnyDb, EventDataMap, EventEnvelope, EventType, OutboxDb } from './types.js';

export interface NewEvent<T extends EventType> {
  eventType: T;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  /** Strictly increasing per aggregate (conventions §5); consumers drop stale versions. */
  aggregateVersion: number;
  data: EventDataMap[T];
  correlationId: string;
  /** The producing service, e.g. `records`. */
  producer: string;
  traceparent?: string;
  eventId?: string;
  occurredAt?: Date;
}

const schemaVersionOf = (eventType: string) => Number(/\.v(\d+)$/.exec(eventType)?.[1] ?? 1);

export function buildEnvelope<T extends EventType>(e: NewEvent<T>): EventEnvelope<T> {
  const envelope: EventEnvelope<T> = {
    eventId: e.eventId ?? randomUUID(),
    eventType: e.eventType,
    schemaVersion: schemaVersionOf(e.eventType),
    occurredAt: (e.occurredAt ?? new Date()).toISOString(),
    correlationId: e.correlationId,
    producer: e.producer,
    tenantId: e.tenantId,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    aggregateVersion: e.aggregateVersion,
    data: e.data,
  };
  if (e.traceparent) envelope.traceparent = e.traceparent;
  return envelope;
}

/** Writes events to the outbox in the caller's transaction. Returns the envelopes as they will be published. */
export async function writeEvents<DB>(
  trx: AnyDb<DB>,
  events: readonly NewEvent<EventType>[],
): Promise<EventEnvelope[]> {
  if (!events.length) return [];
  const envelopes = events.map((e) => buildEnvelope(e));
  await (trx as unknown as Kysely<OutboxDb>)
    .insertInto('outbox')
    .values(
      envelopes.map((env) => ({
        id: env.eventId,
        tenant_id: env.tenantId,
        event_type: env.eventType,
        aggregate_type: env.aggregateType,
        aggregate_id: env.aggregateId,
        aggregate_version: env.aggregateVersion,
        payload: JSON.stringify(env),
        occurred_at: new Date(env.occurredAt),
        published_at: null,
      })),
    )
    .execute();
  return envelopes;
}

export async function writeEvent<DB, T extends EventType>(
  trx: AnyDb<DB>,
  event: NewEvent<T>,
): Promise<EventEnvelope<T>> {
  const [envelope] = await writeEvents(trx, [event as NewEvent<EventType>]);
  return envelope as EventEnvelope<T>;
}
