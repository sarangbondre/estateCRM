// Ports the use cases depend on (intake LLD §2). Adapters implement them; src/main.ts wires them (CLAUDE.md §3.1).
import type { EventDataMap, EventType } from '@11e/contracts/events';
import type { MigrationAction, MigrationEntry } from '../domain/migration.js';
import type { Template } from '../domain/template.js';
import type { Upload, UploadCounts, UploadStatus, IntakeMode, SourceType } from '../domain/upload.js';

// ---- infrastructure ports ---------------------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUIDv7 (conventions §2). */
  uuid(): string;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/** Supabase Storage, addressed as `<bucket>/<key>` paths (intake LLD §2 adapters/storage). */
export interface FileStore {
  /** Signed single-use PUT URL for the browser (ADR-0005). */
  signedUploadUrl(path: string): Promise<SignedUrl>;
  /** Signed GET link. */
  signedReadUrl(path: string, expiresInSec: number): Promise<SignedUrl>;
  /** Object size, or undefined when it does not exist. */
  stat(path: string): Promise<{ sizeBytes: number } | undefined>;
  /** Streams the object. Throws when missing. */
  read(path: string): Promise<AsyncIterable<Uint8Array>>;
  put(path: string, body: Uint8Array | string, contentType: string): Promise<void>;
  /** Deletes objects; missing ones are ignored. */
  remove(paths: readonly string[]): Promise<void>;
}

/** One non-empty row of a sheet. `rowNo` is the sheet row number (1 = first row, usually the header). */
export interface SheetRow {
  /** Worksheet name; null for CSV. */
  sheet: string | null;
  rowNo: number;
  cells: (string | null)[];
}

export interface WorkbookScan {
  kind: 'xlsx' | 'csv';
  /** Every non-empty row of every sheet, in file order. Iterate once. */
  rows: AsyncIterable<SheetRow>;
  /** sha256 and size of the bytes read; complete once `rows` is exhausted. */
  summary(): { sha256: string; sizeBytes: number };
}

export class UnreadableFileError extends Error {
  override readonly name = 'UnreadableFileError';
}

/** Streaming xlsx/csv reader over the FileStore (exceljs, approved). */
export interface SpreadsheetReader {
  open(path: string): Promise<WorkbookScan>;
}

// ---- repositories -----------------------------------------------------------------------------------------------

export interface UploadListFilter {
  status?: UploadStatus | undefined;
  sourceType?: SourceType | undefined;
  uploadedBy?: string | undefined;
  mode?: IntakeMode | undefined;
}

export interface Position {
  k: string;
  id: string;
}

export type UploadPatch = Partial<
  Omit<Upload, 'id' | 'tenantId' | 'code' | 'createdAt' | 'version' | 'counts'>
>;

export interface UploadRepository {
  insert(upload: Upload): Promise<void>;
  find(tenantId: string, idOrCode: string, options?: { forUpdate?: boolean }): Promise<Upload | undefined>;
  list(
    tenantId: string,
    filter: UploadListFilter,
    after: Position | undefined,
    limit: number,
  ): Promise<Upload[]>;
  /**
   * Applies the patch and bumps `version`. With `expectedVersion`, returns undefined when the row's version differs.
   */
  update(
    tenantId: string,
    id: string,
    patch: UploadPatch,
    expectedVersion?: number,
  ): Promise<Upload | undefined>;
  /** Adds to counters (chunk transactions). */
  addCounts(
    tenantId: string,
    id: string,
    delta: Partial<UploadCounts & { chunksDone: number; chunksFailed: number; batchesEmitted: number }>,
  ): Promise<Upload>;
  countSince(tenantId: string, uploadedBy: string, since: Date): Promise<number>;
  /** id → code for a page of review items (bounded by the page). */
  codes(tenantId: string, ids: readonly string[]): Promise<Map<string, string>>;
  findCompletedBySha(tenantId: string, sha256: string, excludeId: string): Promise<Upload | undefined>;
  nextCode(tenantId: string): Promise<string>;
  purgeDue(now: Date, limit: number): Promise<Upload[]>;
  fileCleanupDue(now: Date, limit: number): Promise<Upload[]>;
}

