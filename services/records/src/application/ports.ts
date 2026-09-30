// Ports: what the use cases need from the outside world. Adapters implement them; src/main.ts wires them.
import type { EventDataMap, EventType } from '@11e/contracts/events';
import type { Tables } from './model.js';
import type { Queries } from './queries.js';

export type TableName = keyof Tables;
/** Tables with an `id` primary key. */
export type IdTable = {
  [K in TableName]: Tables[K] extends { id: string } ? K : never;
}[TableName];
/** Tables with a per-tenant display code. */
export type CodedTable = {
  [K in TableName]: Tables[K] extends { code: string } ? K : never;
}[TableName];

type Defaulted = 'tenant_id' | 'created_at' | 'updated_at';
/** A row to insert: every column except the tenant (set by the store) and timestamps (defaults). */
export type NewRow<T extends TableName> = Omit<Tables[T], Defaulted> &
  Partial<Pick<Tables[T], Extract<keyof Tables[T], Defaulted>>>;

export interface FindOptions<T extends TableName> {
  /** Hard cap; stores never return more than 1,000 rows. */
  limit?: number;
  lock?: boolean;
  orderBy?: { column: keyof Tables[T] & string; direction?: 'asc' | 'desc' }[];
}

/**
 * Tenant-scoped row access inside one transaction. Every call filters on the transaction's tenant; callers only use
 * indexed columns in `where`.
 */
export interface Store {
  insert<T extends TableName>(table: T, rows: NewRow<T> | readonly NewRow<T>[]): Promise<void>;
  /** Insert unless a unique constraint says the row exists; returns whether it was inserted. */
  insertIgnore<T extends TableName>(table: T, row: NewRow<T>): Promise<boolean>;
  /** Updates by id; sets updated_at where the table has it. */
  update<T extends IdTable>(table: T, id: string, patch: Partial<Tables[T]>): Promise<void>;
  updateWhere<T extends TableName>(table: T, where: Partial<Tables[T]>, patch: Partial<Tables[T]>): Promise<number>;
  get<T extends IdTable>(table: T, id: string, options?: { lock?: boolean }): Promise<Tables[T] | undefined>;
  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Tables[T][]>;
  getByCode<T extends CodedTable>(table: T, code: string, options?: { lock?: boolean }): Promise<Tables[T] | undefined>;
  find<T extends TableName>(table: T, where: Partial<Tables[T]>, options?: FindOptions<T>): Promise<Tables[T][]>;
  /** `column = ANY(values)` (+ equality `where`), capped at 1,000 rows. */
  findIn<T extends TableName, C extends keyof Tables[T] & string>(
    table: T,
    column: C,
    values: readonly unknown[],
    where?: Partial<Tables[T]>,
  ): Promise<Tables[T][]>;
  delete<T extends TableName>(table: T, where: Partial<Tables[T]>): Promise<number>;
  /** Batch jobs: rows with id > afterId in id order (bounded by limit ≤ 1,000). */
  scan<T extends IdTable>(table: T, afterId: string | null, limit: number, where?: Partial<Tables[T]>): Promise<Tables[T][]>;
  count<T extends TableName>(table: T, where: Partial<Tables[T]>): Promise<number>;
}

/** Issues display codes from code_sequences (row lock per prefix; a block for batches). */
export interface CodeIssuer {
  next(prefix: string, pad: number): Promise<string>;
  /** Reserves n codes at once (ingestion batches). */
  block(prefix: string, pad: number, n: number): Promise<string[]>;
}

export interface EmitOptions {
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
}

/** Transactional outbox (CLAUDE.md §3.4): events are written in the same transaction as the change. */
export interface EventSink {
  emit<T extends EventType>(type: T, aggregate: EmitOptions, data: EventDataMap[T]): Promise<void>;
}

export interface Tx {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly now: Date;
  readonly store: Store;
  readonly q: Queries;
  readonly codes: CodeIssuer;
  readonly events: EventSink;
  /** Transaction-scoped advisory lock (ingestion of one upload's migration map). */
  advisoryLock(key: string): Promise<void>;
  /** Sends to a private work queue (q_records_photo_fetch) in this transaction. */
  enqueueWork(queue: string, message: Record<string, unknown>): Promise<void>;
}

export interface UnitOfWorkOptions {
  /** Statement timeout inside the transaction. Default 2,000 ms (sync API budget). */
  timeoutMs?: number;
}

