// Row errors (LLD §3.4) and migration map entries (§3.8) on Postgres.
import { sql, tenantScope } from '@11e/db';
import type { Kysely, Transaction } from '@11e/db';
import type {
  MigrationAction,
  MigrationEntry,
  MigrationMapRepository,
  RowErrorRecord,
  RowErrorRepository,
} from '../../application/ports.js';
import type { IntakeDb } from '../db.js';

type Db = Kysely<IntakeDb> | Transaction<IntakeDb>;
const INSERT_BATCH = 1000;

export function rowErrorRepository(db: Db): RowErrorRepository {
  return {
    async insertMany(rows) {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const part = rows.slice(i, i + INSERT_BATCH);
        const tenantId = part[0]?.tenantId;
        if (!tenantId) continue;
        await tenantScope(db, tenantId)
          .insertInto(
            'row_errors',
            part.map((r) => ({
              id: r.id,
              upload_id: r.uploadId,
              row_id: r.rowId,
              row_no: r.rowNo,
              sheet_name: r.sheetName,
              field: r.field,
              severity: r.severity,
              code: r.code,
              value: r.value,
              message: r.message,
            })),
          )
          .onConflict((oc) => oc.columns(['tenant_id', 'upload_id', 'row_no', 'field', 'code']).doNothing())
          .execute();
      }
    },

    async list(tenantId, uploadId, filter, after, limit) {
      let q = tenantScope(db, tenantId)
        .selectFrom('row_errors')
        .selectAll()
        .where('upload_id', '=', uploadId);
      if (filter.field) q = q.where('field', '=', filter.field);
      if (filter.code) q = q.where('code', '=', filter.code);
      if (after) q = q.where(sql<boolean>`(row_no, id) > (${after.rowNo}, ${after.id}::uuid)`);
      const rows = await q.orderBy('row_no').orderBy('id').limit(limit).execute();
      return rows.map((r): RowErrorRecord => ({
        id: r.id,
        tenantId: r.tenant_id,
        uploadId: r.upload_id,
        rowId: r.row_id,
        rowNo: r.row_no,
        sheetName: r.sheet_name,
        field: r.field,
        severity: r.severity as 'error' | 'warning',
        code: r.code,
        value: r.value,
        message: r.message,
      }));
    },

    async forRows(tenantId, uploadId, rowNos) {
      if (!rowNos.length) return [];
      const rows = await tenantScope(db, tenantId)
        .selectFrom('row_errors')
        .selectAll()
        .where('upload_id', '=', uploadId)
        .where('row_no', 'in', [...rowNos])
        .orderBy('row_no')
        .orderBy('id')
        .limit(rowNos.length * 100)
        .execute();
      return rows.map((r): RowErrorRecord => ({
        id: r.id,
        tenantId: r.tenant_id,
        uploadId: r.upload_id,
        rowId: r.row_id,
        rowNo: r.row_no,
        sheetName: r.sheet_name,
        field: r.field,
        severity: r.severity as 'error' | 'warning',
        code: r.code,
        value: r.value,
        message: r.message,
      }));
    },

    async rejectionReasons(tenantId, uploadId) {
      const rows = await tenantScope(db, tenantId)
        .selectFrom('row_errors')
        .select(['code', sql<string>`count(*)`.as('n')])
        .where('upload_id', '=', uploadId)
        .where('severity', '=', 'error')
        .groupBy('code')
        .execute();
      return Object.fromEntries(rows.map((r) => [r.code, Number(r.n)]));
    },
  };
}

export function migrationMapRepository(db: Db): MigrationMapRepository {
  return {
    async insertMany(tenantId, uploadId, entries, newId) {
      for (let i = 0; i < entries.length; i += INSERT_BATCH) {
        const part = entries.slice(i, i + INSERT_BATCH);
        if (!part.length) continue;
        await tenantScope(db, tenantId)
          .insertInto(
            'migration_map_entries',
            part.map((e) => ({
              id: newId(),
              upload_id: uploadId,
              entry_no: e.entryNo,
              old_ref: e.oldRef,
              new_refs: e.newRefs,
              action: e.action,
            })),
          )
          .onConflict((oc) => oc.columns(['tenant_id', 'upload_id', 'entry_no']).doNothing())
          .execute();
      }
    },

    async list(tenantId, uploadId, action, afterEntryNo, limit) {
      let q = tenantScope(db, tenantId)
        .selectFrom('migration_map_entries')
        .select(['entry_no', 'old_ref', 'new_refs', 'action'])
        .where('upload_id', '=', uploadId);
      if (action) q = q.where('action', '=', action);
      if (afterEntryNo !== undefined) q = q.where('entry_no', '>', afterEntryNo);
      const rows = await q.orderBy('entry_no').limit(limit).execute();
      return rows.map((r): MigrationEntry => ({
        entryNo: r.entry_no,
        oldRef: r.old_ref,
        newRefs: r.new_refs,
        action: r.action as MigrationAction,
      }));
    },

    async countByAction(tenantId, uploadId) {
      const rows = await tenantScope(db, tenantId)
        .selectFrom('migration_map_entries')
        .select(['action', sql<string>`count(*)`.as('n')])
        .where('upload_id', '=', uploadId)
        .groupBy('action')
        .execute();
      const out: Record<MigrationAction, number> = { kept: 0, merged: 0, split: 0 };
      for (const r of rows) out[r.action as MigrationAction] = Number(r.n);
      return out;
    },
  };
}
