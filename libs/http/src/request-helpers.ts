// Idempotency-Key handling (conventions §4, R-3), If-Match (optimistic concurrency) and cursor pagination.
import { beginIdempotent, completeIdempotent, hashRequest, releaseIdempotent } from '@11e/db';
import type { Kysely } from '@11e/db';
import type { ServiceContext } from './app.js';
import { HttpError, badRequest, toProblem } from './errors.js';

export interface IdempotencyIdentity {
  tenantId: string;
  userId: string;
}

/**
 * Runs a mutating POST at most once per Idempotency-Key. Without the header the handler just runs.
 * - replay → the stored status and body; same key + different body → 409 idempotency-key-reused;
 * - still running → 409 conflict with Retry-After: 1;
 * - handler 5xx or throw → the key is released so the client can retry.
 */
export async function idempotent<DB>(
  c: ServiceContext,
  db: Kysely<DB>,
  who: IdempotencyIdentity,
  body: unknown,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const key = c.req.header('idempotency-key');
  if (!key) {
    const r = await handler();
    return c.json(r.body as object, r.status as 201);
  }
  const op = c.get('operation');
  const ref = {
    tenantId: who.tenantId,
    userId: who.userId,
    route: `${c.req.method} ${op?.path ?? c.req.routePath}`,
    key,
  };
  const begin = await beginIdempotent(db, ref, hashRequest(body));
  switch (begin.outcome) {
    case 'replay':
      c.header('idempotent-replayed', 'true');
      if (begin.statusCode >= 400) {
        c.header('content-type', 'application/problem+json');
        return c.body(JSON.stringify(begin.body), begin.statusCode as 409);
      }
      return c.json(begin.body as object, begin.statusCode as 201);
    case 'conflict':
      throw new HttpError(409, 'idempotency-key-reused');
    case 'in-progress':
      throw new HttpError(409, 'conflict', {
        detail: 'a request with this Idempotency-Key is still being processed',
        headers: { 'retry-after': '1' },
      });
    case 'new':
      break;
  }
  let result: { status: number; body: unknown };
  try {
    result = await handler();
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) await releaseIdempotent(db, ref);
    else await completeIdempotent(db, ref, err.status, toProblem(err, c.get('correlationId')));
    throw err;
  }
  if (result.status >= 500) await releaseIdempotent(db, ref);
  else await completeIdempotent(db, ref, result.status, result.body);
  return c.json(result.body as object, result.status as 201);
}

/** Parses `If-Match: <version>` (quoted or not, W/ allowed). Undefined when absent. */
export function ifMatchVersion(c: ServiceContext): number | undefined {
  const raw = c.req.header('if-match');
  if (raw === undefined) return undefined;
  const v = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^\d{1,10}$/.test(v))
    throw badRequest([{ field: 'If-Match', code: 'format', message: 'expected a row version number' }]);
  return Number(v);
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/** Opaque cursor: base64url JSON of the last row's sort key (e.g. `{ k: '2026-09-27T…', id: '…' }`). */
export function encodeCursor(position: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string | undefined): T | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as T;
  } catch {
    // fall through
  }
  throw badRequest([{ field: 'cursor', code: 'invalid-cursor' }]);
}

export function pageLimit(limit: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit ?? DEFAULT_LIMIT)));
}

/**
 * Builds `{ items, nextCursor }` from a query that fetched `limit + 1` rows ordered by (sortKey, id).
 */
export function toPage<T>(rows: T[], limit: number, positionOf: (row: T) => Record<string, unknown>) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(positionOf(last)) : null,
  };
}
