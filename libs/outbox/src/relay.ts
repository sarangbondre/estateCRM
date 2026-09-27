// Outbox relay (ADR-0003, capacity plan §5): claims unpublished rows with FOR UPDATE SKIP LOCKED, enqueues one copy
// per subscribed consumer queue and marks them published — all in one transaction. pgmq lives in the same database,
// so a row is either published to every consumer or to none: no duplicates from the relay itself.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { withTransaction } from '@11e/db';
import { queueSendMany } from './queue.js';
import type { OutboxDb, QueueContext } from './types.js';

/** eventType → consumer queues (contracts/generated/event-topology.json `routes`). */
export type EventRoutes = Readonly<Record<string, { readonly queues: readonly string[] }>>;

export interface RelayOptions {
  routes: EventRoutes;
  /** Rows per run. Default 5,000 (capacity plan §5). */
  batchSize?: number;
  /** Messages per enqueue statement. Default 1,000. */
  chunkSize?: number;
  /** Statement timeout for the run. Default 50 s (60 s function limit). */
  timeoutMs?: number;
}

export interface RelayResult {
  processed: number;
  /** Rows left unpublished because their event type has no route (contract drift: alarm). */
  unroutable: number;
  /** Unpublished rows still waiting (capped at 10,000). */
  remaining: number;
  /** Age of the oldest routable unpublished row after this run (relay-lag alarm); null when none. */
  oldestPendingAgeSec: number | null;
  durationMs: number;
}

export async function relayOutbox<DB>(ctx: QueueContext<DB>, options: RelayOptions): Promise<RelayResult> {
  const started = Date.now();
  const batchSize = options.batchSize ?? 5000;
  const chunkSize = options.chunkSize ?? 1000;
  const db = ctx.db as unknown as Kysely<OutboxDb>;

  const { processed, unroutable } = await withTransaction(
    db,
    async (trx) => {
      const rows = await trx
        .selectFrom('outbox')
        .select(['id', 'event_type', 'payload'])
        .where('published_at', 'is', null)
        .orderBy('occurred_at')
        .orderBy('id')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();

      const publishedIds: string[] = [];
      const queues: string[] = [];
      const payloads: string[] = [];
      let skipped = 0;
      for (const row of rows) {
        const route = options.routes[row.event_type];
        if (!route) {
          skipped++;
          continue;
        }
        const payload = JSON.stringify(row.payload);
        for (const q of route.queues) {
          queues.push(q);
          payloads.push(payload);
        }
        publishedIds.push(row.id);
      }
      for (let i = 0; i < queues.length; i += chunkSize) {
        await queueSendMany(
          trx,
          ctx.schema,
          queues.slice(i, i + chunkSize),
          payloads.slice(i, i + chunkSize),
        );
      }
      if (publishedIds.length) {
        await trx
          .updateTable('outbox')
          .set({ published_at: new Date() })
          .where(sql<boolean>`id = any(${publishedIds}::uuid[])`)
          .execute();
      }
      return { processed: publishedIds.length, unroutable: skipped };
    },
    { statementTimeoutMs: options.timeoutMs ?? 50_000, retries: 1 },
  );

  const remaining = await db
    .selectFrom((qb) =>
      qb.selectFrom('outbox').select('id').where('published_at', 'is', null).limit(10_000).as('pending'),
    )
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirst();

  const oldest = await db
    .selectFrom('outbox')
    .select((eb) => eb.fn.min('occurred_at').as('oldest'))
    .where('published_at', 'is', null)
    .where('event_type', 'in', Object.keys(options.routes).length ? Object.keys(options.routes) : ['-'])
    .executeTakeFirst();
  const oldestAt = oldest?.oldest ? new Date(oldest.oldest as unknown as string) : null;

  return {
    processed,
    unroutable,
    oldestPendingAgeSec: oldestAt ? Math.max(0, Math.round((Date.now() - oldestAt.getTime()) / 1000)) : null,
    remaining: Math.max(0, Number(remaining?.n ?? 0) - unroutable),
    durationMs: Date.now() - started,
  };
}
