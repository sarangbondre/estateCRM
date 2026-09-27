// Integration tests on the local stack (`pnpm db:start`), against real pgmq. A scratch schema holds the outbox tables
// and unrestricted copies of the queue wrappers (permission guards are covered by infra/scripts/verify-platform.mjs).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTransaction } from '@11e/db';
import type { Kysely, Transaction } from 'kysely';
import {
  drainEvents,
  drainWork,
  purgeProcessedEvents,
  purgePublishedOutbox,
  queueDepth,
  queueSend,
  relayOutbox,
  replayDeadLetters,
  writeEvent,
} from '../src/index.js';
import type { EventDataMap, EventEnvelope, OutboxDb } from '../src/index.js';

const ADMIN =
  process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sfx = randomUUID().slice(0, 8);
const SCHEMA = `it_ob_${sfx}`;
const QA = `it_${sfx}_a`;
const QB = `it_${sfx}_b`;
const QW = `it_${sfx}_work`;
const QUEUES = [QA, QB, QW].flatMap((q) => [q, `${q}_dlq`]);
const TENANT = '00000000-0000-4000-8000-000000000001';

interface TestDb extends OutboxDb {
  applied: { event_id: string; note: string };
}

const fixture = <T extends keyof EventDataMap>(t: T): EventDataMap[T] =>
  JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/events/${t}.json`, import.meta.url), 'utf8'))
    .data;

const routes = {
  'offer.created.v1': { queues: [QA, QB] },
  'offer.updated.v1': { queues: [QA] },
};

const admin = new pg.Client({ connectionString: ADMIN });
const handle = createDb<TestDb>({ connectionString: ADMIN, schema: SCHEMA, maxConnections: 6 });
const ctx = { db: handle.db, schema: SCHEMA };
const db = handle.db as Kysely<TestDb>;

const newEvent = (
  type: 'offer.created.v1' | 'offer.updated.v1',
  version = 1,
  aggregateId = randomUUID(),
) => ({
  eventType: type,
  tenantId: TENANT,
  aggregateType: 'offer',
  aggregateId,
  aggregateVersion: version,
  data: fixture(type),
  correlationId: `test-${sfx}`,
  producer: 'records',
});

const unpublished = async () =>
  Number(
    (
      await db
        .selectFrom('outbox')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('published_at', 'is', null)
        .executeTakeFirstOrThrow()
    ).n,
  );

beforeAll(async () => {
  await admin.connect();
  await admin.query(`create schema ${SCHEMA}`);
  await admin.query(
    `set search_path = ${SCHEMA}; ${readFileSync(new URL('../sql/outbox.sql', import.meta.url), 'utf8')}; reset search_path;`,
  );
  await admin.query(`create table ${SCHEMA}.applied (event_id uuid primary key, note text not null)`);
  for (const q of QUEUES) await admin.query('select pgmq.create($1)', [q]);
  await admin.query(`
    create function ${SCHEMA}.queue_send(p_queue text, p_msg jsonb, p_delay integer default 0) returns bigint language sql as $$ select * from pgmq.send(p_queue, p_msg, p_delay) $$;
    create function ${SCHEMA}.queue_read(p_queue text, p_vt integer, p_qty integer) returns setof pgmq.message_record language sql as $$ select * from pgmq.read(p_queue, p_vt, p_qty) $$;
    create function ${SCHEMA}.queue_set_vt(p_queue text, p_msg_id bigint, p_vt_offset integer) returns void language sql as $$ select from pgmq.set_vt(p_queue, p_msg_id, p_vt_offset) $$;
    create function ${SCHEMA}.queue_delete(p_queue text, p_msg_id bigint) returns boolean language sql as $$ select pgmq.delete(p_queue, p_msg_id) $$;
    create function ${SCHEMA}.queue_archive(p_queue text, p_msg_id bigint) returns boolean language sql as $$ select pgmq.archive(p_queue, p_msg_id) $$;
    create function ${SCHEMA}.queue_depths(out queue_name text, out queue_length bigint, out oldest_msg_age_sec integer) returns setof record language sql as $$
      select m.queue_name, m.queue_length, m.oldest_msg_age_sec from pgmq.metrics_all() m where m.queue_name like 'it_${sfx}_%' $$;
  `);
});

afterAll(async () => {
  await handle.close();
  for (const q of QUEUES) await admin.query('select pgmq.drop_queue($1)', [q]);
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await admin.end();
});

describe('writeEvent', () => {
  it('is atomic with the caller’s transaction', async () => {
    await expect(
      withTransaction(db, async (trx) => {
        await writeEvent(trx, newEvent('offer.created.v1'));
        throw new Error('state change failed');
      }),
    ).rejects.toThrow('state change failed');
    expect(await unpublished()).toBe(0);

    const env = await withTransaction(db, (trx) => writeEvent(trx, newEvent('offer.created.v1', 3)));
    const row = await db
      .selectFrom('outbox')
      .selectAll()
      .where('id', '=', env.eventId)
      .executeTakeFirstOrThrow();
    expect(row.payload).toMatchObject({
      eventType: 'offer.created.v1',
      schemaVersion: 1,
      aggregateVersion: 3,
      producer: 'records',
      tenantId: TENANT,
    });
    expect(row.published_at).toBeNull();
  });
});

describe('relayOutbox', () => {
  it('fans out to every subscribed queue once, marks rows published, and is a no-op when repeated', async () => {
    await withTransaction(db, async (trx) => {
      await writeEvent(trx, newEvent('offer.created.v1'));
      await writeEvent(trx, newEvent('offer.updated.v1'));
    });
    const r = await relayOutbox(ctx, { routes });
    expect(r).toMatchObject({ processed: 3, unroutable: 0, remaining: 0 });
    expect(await queueDepth(db, SCHEMA, QA)).toBe(3);
    expect(await queueDepth(db, SCHEMA, QB)).toBe(2);
    expect((await relayOutbox(ctx, { routes })).processed).toBe(0);
  });

  it('leaves events without a route unpublished and reports them', async () => {
    await withTransaction(db, (trx) => writeEvent(trx, newEvent('offer.updated.v1')));
    const r = await relayOutbox(ctx, { routes: { 'offer.created.v1': routes['offer.created.v1'] } });
    expect(r).toMatchObject({ processed: 0, unroutable: 1, remaining: 0 });
    expect(await unpublished()).toBe(1);
    expect((await relayOutbox(ctx, { routes })).processed).toBe(1);
  });

  it('parallel relays never publish a row twice (FOR UPDATE SKIP LOCKED)', async () => {
    const before = (await queueDepth(db, SCHEMA, QA)) ?? 0;
    await withTransaction(db, async (trx) => {
      for (let i = 0; i < 40; i++) await writeEvent(trx, newEvent('offer.updated.v1'));
    });
    const results = await Promise.all([1, 2, 3, 4].map(() => relayOutbox(ctx, { routes, batchSize: 15 })));
    let total = results.reduce((n, r) => n + r.processed, 0);
    while ((await unpublished()) > 0) total += (await relayOutbox(ctx, { routes })).processed;
    expect(total).toBe(40);
    expect(await queueDepth(db, SCHEMA, QA)).toBe(before + 40);
  });
});

describe('drainEvents', () => {
  it('applies each event once even when delivered twice, in the handler’s transaction', async () => {
    let calls = 0;
    const handlers = {
      'offer.created.v1': async (
        e: EventEnvelope<'offer.created.v1'>,
        { trx }: { trx: Transaction<TestDb> },
      ) => {
        calls++;
        await trx.insertInto('applied').values({ event_id: e.eventId, note: e.eventType }).execute();
      },
      'offer.updated.v1': async (
        e: EventEnvelope<'offer.updated.v1'>,
        { trx }: { trx: Transaction<TestDb> },
      ) => {
        calls++;
        await trx.insertInto('applied').values({ event_id: e.eventId, note: e.eventType }).execute();
      },
    };
    // Re-deliver one message: same eventId twice on the queue.
    const [first] = await db
      .selectFrom('outbox')
      .select('payload')
      .where('event_type', '=', 'offer.updated.v1')
      .limit(1)
      .execute();
    await queueSend(db, SCHEMA, QA, first?.payload);

    const depth = (await queueDepth(db, SCHEMA, QA)) ?? 0;
    let processed = 0;
    let duplicates = 0;
    for (let i = 0; i < 5 && ((await queueDepth(db, SCHEMA, QA)) ?? 0) > 0; i++) {
      const r = await drainEvents(ctx, { queue: QA, consumer: 'test', handlers });
      processed += r.processed;
      duplicates += r.duplicates;
    }
    expect(processed + duplicates).toBe(depth);
    expect(duplicates).toBe(1);
    expect(calls).toBe(processed);
    const appliedRows = await db
      .selectFrom('applied')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(appliedRows.n)).toBe(processed);
    expect(await queueDepth(db, SCHEMA, QA)).toBe(0);
  });

  it('a failing handler rolls back its writes and dedupe, retries, and dead-letters after maxAttempts', async () => {
    await withTransaction(db, (trx) => writeEvent(trx, newEvent('offer.created.v1')));
    await relayOutbox(ctx, { routes });
    // drain QA only; QB keeps its copy
    let attempts = 0;
    const errors: string[] = [];
    const failing = {
      'offer.created.v1': async (
        e: EventEnvelope<'offer.created.v1'>,
        { trx }: { trx: Transaction<TestDb> },
      ) => {
        attempts++;
        await trx.insertInto('applied').values({ event_id: e.eventId, note: 'should roll back' }).execute();
        throw new Error('downstream unavailable');
      },
    };
    const opts = {
      queue: QA,
      consumer: 'test',
      handlers: failing,
      maxAttempts: 3,
      retryDelaySec: () => 0,
      onError: (e: unknown) => void errors.push((e as Error).message),
    };
    for (let i = 0; i < 3; i++) expect((await drainEvents(ctx, opts)).failed).toBe(1);
    expect(attempts).toBe(3);
    expect(
      await db.selectFrom('applied').select('event_id').where('note', '=', 'should roll back').execute(),
    ).toEqual([]);

    const last = await drainEvents(ctx, opts);
    expect(last).toMatchObject({ deadLettered: 1, failed: 0, remaining: 0 });
    expect(await queueDepth(db, SCHEMA, `${QA}_dlq`)).toBe(1);
    expect(errors).toEqual(['downstream unavailable', 'downstream unavailable', 'downstream unavailable']);

    // Runbook replay: back to the queue, then a healthy handler applies it once.
    expect(await replayDeadLetters(ctx, QA)).toBe(1);
    const ok = {
      'offer.created.v1': async (
        e: EventEnvelope<'offer.created.v1'>,
        { trx }: { trx: Transaction<TestDb> },
      ) => {
        await trx.insertInto('applied').values({ event_id: e.eventId, note: 'replayed' }).execute();
      },
    };
    expect((await drainEvents(ctx, { queue: QA, consumer: 'test', handlers: ok })).processed).toBe(1);
    expect(
      await db.selectFrom('applied').select('event_id').where('note', '=', 'replayed').execute(),
    ).toHaveLength(1);
  });

  it('dead-letters messages it cannot handle: bad envelope, unknown event type', async () => {
    await queueSend(db, SCHEMA, QB, { not: 'an envelope' });
    const r = await drainEvents(ctx, { queue: QB, consumer: 'test', handlers: {} });
    // QB also holds offer.created.v1 copies with no handler registered here.
    expect(r.deadLettered).toBeGreaterThanOrEqual(2);
    expect(r.processed).toBe(0);
    expect(await queueDepth(db, SCHEMA, QB)).toBe(0);
  });

  it('stops at the time budget and releases unprocessed messages immediately', async () => {
    for (let i = 0; i < 3; i++) await queueSend(db, SCHEMA, QW, { job: i });
    const seen: unknown[] = [];
    const r = await drainWork(ctx, {
      queue: QW,
      budgetMs: 0,
      handler: async (p) => void seen.push(p),
    });
    expect(r.processed).toBe(0);
    expect(r.remaining).toBe(3);
    const again = await drainWork(ctx, { queue: QW, handler: async (p) => void seen.push(p) });
    expect(again.processed).toBe(3);
    expect(seen).toEqual([{ job: 0 }, { job: 1 }, { job: 2 }]);
  });
});

describe('retention', () => {
  it('purges old processed events and published outbox rows only', async () => {
    await admin.query(`update ${SCHEMA}.processed_events set processed_at = now() - interval '31 days'`);
    await admin.query(
      `update ${SCHEMA}.outbox set published_at = now() - interval '8 days' where published_at is not null`,
    );
    await withTransaction(db, (trx) => writeEvent(trx, newEvent('offer.updated.v1')));
    expect(await purgeProcessedEvents(ctx)).toBeGreaterThan(0);
    expect(await purgePublishedOutbox(ctx)).toBeGreaterThan(0);
    expect(await unpublished()).toBe(1);
  });
});
