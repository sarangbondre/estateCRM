// Ports the use cases depend on (intake LLD §2). Adapters implement them; src/main.ts wires them (CLAUDE.md §3.1).
import type { EventDataMap, EventType } from '@11e/contracts/events';
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
}

export type MigrationAction = 'kept' | 'merged' | 'split';

export interface MigrationEntry {
  entryNo: number;
  oldRef: string;
  newRefs: string[];
  action: MigrationAction;
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

export interface Repositories {
  uploads: UploadRepository;
  rowErrors: RowErrorRepository;
  migration: MigrationMapRepository;
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
