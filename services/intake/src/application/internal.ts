// Internal read APIs for records (LLD §4.6, §4.10): the full rows (PII) of one emitted batch, and the migration map.
// Callers are service tokens with sub=records (x-callers enforced by libs/auth); tenant from the token.
import { IntakeError, notFound } from '../domain/errors.js';
import type { Upload } from '../domain/upload.js';
import type { App } from './context.js';
import type { MigrationEntry, RawRowRecord } from './ports.js';

export interface BatchView {
  upload: Upload;
  batchNo: number;
  rows: RawRowRecord[];
}

export async function getBatchRows(
  app: App,
  tenantId: string,
  uploadId: string,
  batchNo: number,
): Promise<BatchView> {
  const upload = await app.uow.repos.uploads.find(tenantId, uploadId);
  if (!upload) throw notFound('upload');
  const rows = upload.purgedAt ? [] : await app.uow.repos.rawRows.batch(tenantId, upload.id, batchNo);
  if (!rows.length)
    throw new IntakeError('batch-not-found', `batch ${batchNo} was not emitted or its rows were purged`);
  return { upload, batchNo, rows };
}

export interface RowNoteView {
  upload: Upload;
  rowNo: number;
  note: string;
}

/**
 * crm_notes of one upload row for journeys (CR-012). 404 when the upload or row is unknown, the row has no note, or
 * the raw rows were purged (retention). The note is PII: never logged or cached.
 */
export async function getRowNote(app: App, tenantId: string, uploadId: string, rowNo: number): Promise<RowNoteView> {
  const upload = await app.uow.repos.uploads.find(tenantId, uploadId);
  if (!upload) throw notFound('upload');
  const note = upload.purgedAt ? undefined : await app.uow.repos.rawRows.note(tenantId, upload.id, rowNo);
  if (!note) throw notFound('note');
  return { upload, rowNo, note };
}

export async function getInternalMigrationMap(
  app: App,
  tenantId: string,
  uploadId: string,
  afterEntryNo: number | undefined,
  limit: number,
): Promise<MigrationEntry[]> {
  const upload = await app.uow.repos.uploads.find(tenantId, uploadId);
  if (!upload) throw notFound('upload');
  return app.uow.repos.migration.list(tenantId, upload.id, undefined, afterEntryNo, limit + 1);
}
