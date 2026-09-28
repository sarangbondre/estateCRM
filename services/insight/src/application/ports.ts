// Ports of the insight application layer (LLD §2). Adapters implement them; use cases depend only on these.
import type { DemandDims, FactDims, OfferDims } from '../domain/readmodel/rollupKeys.js';
import type { ResolvedSubject } from '../domain/cards/cardBuilder.js';
import type { ChatMessage } from '../domain/chat/prompt.js';
import type { DayRange } from '../domain/dates.js';
import type { QueryPlan } from '../domain/plans/types.js';
import type { LocationIndex, ValidatedPlan, VocabularyView } from '../domain/plans/validator.js';
import type { RmTable, RmTables } from '../domain/readmodel/rows.js';

export interface Clock {
  now(): Date;
}

/** Read-model writes inside the projector transaction (one per event, together with processed_events). */
export interface ReadModelStore {
  readonly tenantId: string;
  get<T extends RmTable>(table: T, id: string): Promise<RmTables[T] | undefined>;
  getMany<T extends RmTable>(table: T, ids: readonly string[]): Promise<RmTables[T][]>;
  /** Inserts the row (column defaults for everything not in the patch) or updates only the patched columns. */
  upsert<T extends RmTable>(table: T, id: string, patch: Partial<RmTables[T]>): Promise<void>;
  /** Offers of a property (photos are per property). Bounded: a property has a handful of offers. */
  offerIdsOfProperty(propertyId: string): Promise<string[]>;
  /** The last applied aggregateVersion of a stream, or null. */
  version(aggregateId: string, stream: string): Promise<number | null>;
  setVersion(aggregateId: string, stream: string, version: number): Promise<void>;
  offerRollup(dims: OfferDims, delta: number): Promise<void>;
  demandRollup(dims: DemandDims, delta: number): Promise<void>;
  fact(day: string, metric: string, dims: FactDims, delta: number): Promise<void>;
  queueCounts(userId: string, counts: Record<string, number>): Promise<void>;
  user(userId: string, role: string, active: boolean): Promise<void>;
  /** Advances rm_state.last_event_at ("data as of") and the lag. */
  applied(occurredAt: Date, now: Date): Promise<void>;
  /** vocabulary.released / micromarkets.updated: the vocabulary-refresh job fetches the new reference data. */
  requestReferenceRefresh(reason: string): Promise<void>;
}

// ------------------------------------------------------------------------------------------ queries (INS-03)

export interface ExecOptions {
  now: Date;
  limit?: number;
  cursor?: string | null;
  /** Lists: also run the capped count ("Here are 25 of 132"). */
  withTotal?: boolean;
  /** Exports: page size beyond the template's maxRows (5,000). */
  pageSize?: number;
  /** Exports with contacts: also return `_contact_ids` (pseudonymous person ids) for offers and demands. */
  withContactIds?: boolean;
}

export interface ExecResult {
  /** Rows keyed by output column (lists also carry _id, _sort and label inputs _deal_type/_market/_segment). */
  rows: Record<string, unknown>[];
  /** Capped count (lists with withTotal, counts); null when not computed. */
  total: number | null;
  /** True when the count reached the cap (shown as "10,000+"). */
  capped: boolean;
  nextCursor: string | null;
}

export interface QueryExecutor {
  execute(tenantId: string, plan: ValidatedPlan, options: ExecOptions): Promise<ExecResult>;
}

/** Active vocabulary release and the micromarket hierarchy (cached; refreshed by vocabulary-refresh). */
export interface ReferenceData {
  vocabulary(tenantId: string): Promise<VocabularyView>;
  locations(tenantId: string): Promise<LocationIndex>;
}

export interface ReadModelInfo {
  /** rm_state.last_event_at ("data as of"). */
  dataAsOf(tenantId: string): Promise<Date | null>;
}

// ------------------------------------------------------------------------------------------ dashboards (INS-02)

/** Dashboard filters on rollup / fact dimensions (stored fields only). */
export interface DimFilter {
  segment?: string;
  dealType?: string;
  market?: string;
  propertyType?: string;
  micromarket?: string;
  ownerUserId?: string;
  saleMode?: string;
  tenancyStatus?: string;
}

export type CountRow = { key: string | null; n: number };

