// UploadRepository on Postgres (intake LLD §3.1). Every query goes through tenantScope and maps to an index of §3.1.
import { sql, tenantScope } from '@11e/db';
import type { Kysely, Selectable, Transaction, Updateable } from '@11e/db';
import { formatCode, isUploadCode } from '../../domain/upload.js';
import type { IntakeMode, SourceType, Upload, UploadStage, UploadStatus } from '../../domain/upload.js';
import type { UploadPatch, UploadRepository } from '../../application/ports.js';
import type { IntakeDb, UploadsTable } from '../db.js';

type Db = Kysely<IntakeDb> | Transaction<IntakeDb>;
type Row = Selectable<UploadsTable>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

export function toUpload(r: Row): Upload {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    fileName: r.file_name,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    storagePath: r.storage_path,
    sha256: r.sha256,
    sheetNames: r.sheet_names,
    sheetName: r.sheet_name,
    header: r.header,
    headerFingerprint: r.header_fingerprint,
    rowEstimate: r.row_estimate,
    mode: r.mode as IntakeMode | null,
    status: r.status as UploadStatus,
    stage: r.stage as UploadStage | null,
    sourceType: r.source_type as SourceType,
    sourceDetail: r.source_detail,
    templateId: r.template_id,
    columnMap: r.column_map,
    suggestedMapping: r.suggested_mapping,
    constants: r.constants,
    anonymise: r.anonymise,
    importCrmNotes: r.import_crm_notes,
    reprocessUnchanged: r.reprocess_unchanged,
    allowDuplicate: r.allow_duplicate,
    vocabularyVersion: r.vocabulary_version,
    hasMigrationMap: r.has_migration_map,
    migrationEntries: r.migration_entries,
    duplicateOfUploadId: r.duplicate_of_upload_id,
    chunkSize: r.chunk_size,
    chunkCount: r.chunk_count,
    chunksDone: r.chunks_done,
    chunksFailed: r.chunks_failed,
    batchCount: r.batch_count,
    batchesEmitted: r.batches_emitted,
    counts: {
      read: r.rows_read,
      accepted: r.rows_accepted,
      rejected: r.rows_rejected,
      needsReview: r.rows_needs_review,
      unchanged: r.rows_unchanged,
      unclassified: r.rows_unclassified,
    },
    rejectedFilePath: r.rejected_file_path,
    rejectedFileReadyAt: r.rejected_file_ready_at,
    failureReason: r.failure_reason,
    uploadedBy: r.uploaded_by,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    sourceFileDeletedAt: r.source_file_deleted_at,
    fileCleanupAt: r.file_cleanup_at,
    purgeAfter: r.purge_after,
    purgedAt: r.purged_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMN: Record<string, keyof UploadsTable> = {
  fileName: 'file_name',
  contentType: 'content_type',
  sizeBytes: 'size_bytes',
  storagePath: 'storage_path',
  sha256: 'sha256',
  sheetNames: 'sheet_names',
  sheetName: 'sheet_name',
  header: 'header',
  headerFingerprint: 'header_fingerprint',
  rowEstimate: 'row_estimate',
  mode: 'mode',
  status: 'status',
  stage: 'stage',
  sourceType: 'source_type',
  sourceDetail: 'source_detail',
  templateId: 'template_id',
  columnMap: 'column_map',
  suggestedMapping: 'suggested_mapping',
  constants: 'constants',
  anonymise: 'anonymise',
  importCrmNotes: 'import_crm_notes',
  reprocessUnchanged: 'reprocess_unchanged',
  allowDuplicate: 'allow_duplicate',
  vocabularyVersion: 'vocabulary_version',
  hasMigrationMap: 'has_migration_map',
  migrationEntries: 'migration_entries',
  duplicateOfUploadId: 'duplicate_of_upload_id',
  chunkSize: 'chunk_size',
  chunkCount: 'chunk_count',
  chunksDone: 'chunks_done',
  chunksFailed: 'chunks_failed',
  batchCount: 'batch_count',
  batchesEmitted: 'batches_emitted',
  rejectedFilePath: 'rejected_file_path',
  rejectedFileReadyAt: 'rejected_file_ready_at',
  failureReason: 'failure_reason',
  uploadedBy: 'uploaded_by',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  sourceFileDeletedAt: 'source_file_deleted_at',
  fileCleanupAt: 'file_cleanup_at',
  purgeAfter: 'purge_after',
  purgedAt: 'purged_at',
  updatedAt: 'updated_at',
};
const JSON_FIELDS = new Set(['columnMap', 'suggestedMapping', 'constants']);

function toColumns(patch: UploadPatch): Updateable<UploadsTable> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const col = COLUMN[key];
    if (!col || value === undefined) continue;
    out[col] = JSON_FIELDS.has(key) ? json(value) : value;
  }
  return out as Updateable<UploadsTable>;
}

const COUNTER: Record<string, keyof UploadsTable> = {
  read: 'rows_read',
  accepted: 'rows_accepted',
  rejected: 'rows_rejected',
  needsReview: 'rows_needs_review',
  unchanged: 'rows_unchanged',
  unclassified: 'rows_unclassified',
  chunksDone: 'chunks_done',
  chunksFailed: 'chunks_failed',
  batchesEmitted: 'batches_emitted',
};

