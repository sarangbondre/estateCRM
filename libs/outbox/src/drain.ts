// Queue drains (ADR-0003, conventions §5, capacity plan §5).
// - drainEvents: event queues. Dedupe on processed_events(event_id) in the SAME transaction as the handler and the
//   message delete, so a handler's DB effects apply exactly once even though delivery is at least once.
// - drainWork: private work queues (chunks, exports, photo fetches). The handler dedupes on its own work key.
// Both: read ≤ batchSize messages with a visibility timeout, stop at the time budget, back off failed messages via the
// visibility timeout, and move a message to <queue>_dlq once it has been read more than maxAttempts times.
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { withTransaction } from '@11e/db';
import { queueArchive, queueDelete, queueDepth, queueRead, queueSend, queueSetVt } from './queue.js';
import type { EventEnvelope, EventType, OutboxDb, QueueContext, QueueMessage } from './types.js';

export interface DrainOptions {
  queue: string;
  /** Messages per run. Default 100. */
  batchSize?: number;
  /** Visibility timeout for claimed messages. Default 60 s. */
  visibilityTimeoutSec?: number;
  /** Reads before a message is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Stop picking up messages after this long. Default 50 s. */
  budgetMs?: number;
  /** Delay before retrying a failed message, by attempt (1-based). Default 5·2^(n-1) s ± 20%, capped at 10 min. */
  retryDelaySec?: (attempt: number) => number;
  /** Called for each failure (for logs/metrics; the lib never logs — the error may contain PII). */
  onError?: (
    err: unknown,
    info: { queue: string; msgId: string; attempt: number; eventType?: string },
  ) => void;
}

export interface DrainResult {
  processed: number;
  duplicates: number;
  failed: number;
  deadLettered: number;
  remaining: number | null;
  durationMs: number;
}

export interface EventHandlerContext<DB> {
  /** The transaction shared with dedupe and the message ack (transactional handlers). */
  trx: Transaction<DB>;
  attempt: number;
}
export type EventHandler<DB, T extends EventType> = (
  event: EventEnvelope<T>,
  ctx: EventHandlerContext<DB>,
) => Promise<void>;
export type EventHandlers<DB> = { [T in EventType]?: EventHandler<DB, T> };

export interface WorkHandlerContext<DB> {
  db: Kysely<DB>;
  attempt: number;
  msgId: string;
}
export type WorkHandler<DB> = (payload: unknown, ctx: WorkHandlerContext<DB>) => Promise<void>;

