// Upload aggregate: status machine, ownership and pilot policy (intake LLD §4.1, §4.9, §9; CR-005, CR-006 Z-9).
import { IntakeError } from './errors.js';

export const UPLOAD_STATUSES = [
  'awaiting_file',
  'inspecting',
  'awaiting_mapping',
  'ready',
  'awaiting_duplicate_confirmation',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];
export type UploadStage = 'parsing' | 'normalising' | 'classifying' | 'emitting';
export type IntakeMode = 'strict' | 'mapping';
export type SourceType = 'Channel' | 'Digi' | 'Direct';
export type StaffRoleName = 'Admin' | 'Manager' | 'Demand agent' | 'Supply agent' | 'Data operator';

export interface UploadCounts {
  read: number;
  accepted: number;
  rejected: number;
  needsReview: number;
  unchanged: number;
  unclassified: number;
}

export interface Upload {
  id: string;
  tenantId: string;
  code: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storagePath: string;
  sha256: string | null;
  sheetNames: string[] | null;
  sheetName: string | null;
  header: string[] | null;
  headerFingerprint: string | null;
  rowEstimate: number | null;
  mode: IntakeMode | null;
  status: UploadStatus;
  stage: UploadStage | null;
  sourceType: SourceType;
  sourceDetail: string | null;
  templateId: string | null;
  columnMap: Record<string, string | null> | null;
  suggestedMapping: Record<string, string | null> | null;
  constants: Record<string, unknown> | null;
  anonymise: boolean;
  importCrmNotes: boolean;
  reprocessUnchanged: boolean;
  allowDuplicate: boolean;
  vocabularyVersion: string | null;
  hasMigrationMap: boolean;
  migrationEntries: number;
  duplicateOfUploadId: string | null;
  chunkSize: number | null;
  chunkCount: number | null;
  chunksDone: number;
  chunksFailed: number;
  batchCount: number | null;
  batchesEmitted: number;
  counts: UploadCounts;
  rejectedFilePath: string | null;
  rejectedFileReadyAt: Date | null;
  failureReason: string | null;
  uploadedBy: string;
  startedAt: Date | null;
  completedAt: Date | null;
  sourceFileDeletedAt: Date | null;
  fileCleanupAt: Date | null;
  purgeAfter: Date | null;
  purgedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_UPLOAD_BYTES = 52_428_800;
export const UPLOADS_PER_HOUR = 5;
export const CODE_PREFIX = 'UPL';

export const CONTENT_TYPES: Record<string, 'csv' | 'xls' | 'xlsx'> = {
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const EDITABLE: readonly UploadStatus[] = [
  'awaiting_file',
  'inspecting',
  'awaiting_mapping',
  'ready',
  'awaiting_duplicate_confirmation',
];
const TERMINAL: readonly UploadStatus[] = ['completed', 'failed', 'cancelled'];

export const isEditable = (s: UploadStatus) => EDITABLE.includes(s);
export const isTerminal = (s: UploadStatus) => TERMINAL.includes(s);
export const hasStarted = (s: UploadStatus) => s === 'queued' || s === 'processing';

export function formatCode(n: number | bigint): string {
  return `${CODE_PREFIX}-${String(n).padStart(6, '0')}`;
}

export const isUploadCode = (s: string) => /^UPL-\d{6,}$/i.test(s);

/** Extension of the file name must agree with the declared MIME type. */
export function checkFileType(fileName: string, contentType: string): void {
  const kind = CONTENT_TYPES[contentType];
  const ext = /\.([a-z]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (!kind || ext !== kind) {
    throw new IntakeError('unsupported-media-type', `file type ${ext ?? '?'} does not match ${contentType}`);
  }
}

/** Pilot policy (§4.9): anonymise defaults to true and cannot be turned off until the paid-plan gate. */
export function resolveAnonymise(requested: boolean | undefined, pilotMode: boolean): boolean {
  if (!pilotMode) return requested ?? false;
  if (requested === false) {
    throw new IntakeError('anonymise-required', 'the pilot accepts anonymised or sample data only (CR-005)');
  }
  return true;
}

/** Uploader, Admin and Manager may change or cancel an upload (§9 row-level re-checks). */
export function canManage(upload: Upload, userId: string, role: StaffRoleName): boolean {
  return upload.uploadedBy === userId || role === 'Admin' || role === 'Manager';
}

/** Rejected-rows link: uploader, Admin, Manager or Data operator (file holds contact PII). */
export function canDownloadRejected(upload: Upload, userId: string, role: StaffRoleName): boolean {
  return canManage(upload, userId, role) || role === 'Data operator';
}

export function storagePathFor(tenantId: string, uploadId: string): string {
  return `intake-uploads/${tenantId}/${uploadId}/source`;
}

export function chunkPathFor(tenantId: string, uploadId: string, chunkNo: number): string {
  return `intake-uploads/${tenantId}/${uploadId}/chunks/${chunkNo}.ndjson`;
}

export function rejectedPathFor(tenantId: string, uploadId: string): string {
  return `intake-rejected/${tenantId}/${uploadId}.csv`;
}

/** Rough ETA from the chunk throughput so far (null until one chunk is done). */
export function etaSeconds(upload: Upload, now: Date): number | null {
  if (upload.status !== 'processing' || !upload.startedAt || !upload.chunkCount) return null;
  const done = upload.chunksDone + upload.chunksFailed;
  if (done === 0) return null;
  const elapsed = (now.getTime() - upload.startedAt.getTime()) / 1000;
  return Math.max(0, Math.round((elapsed / done) * (upload.chunkCount - done)));
}
