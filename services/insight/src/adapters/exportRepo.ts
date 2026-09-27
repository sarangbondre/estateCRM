// export_job repository: the job row and its work message commit together; completion/failure and their events
// (export.completed.v1 / export.failed.v1 + audit.recorded.v1) are written through the transactional outbox.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { tenantScope } from '@11e/db';
import { queueSend, writeEvents } from '@11e/outbox';
import type { ExportJob, ExportRepo } from '../application/ports.js';
import type { QueryPlan } from '../domain/plans/types.js';
import { SCHEMA, SERVICE } from '../config.js';
import { nextCode } from './conversationRepo.js';
import type { ExportJobRow, InsightDb } from './db.js';

export const EXPORT_QUEUE = 'q_insight_exports';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = ExportJobRow & { created_at: Date };
const toJob = (r: Row): ExportJob => ({
  id: r.id,
  code: r.code,
  requestedBy: r.requested_by,
  requesterRole: r.requester_role,
  plan: r.plan as QueryPlan,
  includeContacts: r.include_contacts,
  fileName: r.file_name,
  status: r.status,
  estimatedRows: r.estimated_rows,
  rowCount: r.row_count,
  filePath: r.file_path,
  fileBytes: r.file_bytes === null ? null : Number(r.file_bytes),
  sourceMessageId: r.source_message_id,
  attempts: r.attempts,
  errorCode: r.error_code,
  completedAt: r.completed_at,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

export function createExportRepo(db: Kysely<InsightDb>): ExportRepo {
  const select = (tenantId: string) => tenantScope(db, tenantId).selectFrom('export_job').selectAll();
  return {
    async countSince(tenantId, userId, since) {
      const r = await tenantScope(db, tenantId)
        .selectFrom('export_job')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('requested_by', '=', userId)
        .where('created_at', '>=', since)
        .executeTakeFirst();
      return Number(r?.n ?? 0);
    },
    async create(tenantId, job, fileNameOf, now) {
      return db.transaction().execute(async (trx) => {
        const code = await nextCode(trx as unknown as Kysely<InsightDb>, tenantId, 'EXP', 6);
        const fileName = fileNameOf(code);
        await tenantScope(trx, tenantId)
          .insertInto('export_job', {
            id: job.id,
            code,
            requested_by: job.requestedBy,
            requester_role: job.requesterRole,
            plan: JSON.stringify(job.plan),
            include_contacts: job.includeContacts,
            file_name: fileName,
            status: 'queued',
            estimated_rows: job.estimatedRows,
            source_message_id: job.sourceMessageId,
            attempts: 0,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await queueSend(trx, SCHEMA, EXPORT_QUEUE, { tenantId, exportId: job.id });
        return { ...job, code, fileName, createdAt: now };
      });
    },
    async get(tenantId, idOrCode) {
      const q = UUID.test(idOrCode) ? select(tenantId).where('id', '=', idOrCode) : select(tenantId).where('code', '=', idOrCode.toUpperCase());
      const r = await q.executeTakeFirst();
      return r ? toJob(r as Row) : null;
    },
    async list(tenantId, userId, status, limit, after) {
      let q = select(tenantId);
      if (userId) q = q.where('requested_by', '=', userId);
      if (status) q = q.where('status', '=', status);
      if (after) q = q.where(sql<boolean>`(created_at, id) < (${new Date(after.k)}, ${after.id}::uuid)`);
      const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
      return rows.map((r) => toJob(r as Row));
    },
    async claim(tenantId, id, now) {
      const r = await tenantScope(db, tenantId)
        .updateTable('export_job')
        .set({ status: 'running', attempts: sql<number>`attempts + 1`, updated_at: now })
        .where('id', '=', id)
        .where('status', 'in', ['queued', 'running'])
        .returningAll()
        .executeTakeFirst();
      return r ? toJob(r as Row) : null;
    },
    async complete(tenantId, job, r) {
      await db.transaction().execute(async (trx) => {
        await tenantScope(trx, tenantId)
          .updateTable('export_job')
          .set({
            status: 'completed',
            row_count: r.rowCount,
            file_path: r.filePath,
            file_bytes: r.fileBytes,
            completed_at: r.now,
            expires_at: r.expiresAt,
            error_code: null,
            updated_at: r.now,
          })
          .where('id', '=', job.id)
          .execute();
        await writeEvents(trx, [
          {
            eventType: 'export.completed.v1',
            tenantId,
            aggregateType: 'export',
            aggregateId: job.id,
            aggregateVersion: 2,
            data: { exportId: job.id, code: job.code, rowCount: r.rowCount, requestedBy: job.requestedBy, includesPii: job.includeContacts },
            correlationId: r.correlationId,
            producer: SERVICE,
            occurredAt: r.now,
          },
          {
            eventType: 'audit.recorded.v1',
            tenantId,
            aggregateType: 'audit',
            aggregateId: randomUUID(),
            aggregateVersion: 1,
            data: {
              action: 'export.created',
              actorUserId: job.requestedBy,
              subjectType: 'export',
              subjectId: job.id,
              via: r.via,
              details: { rowCount: String(r.rowCount), includesPii: String(job.includeContacts), planId: job.plan.planId },
            },
            correlationId: r.correlationId,
            producer: SERVICE,
            occurredAt: r.now,
          },
        ]);
      });
    },
    async fail(tenantId, job, errorCode, now, correlationId) {
      await db.transaction().execute(async (trx) => {
        await tenantScope(trx, tenantId)
          .updateTable('export_job')
          .set({ status: 'failed', error_code: errorCode, updated_at: now })
          .where('id', '=', job.id)
          .execute();
        await writeEvents(trx, [
          {
            eventType: 'export.failed.v1',
            tenantId,
            aggregateType: 'export',
            aggregateId: job.id,
            aggregateVersion: 2,
            data: { exportId: job.id, code: job.code, requestedBy: job.requestedBy, reason: errorCode },
            correlationId,
            producer: SERVICE,
            occurredAt: now,
          },
        ]);
      });
    },
    async expiring(now, limit) {
      const r = await sql<{ tenant_id: string; id: string; file_path: string | null }>`
        select tenant_id, id, file_path from export_job
         where status = 'completed' and expires_at <= ${now}
         order by expires_at limit ${limit}`.execute(db);
      return r.rows.map((x) => ({ tenantId: x.tenant_id, id: x.id, filePath: x.file_path }));
    },
    async markExpired(tenantId, id, now) {
      await tenantScope(db, tenantId).updateTable('export_job').set({ status: 'expired', updated_at: now }).where('id', '=', id).execute();
    },
  };
}
