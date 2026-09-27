// Inspection (intake LLD §4.1, §4.2): POST /inspect checks the object and queues q_intake_inspect; the worker streams
// the file once for sha256, sheet list, header row, row count, migration_map detection, mode, suggested mapping and the
// identical-file check.
import { IntakeError, notFound } from '../domain/errors.js';
import {
  MIGRATION_SHEET,
  chooseLoadSheet,
  headerFingerprint,
  isStrictHeader,
  normaliseHeader,
  suggestMapping,
} from '../domain/schema.js';
import type { Upload } from '../domain/upload.js';
import type { App, StaffActor, SystemActor } from './context.js';
import { UnreadableFileError } from './ports.js';
import type { SheetRow, SpreadsheetReader, Tx } from './ports.js';

export interface InspectMessage {
  tenantId: string;
  uploadId: string;
  correlationId: string;
}

/** POST /v1/uploads/{id}/inspect: 202 when queued (or still inspecting), 200 when already inspected. */
export async function requestInspection(
  app: App,
  actor: StaffActor,
  idOrCode: string,
): Promise<{ upload: Upload; queued: boolean }> {
  const current = await app.uow.repos.uploads.find(actor.tenantId, idOrCode);
  if (!current) throw notFound('upload');
  if (current.status === 'inspecting') return { upload: current, queued: true };
  if (current.status !== 'awaiting_file') return { upload: current, queued: false };
  const stat = await app.files.stat(current.storagePath);
  if (!stat) throw new IntakeError('file-missing', 'upload the file to the signed URL first');
  if (stat.sizeBytes !== current.sizeBytes) {
    throw new IntakeError(
      'file-size-mismatch',
      `stored ${stat.sizeBytes} bytes, expected ${current.sizeBytes}`,
    );
  }
  return app.uow.transaction(async (tx) => {
    const u = await tx.repos.uploads.find(actor.tenantId, current.id, { forUpdate: true });
    if (!u) throw notFound('upload');
    if (u.status !== 'awaiting_file') return { upload: u, queued: u.status === 'inspecting' };
    const updated = (await tx.repos.uploads.update(actor.tenantId, u.id, { status: 'inspecting' })) as Upload;
    await enqueueInspection(tx, updated, actor.correlationId);
    return { upload: updated, queued: true };
  });
}

export async function enqueueInspection(tx: Tx, upload: Upload, correlationId: string): Promise<void> {
  const msg: InspectMessage = { tenantId: upload.tenantId, uploadId: upload.id, correlationId };
  await tx.queue.send('q_intake_inspect', { ...msg });
}

interface SheetStats {
  header: string[] | null;
  dataRows: number;
}

export interface WorkbookFacts {
  kind: 'xlsx' | 'csv';
  sha256: string;
  sheetNames: string[];
  sheets: Map<string | null, SheetStats>;
}

/** Streams the whole file once: header (first non-empty row) and data-row count of every sheet. */
export async function scanWorkbook(reader: SpreadsheetReader, path: string): Promise<WorkbookFacts> {
  const scan = await reader.open(path);
  const sheets = new Map<string | null, SheetStats>();
  const names: string[] = [];
  const onRow = (row: SheetRow) => {
    let s = sheets.get(row.sheet);
    if (!s) {
      s = { header: null, dataRows: 0 };
      sheets.set(row.sheet, s);
      if (row.sheet !== null) names.push(row.sheet);
    }
    if (s.header === null) s.header = row.cells.map((c) => (c ?? '').trim());
    else s.dataRows += 1;
  };
  for await (const row of scan.rows) onRow(row);
  return { kind: scan.kind, sha256: scan.summary().sha256, sheetNames: names, sheets };
}

/** q_intake_inspect handler. Idempotent: does nothing unless the upload is still `inspecting`. */
export async function runInspection(app: App, reader: SpreadsheetReader, msg: InspectMessage): Promise<void> {
  const actor: SystemActor = { kind: 'system', tenantId: msg.tenantId, correlationId: msg.correlationId };
  const upload = await app.uow.repos.uploads.find(msg.tenantId, msg.uploadId);
  if (!upload || upload.status !== 'inspecting') return;

  let facts: WorkbookFacts;
  try {
    facts = await scanWorkbook(reader, upload.storagePath);
  } catch (err) {
    if (err instanceof UnreadableFileError) return failUpload(app, actor, upload.id, 'unreadable_file');
    throw err;
  }
  const loadSheet =
    facts.kind === 'csv'
      ? null
      : upload.sheetName && facts.sheetNames.includes(upload.sheetName)
        ? upload.sheetName
        : chooseLoadSheet(facts.sheetNames);
  const stats = facts.sheets.get(loadSheet);
  const header = stats?.header ?? [];
  if (!stats || header.every((h) => h === '')) return failUpload(app, actor, upload.id, 'unreadable_file');
  if (stats.dataRows > app.policy.maxRows) return failUpload(app, actor, upload.id, 'too_many_rows');

  const strict = isStrictHeader(header);
  const fingerprint = headerFingerprint(header);
  const hasMigrationMap = facts.sheetNames.some((s) => normaliseHeader(s) === MIGRATION_SHEET);

  await app.uow.transaction(async (tx) => {
    const u = await tx.repos.uploads.find(msg.tenantId, upload.id, { forUpdate: true });
    if (!u || u.status !== 'inspecting') return;
    const template = strict
      ? undefined
      : await tx.repos.templates.findByFingerprint(msg.tenantId, fingerprint);
    const duplicate = await tx.repos.uploads.findCompletedBySha(msg.tenantId, facts.sha256, u.id);
    await tx.repos.uploads.update(msg.tenantId, u.id, {
      sha256: facts.sha256,
      sheetNames: facts.sheetNames,
      sheetName: loadSheet,
      header,
      headerFingerprint: fingerprint,
      rowEstimate: stats.dataRows,
      hasMigrationMap,
      mode: strict ? 'strict' : 'mapping',
      suggestedMapping: strict ? null : suggestMapping(header, template?.columnMap),
      templateId: u.templateId ?? template?.id ?? null,
      duplicateOfUploadId: duplicate?.id ?? null,
      status: duplicate ? 'awaiting_duplicate_confirmation' : strict ? 'ready' : 'awaiting_mapping',
    });
  });
}

/** Terminal failure before or during processing: status failed + upload.failed.v1 (aggregate version 2, LLD §5.1). */
export async function failUpload(
  app: App,
  actor: SystemActor,
  uploadId: string,
  reason: string,
): Promise<void> {
  await app.uow.transaction(async (tx) => {
    const u = await tx.repos.uploads.find(actor.tenantId, uploadId, { forUpdate: true });
    if (!u || ['completed', 'failed', 'cancelled'].includes(u.status)) return;
    const now = app.clock.now();
    await tx.repos.uploads.update(actor.tenantId, u.id, {
      status: 'failed',
      stage: null,
      failureReason: reason,
      completedAt: now,
      fileCleanupAt: now,
      purgeAfter: new Date(now.getTime() + app.policy.rawRowRetentionDays * 86_400_000),
    });
    await tx.events.emit({
      eventType: 'upload.failed.v1',
      tenantId: actor.tenantId,
      aggregateType: 'upload',
      aggregateId: u.id,
      aggregateVersion: 2,
      correlationId: actor.correlationId,
      data: { uploadId: u.id, code: u.code, reason, uploadedBy: u.uploadedBy },
    });
  });
}