export interface DashboardReader {
  /** SUM(n) of rm_offer_rollup grouped by the given dimension columns. */
  offerRollup(tenantId: string, f: DimFilter, by: readonly string[], statuses?: readonly string[]): Promise<(Record<string, string | null> & { n: number })[]>;
  /** SUM(n) of rm_demand_rollup (open demand: no exit, not Closed) grouped by the given columns. */
  demandRollup(tenantId: string, f: DimFilter, by: readonly string[]): Promise<(Record<string, string | null> & { n: number })[]>;
  /** SUM(n) of rm_daily_fact for metrics over an IST day range, grouped by one dimension (or the metric). */
  facts(tenantId: string, metrics: readonly string[], range: DayRange, f: DimFilter, by: 'metric' | 'source_type' | 'reason' | 'owner_user_id'): Promise<CountRow[]>;
  /** Queue counts per section summed over the team (or one user). */
  queueCounts(tenantId: string, userId?: string): Promise<Record<string, number>>;
  openSourcingRequests(tenantId: string): Promise<number>;
  siteVisitsScheduled(tenantId: string, range: DayRange): Promise<number>;
  followUpsDue(tenantId: string, today: string, ownerUserId?: string): Promise<number>;
  stock(tenantId: string): Promise<{ properties: number | null; projects: number }>;
  deskItems(tenantId: string): Promise<{ record_scope: string | null; side: string | null; sector: string | null; participant_role: string | null; with_property: boolean; n: number }[]>;
  watchlist(tenantId: string, today: string, horizon: string): Promise<{ bySignal: CountRow[]; deadlinesSoon: number; openTasks: number }>;
  uploads(tenantId: string, range: DayRange): Promise<{
    bySource: { source: string | null; uploads: number; accepted: number; rejected: number; needsReview: number; lastStartedAt: Date | null }[];
    rejectionReasons: CountRow[];
    possibleRepeats: number;
  }>;
  reviewOpenByReason(tenantId: string): Promise<CountRow[]>;
  mergeCandidates(tenantId: string, range: DayRange): Promise<CountRow[]>;
  sideDefaulted(tenantId: string, range: DayRange): Promise<CountRow[]>;
}

// ------------------------------------------------------------------------------------------ chat (INS-04)

export interface PlannerRequest {
  tenantId: string;
  messages: ChatMessage[];
}

export type PlannerResult =
  | { ok: true; text: string; model: string; inputTokens: number; outputTokens: number }
  | { ok: false; reason: 'not_configured' | 'timeout' | 'error' | 'credits' | 'rate_limited' | 'circuit_open' | 'busy' };

/** The Hugging Face planner (ADR-0004). Sees only redacted text, the catalogue and the vocabulary. */
export interface Planner {
  readonly model: string | null;
  plan(request: PlannerRequest): Promise<PlannerResult>;
}

/** hf_usage counters and the "credits exhausted" flag (LLD §4.2). */
export interface UsageMeter {
  creditsExhausted(tenantId: string, now: Date): Promise<boolean>;
  record(tenantId: string, now: Date, result: PlannerResult): Promise<void>;
  resetCredits(now: Date): Promise<number>;
}

export interface Redaction {
  text: string;
  counts: Record<string, number>;
  /** placeholder → original. Request memory only: never stored, logged or sent. */
  mapping: ReadonlyMap<string, string>;
}

export interface Redactor {
  redact(text: string, allowTerms: Iterable<string>): Redaction;
  restore(text: string, mapping: ReadonlyMap<string, string>): string;
}

export interface ConversationRow {
  id: string;
  code: string;
  userId: string;
  title: string;
  messageCount: number;
  lastMessageAt: Date;
  createdAt: Date;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: unknown[];
  howIGotThis: unknown;
  outcome: string | null;
  fallbackUsed: boolean;
  model: string | null;
  timings: Record<string, number> | null;
  createdAt: Date;
}

export interface NewMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  redactionCounts?: Record<string, number>;
  plan?: unknown;
  howIGotThis?: unknown;
  cards?: unknown[];
  outcome?: string;
  fallbackUsed?: boolean;
  model?: string | null;
  timings?: Record<string, number>;
  idempotencyKey?: string | null;
}

export interface ConversationRepo {
  create(tenantId: string, userId: string, title: string, now: Date): Promise<ConversationRow>;
  /** By id or CONV- code; soft-deleted conversations only with includeDeleted (then `deleted` is set). */
  find(tenantId: string, idOrCode: string, includeDeleted?: boolean): Promise<(ConversationRow & { deleted?: boolean }) | null>;
  list(tenantId: string, userId: string, limit: number, after: { k: string; id: string } | undefined): Promise<ConversationRow[]>;
  softDelete(tenantId: string, id: string, now: Date): Promise<void>;
  history(tenantId: string, conversationId: string, turns: number): Promise<{ role: 'user' | 'assistant'; text: string }[]>;
  messages(tenantId: string, conversationId: string, limit: number, after: { k: string; id: string } | undefined): Promise<StoredMessage[]>;
  message(tenantId: string, id: string): Promise<StoredMessage | null>;
  /** User + assistant message in one transaction; counts, last_message_at and the default title. */
  saveExchange(tenantId: string, conversationId: string, messages: NewMessage[], titleIfDefault: string, now: Date): Promise<void>;
  /** conversation-purge: soft-deleted conversations and those idle past the retention (bounded batch). */
  purge(now: Date, retentionDays: number, batch: number): Promise<number>;
}

