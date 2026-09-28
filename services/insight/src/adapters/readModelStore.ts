// ReadModelStore on a Kysely transaction (the drain's): generic tenant-scoped upserts of rm_* rows, per-stream
// aggregate versions, rollup and daily-fact delta upserts. Every statement filters on tenant_id (NFR-15).
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { tenantScope } from '@11e/db';
import type { ReadModelStore } from '../application/ports.js';
import { DEMAND_DIMS, OFFER_DIMS } from '../domain/readmodel/rollupKeys.js';
import type { DemandDims, FactDims, OfferDims } from '../domain/readmodel/rollupKeys.js';
import type { RmTable, RmTables } from '../domain/readmodel/rows.js';
import type { InsightDb } from './db.js';

type Db = Kysely<InsightDb> | Transaction<InsightDb>;
type Loose = Kysely<Record<string, Record<string, unknown>>>;

const FACT_DIMS: readonly (keyof FactDims)[] = [
  'segment',
  'deal_type',
  'market',
  'source_type',
  'owner_user_id',
  'micromarket',
  'reason',
];

/**
 * md5 over the tuple in a fixed column order, null as '∅', joined by U+001F. rollup-reconcile computes the same
 * hash in SQL (`md5(concat_ws(E'\x1f', coalesce(col::text, '∅'), …))`), so both paths address the same rows.
 */
export function dimsHash(order: readonly string[], dims: Record<string, unknown>): string {
  const text = order
    .map((k) => {
      const v = dims[k];
      return v === null || v === undefined ? '∅' : String(v);
    })
    .join('\u001f');
  return createHash('md5').update(text).digest('hex');
}

/** Row values → Postgres parameters (plain objects → jsonb text; arrays stay Postgres arrays). */
export function toDbValues(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v;
  }
  return out;
}

/** Database row → read-model row (timestamps as ISO strings, technical columns dropped). */
export function fromDbRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'tenant_id' || k === 'created_at' || k === 'updated_at') continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out as T;
}

export function createReadModelStore(db: Db, tenantId: string): ReadModelStore {
  const t = tenantScope(db, tenantId);
  const loose = db as unknown as Loose;

  return {
    tenantId,
    async get<T extends RmTable>(table: T, id: string) {
      const row = await loose
        .selectFrom(table)
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? fromDbRow<RmTables[T]>(row) : undefined;
    },
    async getMany<T extends RmTable>(table: T, ids: readonly string[]) {
      if (!ids.length) return [];
      const rows = await loose
        .selectFrom(table)
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', 'in', [...ids])
        .execute();
      return rows.map((r) => fromDbRow<RmTables[T]>(r));
    },
    async upsert(table, id, patch) {
      const values = toDbValues({ ...(patch as Record<string, unknown>) });
      delete values['id'];
      const k = loose as unknown as Kysely<Record<'t', Record<string, unknown>>>;
      // Update first: NOT NULL columns are checked on the proposed insert row even when it conflicts.
      if (Object.keys(values).length) {
        const updated = await k
          .updateTable(table as 't')
          .set({ ...values, updated_at: new Date() } as never)
          .where('tenant_id', '=', tenantId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) > 0) return;
      }
      await k
        .insertInto(table as 't')
        .values({ ...values, tenant_id: tenantId, id })
        .onConflict((oc) =>
          Object.keys(values).length
            ? oc.columns(['tenant_id', 'id']).doUpdateSet({ ...values, updated_at: new Date() } as never)
            : oc.columns(['tenant_id', 'id']).doNothing(),
        )
        .execute();
    },
    async offerIdsOfProperty(propertyId) {
      const rows = await t
        .selectFrom('rm_offer')
        .select('id')
        .where('property_id', '=', propertyId)
        .limit(200)
        .execute();
      return rows.map((r) => r.id);
    },
    async version(aggregateId, stream) {
      const row = await t
        .selectFrom('rm_version')
        .select('version')
        .where('aggregate_id', '=', aggregateId)
        .where('producer', '=', stream)
        .executeTakeFirst();
      return row ? row.version : null;
    },
    async setVersion(aggregateId, stream, version) {
      await t
        .insertInto('rm_version', { aggregate_id: aggregateId, producer: stream, version })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'aggregate_id', 'producer']).doUpdateSet({ version, updated_at: new Date() }),
        )
        .execute();
    },
    async offerRollup(dims: OfferDims, delta) {
      const hash = dimsHash(OFFER_DIMS, dims as unknown as Record<string, unknown>);
      await t
        .insertInto('rm_offer_rollup', { ...dims, dims_hash: hash, n: delta })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'dims_hash'])
            .doUpdateSet({ n: sql<number>`rm_offer_rollup.n + ${delta}`, updated_at: new Date() }),
        )
        .execute();
    },
    async demandRollup(dims: DemandDims, delta) {
      const hash = dimsHash(DEMAND_DIMS, dims as unknown as Record<string, unknown>);
      await t
        .insertInto('rm_demand_rollup', { ...dims, dims_hash: hash, n: delta })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'dims_hash'])
            .doUpdateSet({ n: sql<number>`rm_demand_rollup.n + ${delta}`, updated_at: new Date() }),
        )
        .execute();
    },
    async fact(day, metric, dims, delta) {
      const hash = dimsHash(FACT_DIMS, dims as unknown as Record<string, unknown>);
      await t
        .insertInto('rm_daily_fact', { ...dims, day, metric, dims_hash: hash, n: delta })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'day', 'metric', 'dims_hash'])
            .doUpdateSet({ n: sql<number>`rm_daily_fact.n + ${delta}`, updated_at: new Date() }),
        )
        .execute();
    },
    async queueCounts(userId, counts) {
      await t
        .insertInto('rm_queue_counts', { user_id: userId, counts: JSON.stringify(counts) })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'user_id']).doUpdateSet({ counts: JSON.stringify(counts), updated_at: new Date() }),
        )
        .execute();
    },
    async user(userId, role, active) {
      await t
        .insertInto('rm_user', { user_id: userId, role, active })
        .onConflict((oc) => oc.columns(['tenant_id', 'user_id']).doUpdateSet({ role, active, updated_at: new Date() }))
        .execute();
    },
    async applied(occurredAt, now) {
      const lag = Math.max(0, Math.round((now.getTime() - occurredAt.getTime()) / 1000));
      await t
        .insertInto('rm_state', { last_event_at: occurredAt, lag_seconds: lag, events_applied: 1 })
        .onConflict((oc) =>
          oc.column('tenant_id').doUpdateSet({
            last_event_at: sql<Date>`greatest(rm_state.last_event_at, ${occurredAt})`,
            lag_seconds: lag,
            events_applied: sql<number>`rm_state.events_applied + 1`,
            updated_at: new Date(),
          }),
        )
        .execute();
    },
    async requestReferenceRefresh(reason) {
      await t
        .insertInto('job_checkpoint', { job: 'vocabulary-refresh', cursor: `pending:${reason}` })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'job']).doUpdateSet({ cursor: `pending:${reason}`, updated_at: new Date() }),
        )
        .execute();
    },
  };
}
