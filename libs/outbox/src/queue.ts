// Thin calls to the service's pgmq wrapper functions (<schema>.queue_*; platform bootstrap, data-hosting §3).
// Raw SQL is schema-qualified explicitly: Kysely's schema binding doesn't reach raw templates.
import { sql } from 'kysely';
import type { AnyDb, QueueMessage } from './types.js';

const fn = (schema: string, name: string) => sql.id(schema, name);

export async function queueRead<DB>(
  db: AnyDb<DB>,
  schema: string,
  queue: string,
  vtSec: number,
  qty: number,
) {
  const r = await sql<QueueMessage>`select msg_id::text as msg_id, read_ct, enqueued_at, vt, message
    from ${fn(schema, 'queue_read')}(${queue}, ${vtSec}, ${qty})`.execute(db);
  return r.rows;
}

export async function queueSend<DB>(
  db: AnyDb<DB>,
  schema: string,
  queue: string,
  message: unknown,
  delaySec = 0,
) {
  const r = await sql<{
    id: string;
  }>`select ${fn(schema, 'queue_send')}(${queue}, ${JSON.stringify(message)}::jsonb, ${delaySec})::text as id`.execute(
    db,
  );
  return r.rows[0]?.id;
}

/** Sends many messages in one statement (queues[i] gets payloads[i]). */
export async function queueSendMany<DB>(db: AnyDb<DB>, schema: string, queues: string[], payloads: string[]) {
  if (!queues.length) return;
  await sql`select ${fn(schema, 'queue_send')}(t.q, t.p, 0)
    from unnest(${queues}::text[], ${payloads}::jsonb[]) as t(q, p)`.execute(db);
}

export async function queueDelete<DB>(db: AnyDb<DB>, schema: string, queue: string, msgId: string) {
  await sql`select ${fn(schema, 'queue_delete')}(${queue}, ${msgId}::bigint)`.execute(db);
}

export async function queueArchive<DB>(db: AnyDb<DB>, schema: string, queue: string, msgId: string) {
  await sql`select ${fn(schema, 'queue_archive')}(${queue}, ${msgId}::bigint)`.execute(db);
}

export async function queueSetVt<DB>(
  db: AnyDb<DB>,
  schema: string,
  queue: string,
  msgId: string,
  offsetSec: number,
) {
  await sql`select ${fn(schema, 'queue_set_vt')}(${queue}, ${msgId}::bigint, ${Math.max(0, Math.trunc(offsetSec))})`.execute(
    db,
  );
}

export async function queueDepth<DB>(db: AnyDb<DB>, schema: string, queue: string): Promise<number | null> {
  const r = await sql<{ queue_length: string }>`select queue_length::text as queue_length
    from ${fn(schema, 'queue_depths')}() where queue_name = ${queue}`.execute(db);
  const v = r.rows[0]?.queue_length;
  return v === undefined ? null : Number(v);
}
