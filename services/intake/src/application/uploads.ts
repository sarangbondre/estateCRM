// Upload lifecycle use cases (intake LLD §4.1, §9): create with a signed URL, read, list, patch, cancel, progress,
// row errors, rejected-rows link and the parsed migration map.
import { IntakeError, notFound } from '../domain/errors.js';
import {
  MAX_UPLOAD_BYTES,
  UPLOADS_PER_HOUR,
  canDownloadRejected,
  canManage,
  checkFileType,
  etaSeconds,
  isEditable,
  isTerminal,
  resolveAnonymise,
  storagePathFor,
} from '../domain/upload.js';
import type { SourceType, Upload } from '../domain/upload.js';
import type { App, StaffActor } from './context.js';
import { enqueueInspection } from './inspection.js';
import { SYSTEM_USER_ID } from './context.js';
import type {
  MigrationAction,
  MigrationEntry,
  Position,
  RowErrorRecord,
  SignedUrl,
  UploadListFilter,
} from './ports.js';

export const SIGNED_LINK_TTL_SEC = 900;

export interface CreateUploadInput {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sourceType: SourceType;
  sourceDetail?: string | undefined;
  anonymise?: boolean | undefined;
  importCrmNotes?: boolean | undefined;
}

export async function createUpload(
  app: App,
  actor: StaffActor,
  input: CreateUploadInput,
  extras: { templateId?: string | null } = {},
): Promise<{ upload: Upload; uploadUrl: SignedUrl }> {
  checkFileType(input.fileName, input.contentType);
  if (input.sizeBytes > MAX_UPLOAD_BYTES)
    throw new IntakeError('payload-too-large', 'files are limited to 50 MB');
  const anonymise = resolveAnonymise(input.anonymise, app.policy.pilotMode);
  const now = app.clock.now();

  const upload = await app.uow.transaction(async (tx) => {
    const recent = await tx.repos.uploads.countSince(
      actor.tenantId,
      actor.userId,
      new Date(now.getTime() - 3_600_000),
    );
    if (recent >= UPLOADS_PER_HOUR) {
      throw new IntakeError('rate-limited', `at most ${UPLOADS_PER_HOUR} uploads per hour`, undefined, 600);
    }
    const id = app.ids.uuid();
    const u: Upload = {
      id,
      tenantId: actor.tenantId,
      code: await tx.repos.uploads.nextCode(actor.tenantId),
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      storagePath: storagePathFor(actor.tenantId, id),
      sha256: null,
      sheetNames: null,
      sheetName: null,
      header: null,
      headerFingerprint: null,
      rowEstimate: null,
      mode: null,
      status: 'awaiting_file',
      stage: null,
      sourceType: input.sourceType,
      sourceDetail: input.sourceDetail ?? null,
      templateId: extras.templateId ?? null,
      columnMap: null,
      suggestedMapping: null,
      constants: null,
      anonymise,
      importCrmNotes: input.importCrmNotes ?? false,
      reprocessUnchanged: false,
      allowDuplicate: false,
      vocabularyVersion: null,
      hasMigrationMap: false,
      migrationEntries: 0,
      duplicateOfUploadId: null,
      chunkSize: null,
      chunkCount: null,
      chunksDone: 0,
      chunksFailed: 0,
      batchCount: null,
      batchesEmitted: 0,
      counts: { read: 0, accepted: 0, rejected: 0, needsReview: 0, unchanged: 0, unclassified: 0 },
      rejectedFilePath: null,
      rejectedFileReadyAt: null,
      failureReason: null,
      uploadedBy: actor.userId,
      startedAt: null,
      completedAt: null,
      sourceFileDeletedAt: null,
      // an abandoned upload's file is removed by delete-processed-files after the retention window
      fileCleanupAt: new Date(now.getTime() + 30 * 86_400_000),
      purgeAfter: null,
      purgedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await tx.repos.uploads.insert(u);
    return u;
  });
  const uploadUrl = await app.files.signedUploadUrl(upload.storagePath);
  return { upload, uploadUrl };
}

export async function getUpload(app: App, tenantId: string, idOrCode: string): Promise<Upload> {
  const upload = await app.uow.repos.uploads.find(tenantId, idOrCode);
  if (!upload) throw notFound('upload');
  return upload;
}

export function listUploads(
  app: App,
  tenantId: string,
  filter: UploadListFilter,
  after: Position | undefined,
  limit: number,
): Promise<Upload[]> {
  return app.uow.repos.uploads.list(tenantId, filter, after, limit + 1);
}

export interface UploadPatchInput {
  anonymise?: boolean | undefined;
  importCrmNotes?: boolean | undefined;
  sourceDetail?: string | undefined;
  sheetName?: string | undefined;
}

export async function patchUpload(
  app: App,
  actor: StaffActor,
  idOrCode: string,
  patch: UploadPatchInput,
  ifMatch: number | undefined,
): Promise<Upload> {
  return app.uow.transaction(async (tx) => {
    const upload = await tx.repos.uploads.find(actor.tenantId, idOrCode, { forUpdate: true });
    if (!upload) throw notFound('upload');
    if (!canManage(upload, actor.userId, actor.role)) {
      throw new IntakeError('forbidden', 'only the uploader, an Admin or a Manager can change this upload');
    }
    if (ifMatch !== undefined && ifMatch !== upload.version) throw new IntakeError('version-mismatch');
    if (!isEditable(upload.status))
      throw new IntakeError('upload-not-editable', `upload is ${upload.status}`);
    const changes: Parameters<typeof tx.repos.uploads.update>[2] = {};
    if (patch.anonymise !== undefined)
      changes.anonymise = resolveAnonymise(patch.anonymise, app.policy.pilotMode);
    if (patch.importCrmNotes !== undefined) changes.importCrmNotes = patch.importCrmNotes;
    if (patch.sourceDetail !== undefined) changes.sourceDetail = patch.sourceDetail;
    if (patch.sheetName !== undefined) {
      if (upload.sheetNames && !upload.sheetNames.includes(patch.sheetName)) {
        throw new IntakeError('sheet-not-found', `sheet "${patch.sheetName}" is not in the workbook`, [
          { field: 'sheetName', code: 'sheet-not-found' },
        ]);
      }
      changes.sheetName = patch.sheetName;
    }
    // A different sheet after inspection means a different header: inspect again (mapping is reset).
    const reinspect =
      changes.sheetName !== undefined &&
      changes.sheetName !== upload.sheetName &&
      upload.header !== null &&
      upload.status !== 'inspecting';
    if (reinspect) Object.assign(changes, { status: 'inspecting', columnMap: null, suggestedMapping: null });
    const updated = await tx.repos.uploads.update(actor.tenantId, upload.id, changes, upload.version);
    if (!updated) throw new IntakeError('version-mismatch');
    if (reinspect) await enqueueInspection(tx, updated, actor.correlationId);
    return updated;
  });
}

/**
 * Cancels an upload that has not completed (§4.1). Queued chunks are skipped by the worker (it re-reads the status).
 * upload.failed.v1 (reason cancelled) only if processing had started, i.e. upload.started.v1 was emitted.
 */
export async function cancelUpload(app: App, actor: StaffActor, idOrCode: string): Promise<Upload> {
  return app.uow.transaction(async (tx) => {
    const upload = await tx.repos.uploads.find(actor.tenantId, idOrCode, { forUpdate: true });
    if (!upload) throw notFound('upload');
    if (!canManage(upload, actor.userId, actor.role)) {
      throw new IntakeError('forbidden', 'only the uploader, an Admin or a Manager can cancel this upload');
    }
    if (isTerminal(upload.status))
      throw new IntakeError('upload-not-cancellable', `upload is ${upload.status}`);
    const now = app.clock.now();
    const updated = await tx.repos.uploads.update(actor.tenantId, upload.id, {
      status: 'cancelled',
      stage: null,
      failureReason: 'cancelled',
      completedAt: now,
      fileCleanupAt: now,
      purgeAfter: new Date(now.getTime() + app.policy.rawRowRetentionDays * 86_400_000),
    });
    if (upload.status === 'processing') {
      await tx.events.emit({
        eventType: 'upload.failed.v1',
        tenantId: actor.tenantId,
        aggregateType: 'upload',
        aggregateId: upload.id,
        aggregateVersion: 2,
        correlationId: actor.correlationId,
        data: { uploadId: upload.id, code: upload.code, reason: 'cancelled', uploadedBy: upload.uploadedBy },
      });
    }
    return updated as Upload;
  });
}

export interface Progress {
  upload: Upload;
  etaSeconds: number | null;
}

export async function getProgress(app: App, tenantId: string, idOrCode: string): Promise<Progress> {
  const upload = await getUpload(app, tenantId, idOrCode);
  return { upload, etaSeconds: etaSeconds(upload, app.clock.now()) };
}

export async function listRowErrors(
  app: App,
  tenantId: string,
  idOrCode: string,
  filter: { field?: string | undefined; code?: string | undefined },
  after: { rowNo: number; id: string } | undefined,
  limit: number,
): Promise<RowErrorRecord[]> {
  const upload = await getUpload(app, tenantId, idOrCode);
  return app.uow.repos.rowErrors.list(tenantId, upload.id, filter, after, limit + 1);
}

/** Signed 15-minute link to the rejected-rows CSV; each call records one audit entry (LLD §5.1). */
export async function getRejectedRowsLink(
  app: App,
  actor: StaffActor,
  idOrCode: string,
): Promise<{ link: SignedUrl; rowCount: number }> {
  const upload = await getUpload(app, actor.tenantId, idOrCode);
  if (!canDownloadRejected(upload, actor.userId, actor.role)) {
    throw new IntakeError(
      'forbidden',
      'only the uploader, an Admin, a Manager or a Data operator can download',
    );
  }
  if (upload.status !== 'completed' || !upload.rejectedFilePath || !upload.rejectedFileReadyAt) {
    throw new IntakeError(
      'rejected-file-not-ready',
      upload.status === 'completed' ? 'this upload has no rejected rows' : `upload is ${upload.status}`,
    );
  }
  const link = await app.files.signedReadUrl(upload.rejectedFilePath, SIGNED_LINK_TTL_SEC);
  await app.uow.transaction(async (tx) => {
    await tx.events.emit({
      eventType: 'audit.recorded.v1',
      tenantId: actor.tenantId,
      aggregateType: 'audit',
      aggregateId: app.ids.uuid(),
      aggregateVersion: 1,
      correlationId: actor.correlationId,
      data: {
        action: 'rejected_rows_downloaded',
        actorUserId: actor.userId || SYSTEM_USER_ID,
        subjectType: 'upload',
        subjectId: upload.id,
        via: 'ui',
        details: { uploadCode: upload.code, rowCount: String(upload.counts.rejected) },
      },
    });
  });
  return { link, rowCount: upload.counts.rejected };
}

export interface MigrationMapView {
  upload: Upload;
  byAction: Record<MigrationAction, number>;
  items: MigrationEntry[];
}

export async function getMigrationMap(
  app: App,
  tenantId: string,
  idOrCode: string,
  action: MigrationAction | undefined,
  afterEntryNo: number | undefined,
  limit: number,
): Promise<MigrationMapView> {
  const upload = await getUpload(app, tenantId, idOrCode);
  const [items, byAction] = await Promise.all([
    app.uow.repos.migration.list(tenantId, upload.id, action, afterEntryNo, limit + 1),
    app.uow.repos.migration.countByAction(tenantId, upload.id),
  ]);
  return { upload, byAction, items };
}
