// Tenant-scoped query helper (conventions §2: every query filters on tenant_id; PRD NFR-15).
// Services build business queries through `tenantScope(db, tenantId)` so the tenant filter and the tenant_id on
// inserts cannot be forgotten. Technical tables (outbox, processed_events, idempotency_keys, R-4) use their own helpers.
import { sql } from 'kysely';
import type {
  DeleteQueryBuilder,
  DeleteResult,
  InsertQueryBuilder,
  InsertResult,
  Insertable,
  Kysely,
  SelectQueryBuilder,
  Transaction,
  UpdateQueryBuilder,
  UpdateResult,
} from 'kysely';

/** Tables of DB that carry a tenant_id column. */
export type TenantTable<DB> = {
  [K in keyof DB & string]: DB[K] extends { tenant_id: unknown } ? K : never;
}[keyof DB & string];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantError extends Error {
  override readonly name = 'InvalidTenantError';
}

export function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId))
    throw new InvalidTenantError('tenant id must be a UUID');
}

export interface TenantScope<DB> {
  readonly tenantId: string;
  selectFrom<T extends TenantTable<DB>>(table: T): SelectQueryBuilder<DB, T, object>;
  insertInto<T extends TenantTable<DB>>(
    table: T,
    rows: Omit<Insertable<DB[T]>, 'tenant_id'> | readonly Omit<Insertable<DB[T]>, 'tenant_id'>[],
  ): InsertQueryBuilder<DB, T, InsertResult>;
  updateTable<T extends TenantTable<DB>>(table: T): UpdateQueryBuilder<DB, T, T, UpdateResult>;
  deleteFrom<T extends TenantTable<DB>>(table: T): DeleteQueryBuilder<DB, T, DeleteResult>;
}

export function tenantScope<DB>(db: Kysely<DB> | Transaction<DB>, tenantId: string): TenantScope<DB> {
  assertTenantId(tenantId);
  // Kysely's overloads can't resolve a generic table name; the casts are confined to this adapter.
  const k = db as unknown as Kysely<Record<string, Record<string, unknown>>>;
  const byTenant = (table: string) => sql<boolean>`${sql.ref(`${table}.tenant_id`)} = ${tenantId}`;
  return {
    tenantId,
    selectFrom(table) {
      return k.selectFrom(table as string).where(byTenant(table)) as never;
    },
    insertInto(table, rows) {
      const list = (Array.isArray(rows) ? rows : [rows]) as readonly Record<string, unknown>[];
      return k.insertInto(table as string).values(list.map((r) => ({ ...r, tenant_id: tenantId }))) as never;
    },
    updateTable(table) {
      return k.updateTable(table as string).where(byTenant(table)) as never;
    },
    deleteFrom(table) {
      return k.deleteFrom(table as string).where(byTenant(table)) as never;
    },
  };
}