export interface CodeLookup {
  resolve(tenantId: string, codes: readonly string[]): Promise<Map<string, ResolvedSubject | null>>;
}

export interface Ids {
  uuid(): string;
}

// ------------------------------------------------------------------------------------------ exports (INS-05)

export type ExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';

export interface ExportJob {
  id: string;
  code: string;
  requestedBy: string;
  requesterRole: string;
  plan: QueryPlan;
  includeContacts: boolean;
  fileName: string;
  status: ExportStatus;
  estimatedRows: number | null;
  rowCount: number | null;
  filePath: string | null;
  fileBytes: number | null;
  sourceMessageId: string | null;
  attempts: number;
  errorCode: string | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ExportRepo {
  countSince(tenantId: string, userId: string, since: Date): Promise<number>;
  /** Inserts the job (queued) and enqueues it on q_insight_exports in one transaction. */
  create(tenantId: string, job: Omit<ExportJob, 'code' | 'createdAt' | 'fileName'>, fileNameOf: (code: string) => string, now: Date): Promise<ExportJob>;
  get(tenantId: string, idOrCode: string): Promise<ExportJob | null>;
  list(tenantId: string, userId: string | null, status: ExportStatus | undefined, limit: number, after: { k: string; id: string } | undefined): Promise<ExportJob[]>;
  /** queued/running → running, attempts + 1; null when already finished (duplicate delivery). */
  claim(tenantId: string, id: string, now: Date): Promise<ExportJob | null>;
  /** completed + export.completed.v1 + audit.recorded.v1 (outbox), one transaction. */
  complete(tenantId: string, job: ExportJob, r: { rowCount: number; filePath: string; fileBytes: number; now: Date; expiresAt: Date; via: 'ui' | 'chat'; correlationId: string }): Promise<void>;
  /** failed + export.failed.v1 (outbox), one transaction. */
  fail(tenantId: string, job: ExportJob, errorCode: string, now: Date, correlationId: string): Promise<void>;
  expiring(now: Date, limit: number): Promise<{ tenantId: string; id: string; filePath: string | null }[]>;
  markExpired(tenantId: string, id: string, now: Date): Promise<void>;
}

export interface FileStore {
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  signedUrl(path: string, expiresInSec: number): Promise<string>;
  remove(paths: readonly string[]): Promise<void>;
}

export interface Contact {
  name: string | null;
  phones: string[];
  emails: string[];
}

/** records POST /internal/v1/contacts:batch (service token, ≤ 1,000 ids, audited by records, R-21). */
export interface ContactsReader {
  batch(tenantId: string, personIds: readonly string[], exportId: string, requestedBy: string): Promise<Map<string, Contact>>;
}

export interface SheetColumn {
  key: string;
  label: string;
  type: string;
}

/** Streaming .xlsx writer: consumes pages of rows, returns the file. */
export interface SpreadsheetWriter {
  write(sheetName: string, columns: readonly SheetColumn[], pages: AsyncIterable<Record<string, unknown>[]>): Promise<Uint8Array>;
}

export interface VocabularyReleaseDoc {
  version: string;
  checksum?: string;
  fields: Record<string, { values: string[] }>;
}

export interface MicromarketNode {
  id: string;
  parentId: string | null;
  level: string;
  name: string;
  aliases: string[];
  city: string | null;
  inLaunchArea: boolean;
  treeVersion: number | null;
}

/** records reference data over a service token (R-2). */
export interface RecordsReference {
  /** False when this deployment has no service credential (local development): reference data stays as is. */
  readonly available: boolean;
  vocabulary(tenantId: string): Promise<VocabularyReleaseDoc>;
  micromarkets(tenantId: string): Promise<MicromarketNode[]>;
}

export interface ReferenceStore {
  /** Tenants whose reference data must be fetched (vocabulary.released / micromarkets.updated, or never fetched). */
  pendingTenants(limit: number): Promise<string[]>;
  saveVocabulary(tenantId: string, doc: VocabularyReleaseDoc): Promise<void>;
  replaceMicromarkets(tenantId: string, nodes: MicromarketNode[]): Promise<void>;
  markRefreshed(tenantId: string): Promise<void>;
}

export interface CatalogueRepo {
  /** Plan ids a tenant has disabled (tenant rows of plan_template with enabled = false). */
  disabled(tenantId: string): Promise<ReadonlySet<string>>;
}