export interface RowErrorRecord {
  id: string;
  tenantId: string;
  uploadId: string;
  rowId: string | null;
  rowNo: number;
  sheetName: string | null;
  field: string;
  severity: 'error' | 'warning';
  code: string;
  value: string | null;
  message: string;
}

export interface RowErrorRepository {
  insertMany(rows: readonly RowErrorRecord[]): Promise<void>;
  list(
    tenantId: string,
    uploadId: string,
    filter: { field?: string | undefined; code?: string | undefined },
    after: { rowNo: number; id: string } | undefined,
    limit: number,
  ): Promise<RowErrorRecord[]>;
  /** severity=error counts per code (bounded by the code enum). */
  rejectionReasons(tenantId: string, uploadId: string): Promise<Record<string, number>>;
  /** Errors of the given rows (rejected-rows file), in row order. */
  forRows(tenantId: string, uploadId: string, rowNos: readonly number[]): Promise<RowErrorRecord[]>;
  /** Retention: deletes up to `limit` errors of an upload. */
  purge(tenantId: string, uploadId: string, limit: number): Promise<number>;
}

export type { MigrationAction, MigrationEntry };

export type ChunkStatus = 'queued' | 'leased' | 'done' | 'failed' | 'cancelled';

export interface ChunkRecord {
  id: string;
  tenantId: string;
  uploadId: string;
  chunkNo: number;
  rowFrom: number;
  rowTo: number;
  path: string;
  status: ChunkStatus;
  attempts: number;
}

export type LeaseResult =
  | { outcome: 'leased'; chunk: ChunkRecord }
  | { outcome: 'busy' }
  | { outcome: 'not-available'; status: ChunkStatus | 'missing' };

export interface ChunkRepository {
  insertMany(chunks: readonly ChunkRecord[]): Promise<void>;
  /**
   * LLD §4.3 step 1: leases the chunk when queued or its lease expired, unless the tenant already holds
   * `maxLive` live leases (semaphore). Increments attempts.
   */
  lease(
    tenantId: string,
    uploadId: string,
    chunkNo: number,
    leaseSec: number,
    maxLive: number,
  ): Promise<LeaseResult>;
  finish(
    tenantId: string,
    uploadId: string,
    chunkNo: number,
    counts: { accepted: number; rejected: number; unchanged: number; needsReview: number },
  ): Promise<void>;
  fail(tenantId: string, uploadId: string, chunkNo: number, errorCode: string): Promise<void>;
  /** Releases a lease early (transient failure) so the retry does not wait for the lease to expire. */
  release(tenantId: string, uploadId: string, chunkNo: number): Promise<void>;
  cancelQueued(tenantId: string, uploadId: string): Promise<number>;
  paths(tenantId: string, uploadId: string): Promise<string[]>;
  /** reap-chunk-leases: expired leases across tenants (bounded). */
  expiredLeases(now: Date, limit: number): Promise<ChunkRecord[]>;
}

export interface Fingerprint {
  externalRef: string;
  contentHash: string;
}

export interface FingerprintRepository {
  getMany(tenantId: string, source: string, refs: readonly string[]): Promise<Map<string, string>>;
  upsertMany(
    tenantId: string,
    source: string,
    rows: readonly { externalRef: string; contentHash: string; uploadId: string; rowId: string }[],
  ): Promise<void>;
  /** migration_map re-key (LLD §4.10): kept → rename old→new; merged/split → delete old. */
  rekey(tenantId: string, entries: readonly MigrationEntry[]): Promise<void>;
}

export interface MigrationMapRepository {
  insertMany(
    tenantId: string,
    uploadId: string,
    entries: readonly MigrationEntry[],
    newId: () => string,
  ): Promise<void>;
  list(
    tenantId: string,
    uploadId: string,
    action: MigrationAction | undefined,
    afterEntryNo: number | undefined,
    limit: number,
  ): Promise<MigrationEntry[]>;
  countByAction(tenantId: string, uploadId: string): Promise<Record<MigrationAction, number>>;
}