export interface UnitOfWork {
  run<T>(ctx: { tenantId: string; correlationId: string }, fn: (tx: Tx) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

export interface Clock {
  now(): Date;
}

/** UUIDv7 generator (time-ordered ids, conventions §2). */
export interface IdGenerator {
  next(): string;
}

/** Keyed hashes (HMAC-SHA256 with records secrets): lookups by hash, never by plaintext. */
export interface KeyedHash {
  phone(tenantId: string, e164: string): string;
  email(tenantId: string, email: string): string;
  /** Opaque building identity carried in offer facts (`buildingKey`). */
  building(tenantId: string, buildingNorm: string, micromarketKey: string): string;
  /** Scan-term hash shared with listings (R-20). */
  scanTerm(token: string): string;
  readonly scanSaltVersion: number;
}

/** Contact redaction of free text (desk item descriptions served redacted). */
export interface Redactor {
  redact(text: string): string;
}

// --- intake (R-2, REC-05) ------------------------------------------------------------------------------------

/** One normalised row of intake's `IntakeRowBatch` (intake.yaml IntakeRow). Contains PII. */
export interface IntakeRow {
  rowId: string;
  rowNo: number;
  externalSource: 'extractor' | 'upload';
  externalRef: string;
  parentExternalRef?: string | null;
  splitIndex?: string | null;
  contentHash: string;
  routeTo?: string | null;
  needsReview: boolean;
  reviewReason?: string | null;
  reviewReasonCode?: string | null;
  recordScope?: string | null;
  dealTypes?: string[];
  market?: string | null;
  segment?: string | null;
  propertyTypes?: string[];
  propertyDetail?: string | null;
  /** CR-012: private (dedup and proposals only; never in events or public). */
  buildingName?: string | null;
  /** CR-012: PII-sensitive floor text; stored as floor_no/total_floors. */
  floor?: string | null;
  /** CR-012: the row carried crm_notes (journeys fetches the text from intake). */
  hasCrmNotes?: boolean;
  landUse?: string | null;
  side?: 'Supply' | 'Demand' | 'None' | null;
  sideEvidence?: string | null;
  saleMode?: string | null;
  deadlineDate?: string | null;
  tenancyStatus?: string | null;
  tenure?: string | null;
  agreementForm?: string | null;
  isJodi?: boolean | null;
  possessionStatus?: string | null;
  possessionDate?: string | null;
  furnishing?: string | null;
  sector?: string | null;
  includesProperty?: string | null;
  businessDescription?: string | null;
  participantRole?: string | null;
  signalType?: string | null;
  projectName?: string | null;
  developerName?: string | null;
  bhkMin?: number | null;
  bhkMax?: number | null;
  features?: string | null;
  locality?: string | null;
  city?: string | null;
  state?: string | null;
  landmark?: string | null;
  locationText?: string | null;
  areaSqftMin?: number | null;
  areaSqftMax?: number | null;
  areaBasis?: string | null;
  landAreaValue?: number | null;
  landAreaUnit?: string | null;
  landAreaSqft?: number | null;
  areaText?: string | null;
  priceText?: string | null;
  salePriceInrMin?: number | null;
  salePriceInrMax?: number | null;
  saleRateInr?: number | null;
  saleRateUnit?: string | null;
  priceNegotiable?: boolean | null;
  rentMonthlyInrMin?: number | null;
  rentMonthlyInrMax?: number | null;
  rentRatePsf?: number | null;
  depositInr?: number | null;
  depositMonths?: number | null;
  currentRentInr?: number | null;
  yieldPct?: number | null;
  contactName?: string | null;
  companyName?: string | null;
  partyType?: string | null;
  phones?: string[];
  whatsappPhone?: string | null;
  emails?: string[];
  reraNumber?: string | null;
  otherContact?: string | null;
  sourceChannel?: string | null;
  sourceName?: string | null;
  sourceEdition?: string | null;
  sourceSupplement?: string | null;
  sourceDate?: string | null;
  sourcePage?: number | null;
  sourceFiles?: string | null;
  firstSeenDate?: string | null;
  lastSeenDate?: string | null;
  timesSeen?: number | null;
  possibleRepeatOf?: string | null;
  rawText?: string | null;
  sourceLanguage?: string | null;
  ocrUsed?: boolean | null;
  extractionConfidence?: number | null;
  extractorNotes?: string | null;
  senderName?: string | null;
  senderPhone?: string | null;
  textVariants?: string | null;
  crmNotes?: string | null;
  sourceType: 'Channel' | 'Digi' | 'Direct';
  captureMode: 'uploaded';
  campaignRef?: string | null;
  formRef?: string | null;
  listingRef?: string | null;
  projectRef?: string | null;
  enquiryMessage?: string | null;
  enquiryReceivedAt?: string | null;
  photoUrls?: string[];
  anonymised: boolean;
}

export interface IntakeRowBatch {
  uploadId: string;
  batchNo: number;
  anonymised: boolean;
  vocabularyVersion: string;
  rows: IntakeRow[];
}

export interface MigrationMapEntry {
  entryNo: number;
  oldRef: string;
  newRefs: string[];
  action: 'kept' | 'merged' | 'split';
}

export class BatchNotFoundError extends Error {
  override readonly name = 'BatchNotFoundError';
}

/** intake `GET /internal/v1/uploads/{id}/rows|migration-map` with a service token (R-2). */
export interface IntakeRowsClient {
  /** Throws BatchNotFoundError on 404 batch-not-found (the message then goes to the DLQ). */
  batch(tenantId: string, uploadId: string, batchNo: number, correlationId: string): Promise<IntakeRowBatch>;
  migrationMap(
    tenantId: string,
    uploadId: string,
    cursor: string | null,
    correlationId: string,
  ): Promise<{ items: MigrationMapEntry[]; nextCursor: string | null }>;
}

// --- photos (REC-09) -----------------------------------------------------------------------------------------

export interface StoredObject {
  sizeBytes: number;
  /** First bytes (≥ 64 KiB or the whole file) for magic-byte and dimension checks. */
  head: Uint8Array;
  sha256: string;
}

/** Private photo bucket (records-photos): signed URLs, verification and deletion. */
export interface PhotoStore {
  signedUploadUrl(path: string, contentType: string, expiresInSec: number): Promise<string>;
  signedReadUrl(path: string, expiresInSec: number): Promise<string>;
  /** Undefined when nothing was uploaded at `path`. */
  inspect(path: string): Promise<StoredObject | undefined>;
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Sheet-link photo download (5 concurrent per host, 2 s, 10 MB cap). */
export interface ImageFetcher {
  fetch(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}
