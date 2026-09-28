// Shared plumbing for the HTTP handlers: caller identity, tenant-bound transactions, JourneyError → RFC 7807,
// idempotent POSTs, If-Match and cursor pages.
import { assertTenant, requireStaff, tenantOf } from '@11e/auth';
import type { StaffPrincipal, StaffRole } from '@11e/auth';
import { HttpError, decodeCursor, encodeCursor, idempotent, ifMatchVersion, pageLimit } from '@11e/http';
import type { ServiceContext } from '@11e/http';
import { JourneyError } from '../application/errors.js';
import type { Tx, TxRunner } from '../application/ports.js';
import type { Position } from '../application/queries.js';
import type { AppDeps } from '../deps.js';
import { createTxRunner } from './store.js';

export interface Http {
  deps: AppDeps;
  runner: TxRunner;
  /** Runs fn in one transaction for the caller's tenant; business errors become problem responses. */
  tx<T>(c: ServiceContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  staff(c: ServiceContext, roles?: readonly StaffRole[]): StaffPrincipal;
  /** Idempotent POST (Idempotency-Key, R-3): the handler runs its own transaction. */
  post(c: ServiceContext, body: unknown, status: number, fn: (tx: Tx) => Promise<unknown>): Promise<Response>;
  ifMatch(c: ServiceContext): number | undefined;
  page<T>(rows: T[], limit: number, position: (row: T) => Position): { items: T[]; nextCursor: string | null };
  cursor(c: ServiceContext, raw: string | undefined): Position | undefined;
  limit(v: number | undefined): number;
}

export function toHttpError(err: unknown): unknown {
  if (err instanceof JourneyError) return new HttpError(err.status, err.code, { detail: err.message });
  return err;
}

export function createHttp(deps: AppDeps): Http {
  const runner = createTxRunner(deps.db, () => deps.clock.now());
  const tx = async <T>(c: ServiceContext, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    try {
      return await runner.run(tenantOf(c), { correlationId: c.get('correlationId') }, fn);
    } catch (err) {
      throw toHttpError(err);
    }
  };
  return {
    deps,
    runner,
    tx,
    staff: (c, roles) => requireStaff(c, roles),
    async post(c, body, status, fn) {
      const p = requireStaff(c);
      return idempotent(c, deps.db, { tenantId: p.tenantId, userId: p.userId }, body ?? null, async () => ({
        status,
        body: await tx(c, fn),
      }));
    },
    ifMatch: (c) => ifMatchVersion(c),
    page(rows, limit, position) {
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(position(last)) : null };
    },
    cursor: (_c, raw) => decodeCursor<Position>(raw),
    limit: (v) => pageLimit(v),
  };
}

export { assertTenant };