export interface TemplateListFilter {
  sourceType?: SourceType | undefined;
  headerFingerprint?: string | undefined;
}

export interface TemplateRepository {
  /** False when the name is taken (409 template-name-taken). */
  insert(t: Template): Promise<boolean>;
  find(tenantId: string, id: string): Promise<Template | undefined>;
  findByFingerprint(tenantId: string, fingerprint: string): Promise<Template | undefined>;
  list(
    tenantId: string,
    filter: TemplateListFilter,
    after: Position | undefined,
    limit: number,
  ): Promise<Template[]>;
  /** Replaces the editable fields; 'name-taken' on a duplicate name, undefined when missing or version differs. */
  replace(
    t: Omit<Template, 'createdBy' | 'createdAt' | 'version'>,
    expectedVersion: number | undefined,
  ): Promise<Template | 'name-taken' | undefined>;
  softDelete(tenantId: string, id: string): Promise<void>;
}

export interface VocabularyRelease {
  version: string;
  checksum: string;
  content: Record<string, unknown>;
}

export interface LegacyTermRow {
  field: string;
  termNorm: string;
  maps: Record<string, string>;
}

export interface VocabularyRepository {
  active(tenantId: string): Promise<VocabularyRelease | undefined>;
  get(tenantId: string, version: string): Promise<VocabularyRelease | undefined>;
  /** Stores a release (no-op when the version exists) with its legacy terms; activates it when `activate`. */
  save(
    tenantId: string,
    release: VocabularyRelease,
    terms: readonly LegacyTermRow[],
    activate: boolean,
    id: string,
  ): Promise<void>;
  legacyTerms(tenantId: string, version: string): Promise<LegacyTermRow[]>;
}

export interface RawRowRecord {
  id: string;
  tenantId: string;
  partitionMonth: Date;
  uploadId: string;
  chunkNo: number;
  batchNo: number | null;
  rowNo: number;
  sheetName: string | null;
  /** header → cell text as read (anonymised when the switch is on). PII. */
  original: Record<string, string | null>;
  /** IntakeRow data fields. PII. */
  normalised: Record<string, unknown>;
  externalSource: 'extractor' | 'upload';
  externalRef: string;
  parentExternalRef: string | null;
  contentHash: string;
  outcome: 'accepted' | 'rejected' | 'unchanged';
  needsReview: boolean;
  reviewReasonText: string | null;
  reasonCodes: string[];
  primaryReasonCode: string | null;
  detailCode: string | null;
  recordScope: string | null;
  side: string | null;
  market: string | null;
  segment: string | null;
  dealTypes: string[];
  propertyTypes: string[];
  usedModel: boolean;
  anonymised: boolean;
}

export interface RawRowRepository {
  /** Creates the month partition of raw_rows (split job, before any chunk writes rows). */
  ensurePartition(month: Date): Promise<void>;
  /** Idempotent insert (ON CONFLICT DO NOTHING on upload + row number). */
  insertMany(rows: readonly RawRowRecord[]): Promise<void>;
  /** Accepted rows of one emitted batch in row order (≤ 500). */
  batch(tenantId: string, uploadId: string, batchNo: number): Promise<RawRowRecord[]>;
  /** Rejected rows in row order after `afterRowNo` (finalize builds the rejected-rows file). */
  rejected(tenantId: string, uploadId: string, afterRowNo: number, limit: number): Promise<RawRowRecord[]>;
  find(tenantId: string, rowId: string): Promise<RawRowRecord | undefined>;
  /** Retention: deletes up to `limit` rows of an upload; returns how many were deleted. */
  purge(tenantId: string, uploadId: string, limit: number): Promise<number>;
}

export interface ReviewItemRecord {
  id: string;
  tenantId: string;
  uploadId: string;
  rowId: string;
  rowNo: number;
  externalRef: string;
  reasonCode: string;
  detailCode: string;
  reviewReasonText: string | null;
  current: Record<string, unknown>;
  suggested: Record<string, unknown> | null;
  context: Record<string, unknown>;
  vocabularyVersion: string;
}

