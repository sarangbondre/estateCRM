// HTTP plumbing shared by the route modules: principal → actor, RecordsError → RFC 7807, pagination, idempotency.
import type { MiddlewareHandler } from 'hono';
import { principalOf } from '@11e/auth';
import { HttpError, decodeCursor, encodeCursor, idempotent, ifMatchVersion, pageLimit, toProblem } from '@11e/http';
import type { OperationHandler, ServiceContext, ServiceEnv } from '@11e/http';
import type { Kysely } from 'kysely';
import type { Actor } from '../../application/context.js';
import type { RecordsDb } from '../db/schema.js';
import type { After } from '../../application/queries.js';
import { RecordsError } from '../../domain/errors.js';
import { SERVICE_USER_ID } from './constants.js';

/** An HttpError carrying RFC 7807 extension members (e.g. `candidates`). */
export class ExtendedHttpError extends HttpError {
  readonly extensions: Record<string, unknown>;
  constructor(status: number, code: string, detail: string | undefined, extensions: Record<string, unknown>) {
    super(status, code, detail ? { detail } : {});
    this.extensions = extensions;
  }
}

export function toHttpError(err: unknown): unknown {
  if (!(err instanceof RecordsError)) return err;
  if (err.extensions) return new ExtendedHttpError(err.status, err.code, err.detail, err.extensions);
  return new HttpError(err.status, err.code, {
    ...(err.detail ? { detail: err.detail } : {}),
    ...(err.errors ? { errors: err.errors } : {}),
    ...(err.headers ? { headers: err.headers } : {}),
  });
}

/** Runs use-case code, translating business errors to HTTP errors (so idempotent() can store 4xx replays). */
export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttpError(err);
  }
}

/** Wraps an operation handler: business errors become RFC 7807 responses (with extension members when present). */
export function wrap<Op>(handler: OperationHandler<Op>): OperationHandler<Op> {
  return async (c, input) => {
    try {
      return await handler(c, input);
    } catch (err) {
      const e = toHttpError(err);
      if (e instanceof ExtendedHttpError) {
        const body = { ...toProblem(e, c.get('correlationId')), ...e.extensions };
        return new Response(JSON.stringify(body), {
          status: e.status,
          headers: { 'content-type': 'application/problem+json', 'x-correlation-id': c.get('correlationId') },
        });
      }
      throw e;
    }
  };
}

/** The acting principal. Service tokens act as the service (reads only; writes need staff). */
export function actorOf(c: ServiceContext): Actor {
  const p = principalOf(c);
  const correlationId = c.get('correlationId');
  if (p.kind === 'staff') {
    return { tenantId: p.tenantId, userId: p.userId, role: p.role, correlationId, via: 'ui' };
  }
  if (p.kind === 'service') {
    return { tenantId: p.tenantId, userId: SERVICE_USER_ID, role: `service:${p.caller}`, correlationId, via: 'system' };
  }
  throw new HttpError(403, 'forbidden', { detail: 'no tenant for this caller' });
}

export function page(query: { limit?: number | undefined; cursor?: string | undefined }): { limit: number; after: After | undefined } {
  const limit = pageLimit(query.limit);
  const pos = decodeCursor<{ k?: string | number | null; id?: string }>(query.cursor);
  if (pos && typeof pos.id !== 'string') throw new HttpError(400, 'validation-failed', { errors: [{ field: 'cursor', code: 'invalid-cursor' }] });
  return { limit, after: pos ? { k: pos.k ?? null, id: pos.id as string } : undefined };
}

/** `{ items, nextCursor }` from limit + 1 rows. */
export function pageOf<R, T>(
  rows: readonly R[],
  limit: number,
  key: (row: R) => { k: string | number | null; id: string },
  present: (rows: R[]) => T[] | Promise<T[]>,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const slice = rows.slice(0, limit);
  const last = slice.at(-1);
  const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(key(last)) : null;
  return Promise.resolve(present(slice)).then((items) => ({ items, nextCursor }));
}

export const isoKey = (d: Date | string | null) => (d instanceof Date ? d.toISOString() : d);

/** Mutating POST with Idempotency-Key (R-3): replays the stored status/body. */
export function withIdempotency(
  c: ServiceContext,
  deps: { db: Kysely<RecordsDb> },
  actor: Actor,
  body: unknown,
  fn: () => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  return idempotent(c, deps.db, { tenantId: actor.tenantId, userId: actor.userId }, body, () => guard(fn));
}

export { ifMatchVersion };

export const json = (c: ServiceContext, body: unknown, status = 200) => c.json(body as object, status as 200);

/** Marks responses that must never be cached (contact PII). */
export const noStore: MiddlewareHandler<ServiceEnv> = async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
};