export function uploadRepository(db: Db): UploadRepository {
  return {
    async insert(u) {
      await tenantScope(db, u.tenantId)
        .insertInto('uploads', {
          id: u.id,
          code: u.code,
          file_name: u.fileName,
          content_type: u.contentType,
          size_bytes: u.sizeBytes,
          storage_path: u.storagePath,
          status: u.status,
          source_type: u.sourceType,
          source_detail: u.sourceDetail,
          template_id: u.templateId,
          anonymise: u.anonymise,
          import_crm_notes: u.importCrmNotes,
          uploaded_by: u.uploadedBy,
          file_cleanup_at: u.fileCleanupAt,
          sha256: null,
          sheet_names: null,
          sheet_name: null,
          header: null,
          header_fingerprint: null,
          row_estimate: null,
          mode: null,
          stage: null,
          vocabulary_version: null,
          duplicate_of_upload_id: null,
          chunk_size: null,
          chunk_count: null,
          batch_count: null,
          rejected_file_path: null,
          failure_reason: null,
          created_at: u.createdAt,
          updated_at: u.updatedAt,
        })
        .execute();
    },

    async find(tenantId, idOrCode, options = {}) {
      let q = tenantScope(db, tenantId).selectFrom('uploads').selectAll();
      if (UUID.test(idOrCode)) q = q.where('id', '=', idOrCode);
      else if (isUploadCode(idOrCode)) q = q.where('code', '=', idOrCode.toUpperCase());
      else return undefined;
      if (options.forUpdate) q = q.forUpdate();
      const row = await q.executeTakeFirst();
      return row ? toUpload(row as Row) : undefined;
    },

    async list(tenantId, filter, after, limit) {
      let q = tenantScope(db, tenantId).selectFrom('uploads').selectAll();
      if (filter.status) q = q.where('status', '=', filter.status);
      if (filter.sourceType) q = q.where('source_type', '=', filter.sourceType);
      if (filter.uploadedBy) q = q.where('uploaded_by', '=', filter.uploadedBy);
      if (filter.mode) q = q.where('mode', '=', filter.mode);
      if (after) q = q.where(sql<boolean>`(created_at, id) < (${after.k}::timestamptz, ${after.id}::uuid)`);
      const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
      return (rows as Row[]).map(toUpload);
    },

    async update(tenantId, id, patch, expectedVersion) {
      let q = tenantScope(db, tenantId)
        .updateTable('uploads')
        .set({
          ...toColumns(patch),
          updated_at: new Date(),
          version: sql`version + 1`,
        } as unknown as Updateable<UploadsTable>)
        .where('id', '=', id);
      if (expectedVersion !== undefined) q = q.where('version', '=', expectedVersion);
      const row = await q.returningAll().executeTakeFirst();
      return row ? toUpload(row as Row) : undefined;
    },

    async addCounts(tenantId, id, delta) {
      const set: Record<string, unknown> = { updated_at: new Date() };
      for (const [key, value] of Object.entries(delta)) {
        const col = COUNTER[key];
        if (col && value) set[col] = sql`${sql.ref(col)} + ${value}`;
      }
      const row = await tenantScope(db, tenantId)
        .updateTable('uploads')
        .set(set as Updateable<UploadsTable>)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toUpload(row as Row);
    },

    async countSince(tenantId, uploadedBy, since) {
      const r = await tenantScope(db, tenantId)
        .selectFrom('uploads')
        .select(sql<string>`count(*)`.as('n'))
        .where('uploaded_by', '=', uploadedBy)
        .where('created_at', '>', since)
        .executeTakeFirst();
      return Number((r as { n?: string } | undefined)?.n ?? 0);
    },

    async findCompletedBySha(tenantId, sha256, excludeId) {
      const row = await tenantScope(db, tenantId)
        .selectFrom('uploads')
        .selectAll()
        .where('sha256', '=', sha256)
        .where('status', '=', 'completed')
        .where('id', '<>', excludeId)
        .limit(1)
        .executeTakeFirst();
      return row ? toUpload(row as Row) : undefined;
    },

    async nextCode(tenantId) {
      const r = await sql<{
        n: string;
      }>`insert into ${sql.table('intake.code_sequences')} (tenant_id, prefix, next_value)
        values (${tenantId}, 'UPL', 2)
        on conflict (tenant_id, prefix) do update set next_value = code_sequences.next_value + 1
        returning (next_value - 1)::text as n`.execute(db);
      return formatCode(Number(r.rows[0]?.n ?? 1));
    },

    async purgeDue(now, limit) {
      const rows = await db
        .selectFrom('uploads')
        .selectAll()
        .where('purge_after', 'is not', null)
        .where('purged_at', 'is', null)
        .where('purge_after', '<', now)
        .orderBy('purge_after')
        .limit(limit)
        .execute();
      return (rows as Row[]).map(toUpload);
    },

    async fileCleanupDue(now, limit) {
      const rows = await db
        .selectFrom('uploads')
        .selectAll()
        .where('file_cleanup_at', 'is not', null)
        .where('file_cleanup_at', '<', now)
        .orderBy('file_cleanup_at')
        .limit(limit)
        .execute();
      return (rows as Row[]).map(toUpload);
    },
  };
}
