// Ports of the insight application layer (LLD §2). Adapters implement them; use cases depend only on these.
import type { DemandDims, FactDims, OfferDims } from '../domain/readmodel/rollupKeys.js';
import type { DayRange } from '../domain/dates.js';
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
