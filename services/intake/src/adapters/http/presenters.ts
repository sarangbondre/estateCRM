// Domain → contract JSON (intake.yaml components). Never includes cell values (headers only).
import type { components } from '@11e/contracts/intake';
import type { Upload } from '../../domain/upload.js';
import type { RowErrorRecord } from '../../application/ports.js';
import { iso } from './support.js';

type S = components['schemas'];

export function presentUpload(u: Upload): S['Upload'] {
  return {
    id: u.id,
    code: u.code,
    fileName: u.fileName,
    contentType: u.contentType,
    sizeBytes: u.sizeBytes,
    sheetNames: u.sheetNames ?? [],
    sheetName: u.sheetName,
    status: u.status,
    stage: u.stage,
    mode: u.mode,
    sourceType: u.sourceType,
    sourceDetail: u.sourceDetail,
    templateId: u.templateId,
    anonymise: u.anonymise,
    importCrmNotes: u.importCrmNotes,
    vocabularyVersion: u.vocabularyVersion,
    hasMigrationMap: u.hasMigrationMap,
    duplicateOfUploadId: u.duplicateOfUploadId,
    chunkSize: u.chunkSize,
    chunkCount: u.chunkCount,
    chunksDone: u.chunksDone,
    batchCount: u.batchCount,
    counts: { ...u.counts, migrationEntries: u.migrationEntries },
    header: u.header ?? [],
    suggestedMapping: u.suggestedMapping,
    columnMap: u.columnMap,
    rejectedFileReady: u.rejectedFileReadyAt !== null,
    failureReason: u.failureReason,
    uploadedBy: u.uploadedBy,
    createdAt: u.createdAt.toISOString(),
    startedAt: iso(u.startedAt),
    completedAt: iso(u.completedAt),
    version: u.version,
  };
}

export function presentRowError(e: RowErrorRecord): S['RowError'] {
  return {
    id: e.id,
    rowNo: e.rowNo,
    sheetName: e.sheetName,
    field: e.field,
    severity: e.severity,
    code: e.code as S['RowError']['code'],
    value: e.value,
    message: e.message,
  };
}