const defaultDelay = (attempt: number) => Math.min(600, 5 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Outcome = 'processed' | 'duplicate';

async function runDrain<DB>(
  ctx: QueueContext<DB>,
  options: DrainOptions,
  handle: (msg: QueueMessage) => Promise<Outcome | { deadLetter: string }>,
  eventTypeOf: (msg: QueueMessage) => string | undefined,
): Promise<DrainResult> {
  const started = Date.now();
  const deadline = started + (options.budgetMs ?? 50_000);
  const maxAttempts = options.maxAttempts ?? 5;
  const delay = options.retryDelaySec ?? defaultDelay;
  const result: DrainResult = {
    processed: 0,
    duplicates: 0,
    failed: 0,
    deadLettered: 0,
    remaining: null,
    durationMs: 0,
  };

  const messages = await queueRead(
    ctx.db,
    ctx.schema,
    options.queue,
    options.visibilityTimeoutSec ?? 60,
    options.batchSize ?? 100,
  );
  for (const [i, msg] of messages.entries()) {
    if (Date.now() >= deadline) {
      // Out of time: make the rest visible again right away instead of waiting out the visibility timeout.
      for (const rest of messages.slice(i))
        await queueSetVt(ctx.db, ctx.schema, options.queue, rest.msg_id, 0);
      break;
    }
    if (msg.read_ct > maxAttempts) {
      await deadLetter(ctx, options.queue, msg, 'max-attempts');
      result.deadLettered++;
      continue;
    }
    try {
      const outcome = await handle(msg);
      if (typeof outcome === 'object') {
        await deadLetter(ctx, options.queue, msg, outcome.deadLetter);
        result.deadLettered++;
      } else if (outcome === 'duplicate') {
        result.duplicates++;
      } else {
        result.processed++;
      }
    } catch (err) {
      result.failed++;
      const info: { queue: string; msgId: string; attempt: number; eventType?: string } = {
        queue: options.queue,
        msgId: msg.msg_id,
        attempt: msg.read_ct,
      };
      const eventType = eventTypeOf(msg);
      if (eventType) info.eventType = eventType;
      options.onError?.(err, info);
      await queueSetVt(ctx.db, ctx.schema, options.queue, msg.msg_id, delay(msg.read_ct));
    }
  }
  result.remaining = await queueDepth(ctx.db, ctx.schema, options.queue);
  result.durationMs = Date.now() - started;
  return result;
}

async function deadLetter<DB>(ctx: QueueContext<DB>, queue: string, msg: QueueMessage, reason: string) {
  await withTransaction(ctx.db, async (trx) => {
    await queueSend(trx, ctx.schema, `${queue}_dlq`, {
      message: msg.message,
      deadLetter: {
        reason,
        sourceQueue: queue,
        msgId: msg.msg_id,
        attempts: msg.read_ct,
        at: new Date().toISOString(),
      },
    });
    await queueArchive(trx, ctx.schema, queue, msg.msg_id);
  });
}

const envelopeOf = (msg: QueueMessage): EventEnvelope | undefined => {
  const m = msg.message as Partial<EventEnvelope> | null;
  if (
    !m ||
    typeof m !== 'object' ||
    typeof m.eventType !== 'string' ||
    typeof m.eventId !== 'string' ||
    !UUID.test(m.eventId)
  ) {
    return undefined;
  }
  return m as EventEnvelope;
};

export async function drainEvents<DB>(
  ctx: QueueContext<DB>,
  options: DrainOptions & { consumer: string; handlers: EventHandlers<DB>; statementTimeoutMs?: number },
): Promise<DrainResult> {
  const db = ctx.db as unknown as Kysely<OutboxDb>;
  return runDrain(
    ctx,
    options,
    async (msg) => {
      const event = envelopeOf(msg);
      if (!event) return { deadLetter: 'invalid-envelope' };
      const handler = options.handlers[event.eventType] as EventHandler<DB, EventType> | undefined;
      if (!handler) return { deadLetter: 'no-handler' };
      return withTransaction(
        db,
        async (trx) => {
          const claimed = await trx
            .insertInto('processed_events')
            .values({ event_id: event.eventId, consumer: options.consumer, processed_at: new Date() })
            .onConflict((oc) => oc.column('event_id').doNothing())
            .returning('event_id')
            .executeTakeFirst();
          if (claimed) await handler(event, { trx: trx as unknown as Transaction<DB>, attempt: msg.read_ct });
          await queueDelete(trx, ctx.schema, options.queue, msg.msg_id);
          return claimed ? 'processed' : 'duplicate';
        },
        { statementTimeoutMs: options.statementTimeoutMs ?? 30_000, retries: 1 },
      );
    },
    (msg) => envelopeOf(msg)?.eventType,
  );
}

export async function drainWork<DB>(
  ctx: QueueContext<DB>,
  options: DrainOptions & { handler: WorkHandler<DB> },
): Promise<DrainResult> {
  return runDrain(
    ctx,
    options,
    async (msg) => {
      await options.handler(msg.message, { db: ctx.db, attempt: msg.read_ct, msgId: msg.msg_id });
      await queueDelete(ctx.db, ctx.schema, options.queue, msg.msg_id);
      return 'processed';
    },
    () => undefined,
  );
}

/** Runbook "DLQ replay": moves up to `limit` dead-lettered messages back to their queue. Returns how many moved. */
export async function replayDeadLetters<DB>(
  ctx: QueueContext<DB>,
  queue: string,
  limit = 100,
): Promise<number> {
  const messages = await queueRead(ctx.db, ctx.schema, `${queue}_dlq`, 30, limit);
  let moved = 0;
  for (const msg of messages) {
    const body = msg.message as { message?: unknown } | null;
    await withTransaction(ctx.db, async (trx) => {
      await queueSend(trx, ctx.schema, queue, body?.message ?? body);
      await queueDelete(trx, ctx.schema, `${queue}_dlq`, msg.msg_id);
    });
    moved++;
  }
  return moved;
}

/** Retention jobs (crm-engine LLD §retention): processed_events 30 days, published outbox rows 7 days. */
export async function purgeProcessedEvents<DB>(
  ctx: QueueContext<DB>,
  olderThanDays = 30,
  batchSize = 5000,
): Promise<number> {
  const db = ctx.db as unknown as Kysely<OutboxDb>;
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const r = await db
    .deleteFrom('processed_events')
    .where(({ eb, selectFrom }) =>
      eb(
        'event_id',
        'in',
        selectFrom('processed_events').select('event_id').where('processed_at', '<', cutoff).limit(batchSize),
      ),
    )
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

export async function purgePublishedOutbox<DB>(
  ctx: QueueContext<DB>,
  olderThanDays = 7,
  batchSize = 5000,
): Promise<number> {
  const db = ctx.db as unknown as Kysely<OutboxDb>;
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const r = await db
    .deleteFrom('outbox')
    .where(({ eb, selectFrom }) =>
      eb(
        'id',
        'in',
        selectFrom('outbox')
          .select('id')
          .where('published_at', 'is not', null)
          .where('published_at', '<', cutoff)
          .limit(batchSize),
      ),
    )
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

export { sql };
