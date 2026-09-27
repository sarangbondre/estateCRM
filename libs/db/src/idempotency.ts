// Idempotency-Key store (conventions §3 + R-3): one `idempotency_keys` table per service schema, 24 h window,
// keyed per tenant, user, route and key. A replay returns the stored response; the same key with a different
// request body is a conflict; a request still being processed is reported as in-progress.
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';

export interface IdempotencyKeysTable {
  tenant_id: string;
  user_id: string;
  route: string;
  key: string;
  request_hash: string;
  status_code: number | null;
  response_body: unknown;
  created_at: Date;
  expires_at: Date;
}
export interface IdempotencyDb {
  idempotency_keys: IdempotencyKeysTable;
}

export interface IdempotencyRef {
  tenantId: string;
  userId: string;
  /** Method + route template, e.g. `POST /v1/offers`. */
  route: string;
  key: string;
}

export type IdempotencyBegin =
  | { outcome: 'new' }
  | { outcome: 'replay'; statusCode: number; body: unknown }
  | { outcome: 'conflict' }
  | { outcome: 'in-progress' };

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
};

/** Stable hash of a request body: key order doesn't matter. */
export function hashRequest(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(body ?? null)))
    .digest('hex');
}

const db_ = <DB>(db: Kysely<DB>) => db as unknown as Kysely<IdempotencyDb>;

/**
 * Claims the key. `new` means the caller must process the request and then `complete` (or `release` on failure).
 */
export async function beginIdempotent<DB>(
  db: Kysely<DB>,
  ref: IdempotencyRef,
  requestHash: string,
  now: Date = new Date(),
): Promise<IdempotencyBegin> {
  const k = db_(db);
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_WINDOW_MS);
  // An expired row for the same key is replaced, so keys can be reused after the window.
  await k
    .deleteFrom('idempotency_keys')
    .where('tenant_id', '=', ref.tenantId)
    .where('user_id', '=', ref.userId)
    .where('route', '=', ref.route)
    .where('key', '=', ref.key)
    .where('expires_at', '<=', now)
    .execute();
  const inserted = await k
    .insertInto('idempotency_keys')
    .values({
      tenant_id: ref.tenantId,
      user_id: ref.userId,
      route: ref.route,
      key: ref.key,
      request_hash: requestHash,
      status_code: null,
      response_body: null,
      created_at: now,
      expires_at: expiresAt,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'user_id', 'route', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();
  if (inserted) return { outcome: 'new' };

  const row = await k
    .selectFrom('idempotency_keys')
    .select(['request_hash', 'status_code', 'response_body'])
    .where('tenant_id', '=', ref.tenantId)
    .where('user_id', '=', ref.userId)
    .where('route', '=', ref.route)
    .where('key', '=', ref.key)
    .executeTakeFirst();
  if (!row) return beginIdempotent(db, ref, requestHash, now); // released concurrently: claim again
  if (row.request_hash !== requestHash) return { outcome: 'conflict' };
  if (row.status_code === null) return { outcome: 'in-progress' };
  return { outcome: 'replay', statusCode: row.status_code, body: row.response_body };
}

/** Stores the response to replay. Call in the same transaction as the state change when possible. */
export async function completeIdempotent<DB>(
  db: Kysely<DB>,
  ref: IdempotencyRef,
  statusCode: number,
  body: unknown,
): Promise<void> {
  await db_(db)
    .updateTable('idempotency_keys')
    .set({ status_code: statusCode, response_body: JSON.stringify(body ?? null) })
    .where('tenant_id', '=', ref.tenantId)
    .where('user_id', '=', ref.userId)
    .where('route', '=', ref.route)
    .where('key', '=', ref.key)
    .execute();
}

/** Frees the key after a failure that must not be replayed (5xx, dependency errors), so the client can retry. */
export async function releaseIdempotent<DB>(db: Kysely<DB>, ref: IdempotencyRef): Promise<void> {
  await db_(db)
    .deleteFrom('idempotency_keys')
    .where('tenant_id', '=', ref.tenantId)
    .where('user_id', '=', ref.userId)
    .where('route', '=', ref.route)
    .where('key', '=', ref.key)
    .where('status_code', 'is', null)
    .execute();
}

/** Deletes expired keys in bounded batches (the expire-idempotency-keys job). Returns rows deleted. */
export async function expireIdempotencyKeys<DB>(
  db: Kysely<DB>,
  now: Date = new Date(),
  batchSize = 5000,
): Promise<number> {
  const k = db_(db);
  const result = await k
    .deleteFrom('idempotency_keys')
    .where((eb) =>
      eb(
        eb.refTuple('tenant_id', 'user_id', 'route', 'key'),
        'in',
        eb
          .selectFrom('idempotency_keys')
          .select(['tenant_id', 'user_id', 'route', 'key'])
          .where('expires_at', '<=', now)
          .limit(batchSize) as never, // Kysely can't type a 4-column tuple IN (subquery)
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