export type ReviewStatus = 'open' | 'resolved' | 'skipped';

export interface ReviewItem extends ReviewItemRecord {
  status: ReviewStatus;
  resolution: { action: string; classification?: Record<string, unknown> } | null;
  note: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  version: number;
  createdAt: Date;
}

export interface ReviewListFilter {
  status: ReviewStatus;
  reasonCode?: string | undefined;
  detailCode?: string | undefined;
  uploadId?: string | undefined;
}

export interface ReviewItemRepository {
  /** ON CONFLICT (row_id) DO NOTHING; returns the ids actually inserted. */
  insertMany(items: readonly ReviewItemRecord[]): Promise<string[]>;
  find(tenantId: string, id: string, options?: { forUpdate?: boolean }): Promise<ReviewItem | undefined>;
  /** Oldest first within the filter, cursor (created_at, id). */
  list(
    tenantId: string,
    filter: ReviewListFilter,
    after: Position | undefined,
    limit: number,
  ): Promise<ReviewItem[]>;
  /** Open items per reason code (bounded by the 8 codes). */
  summary(
    tenantId: string,
    uploadId: string | undefined,
  ): Promise<{ reasonCode: string; open: number; oldestAt: Date | null }[]>;
  close(
    tenantId: string,
    id: string,
    change: {
      status: 'resolved' | 'skipped';
      resolution: Record<string, unknown> | null;
      note: string | null;
      resolvedBy: string;
    },
  ): Promise<ReviewItem>;
  /** Retention: deletes up to `limit` items of an upload. */
  purge(tenantId: string, uploadId: string, limit: number): Promise<number>;
}

/** Records' micromarket hierarchy (reference data): locality alias → canonical name. */
export interface LocalityDirectory {
  resolver(tenantId: string): Promise<(name: string) => string | undefined>;
}

export interface Repositories {
  uploads: UploadRepository;
  chunks: ChunkRepository;
  fingerprints: FingerprintRepository;
  rawRows: RawRowRepository;
  reviews: ReviewItemRepository;
  rowErrors: RowErrorRepository;
  migration: MigrationMapRepository;
  templates: TemplateRepository;
  vocabulary: VocabularyRepository;
}

// ---- transactions, events and work queues ------------------------------------------------------------------------

export interface NewEvent<T extends EventType> {
  eventType: T;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  data: EventDataMap[T];
  correlationId: string;
}

/** Transactional outbox (CLAUDE.md §3.4). */
export interface EventSink {
  emit<T extends EventType>(event: NewEvent<T>): Promise<void>;
}

export type WorkQueueName = 'q_intake_inspect' | 'q_intake_split' | 'q_intake_chunks' | 'q_intake_finalize';

/** pgmq work queues, written in the same transaction as the state change. */
export interface WorkQueue {
  send(queue: WorkQueueName, payload: Record<string, unknown>, delaySec?: number): Promise<void>;
}

export interface Tx {
  repos: Repositories;
  events: EventSink;
  queue: WorkQueue;
}

export interface UnitOfWork {
  /** Repositories outside a transaction (single-statement reads). */
  repos: Repositories;
  transaction<T>(fn: (tx: Tx) => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
}

// ---- model (ADR-0004) ----------------------------------------------------------------------------------------------

/** Raw model answer for one item (validated against the vocabulary by the domain before use). */
export interface ModelOutput {
  id?: unknown;
  recordScope?: unknown;
  dealTypes?: unknown;
  market?: unknown;
  segment?: unknown;
  propertyTypes?: unknown;
  side?: unknown;
  confidence?: unknown;
}

export class ModelUnavailableError extends Error {
  override readonly name = 'ModelUnavailableError';
}

/** Classifies REDACTED texts (never raw PII), ≤ 20 per call. Throws ModelUnavailableError. */
export interface ModelClassifier {
  classify(items: readonly { id: string; text: string }[]): Promise<ModelOutput[]>;
}
