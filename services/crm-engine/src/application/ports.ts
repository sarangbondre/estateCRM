// Ports (CLAUDE.md §3.1): what the use cases need from the outside world. Adapters implement them (src/adapters);
// the composition root wires them. Every repository is bound to one transaction by the adapter's unit of work.
import type { Hierarchy, MmSourceNode } from '../domain/micromarket.js';
import type { MatchState } from '../domain/lifecycle.js';
import type {
  BundleGrouping,
  CloseReason,
  DemandMx,
  ExclusionReason,
  FactorResult,
  IsoDate,
  MatchFlag,
  MatchStatus,
  OfferMx,
  RejectReason,
} from '../domain/types.js';
import type { Weights, WeightsBody } from '../domain/weights.js';

/** offer_mx row: the matchable projection plus per-group versions (LLD §5.2). */
export interface OfferRecord extends OfferMx {
  zone: string | null;
  priceVersion: number;
  lifeVersion: number;
  commercialVersion: number;
}

/** demand_mx row. */
export interface DemandRecord extends DemandMx {
  ownerUserId: string | null;
  factsVersion: number;
  lifeVersion: number;
  statusVersion: number;
}

export interface MatchRecord extends MatchState {
  tenantId: string;
  code: string;
  bundleId: string | null;
  rejectedReason: RejectReason | null;
  origin: 'engine' | 'user';
  confirmedBy: string | null;
  confirmedAt: Date | null;
  openDealId: string | null;
  proposalSentAt: Date | null;
  visitedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BundleRecord {
  id: string;
  tenantId: string;
  code: string;
  demandId: string;
  offerIds: string[];
  grouping: BundleGrouping;
  combinedAreaSqft: number;
  combinedPriceInr: number | null;
  combinedRentMonthlyInr: number | null;
  origin: 'engine' | 'user';
  createdBy: string | null;
  matchId: string | null;
  createdAt: Date;
}

export interface ExclusionRecord {
  demandId: string;
  offerId: string;
  reason: ExclusionReason;
  availableFrom: IsoDate | null;
  moveInBy: IsoDate | null;
  computedAt: Date;
}

export interface RunRecord {
  id: string;
  tenantId: string;
  scope: 'demand' | 'offer' | 'full';
  subjectId: string | null;
  trigger: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  candidates: number | null;
  suggested: number | null;
  closed: number | null;
  excluded: number | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface DealRecord {
  id: string;
  tenantId: string;
  demandId: string;
  offerId: string;
  status: 'open' | 'closed' | 'cancelled';
  unitsBooked: number | null;
  closedAt: Date | null;
}

export interface FeedbackRecord {
  matchId: string;
  demandId: string;
  action: 'confirmed' | 'rejected' | 'client_liked' | 'client_rejected' | 'client_visit_requested';
  source: 'staff' | 'proposal';
  reasonCode: string | null;
  score: number;
  factors: FactorResult[];
  weightsVersion: number;
  byUser: string;
  at: Date;
}

export interface WeightsRecord extends Weights {
  id: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/** Keyset position of a list page (opaque to clients: encoded by the HTTP adapter). */
export type Position = Record<string, string | number>;

export interface MatchPageQuery {
  statuses: readonly MatchStatus[];
  flag: MatchFlag | null;
  bundlesOnly: boolean;
  limit: number;
  after: Position | null;
}

/** Read models for the list endpoints (every query served by an index of migration 0002). */
export interface QueryRepository {
  /** Sorted by (Confirmed first, score desc, id); fetches limit + 1. */
  demandMatches(tenantId: string, demandId: string, q: MatchPageQuery): Promise<MatchRecord[]>;
  /** Sorted by (score desc, id); fetches limit + 1. */
  offerMatches(
    tenantId: string,
    offerId: string,
    q: Omit<MatchPageQuery, 'bundlesOnly'>,
  ): Promise<MatchRecord[]>;
  /** Sorted by (computedAt desc, id); fetches limit + 1. */
  exclusions(
    tenantId: string,
    demandId: string,
    q: { reason: string | null; limit: number; after: Position | null },
  ): Promise<(ExclusionRecord & { id: string })[]>;
  /** Sorted by (updatedAt, id); fetches limit + 1. */
  rebuild(
    tenantId: string,
    q: { updatedSince: Date | null; demandId: string | null; limit: number; after: Position | null },
  ): Promise<MatchRecord[]>;
}

export type SubjectType = 'offer' | 'demand';

export interface MxRepository {
  getOffer(tenantId: string, id: string): Promise<OfferRecord | null>;
  getOffers(tenantId: string, ids: readonly string[]): Promise<OfferRecord[]>;
  getDemand(tenantId: string, id: string): Promise<DemandRecord | null>;
  getDemands(tenantId: string, ids: readonly string[]): Promise<DemandRecord[]>;
  saveOffer(o: OfferRecord): Promise<void>;
  saveDemand(d: DemandRecord): Promise<void>;
  resolveOffer(tenantId: string, idOrCode: string): Promise<{ id: string; code: string } | null>;
  resolveDemand(tenantId: string, idOrCode: string): Promise<{ id: string; code: string } | null>;
  codesOf(
    tenantId: string,
    offerIds: readonly string[],
    demandIds: readonly string[],
  ): Promise<Map<string, string>>;
  /** Live offers overlapping the demand's cell keys (filters 4, 6, 8 prefilter), optionally price-capped. */
  offerCandidates(
    tenantId: string,
    keys: readonly string[],
    limit: number,
    priceCap?: number,
  ): Promise<OfferRecord[]>;
  /** Expired / Inactive offers overlapping the keys (exclusions), bounded. */
  unliveOfferCandidates(tenantId: string, keys: readonly string[], limit: number): Promise<OfferRecord[]>;
  /** Live demands overlapping the offer's cell keys. */
  demandCandidates(tenantId: string, keys: readonly string[], limit: number): Promise<DemandRecord[]>;
  /** Keyset over live demands (full re-score) or all rows (recompute). */
  demandIdsAfter(tenantId: string, after: string | null, limit: number, liveOnly: boolean): Promise<string[]>;
  offerIdsAfter(tenantId: string, after: string | null, limit: number): Promise<string[]>;
  /** Live demands with move_in_by ≤ date (nightly time-sensitive re-score). */
  timeSensitiveDemandIds(
    tenantId: string,
    byDate: IsoDate,
    after: string | null,
    limit: number,
  ): Promise<string[]>;
  tenants(): Promise<string[]>;
}

export interface MatchRepository {
  get(tenantId: string, idOrCode: string): Promise<MatchRecord | null>;
  getMany(tenantId: string, ids: readonly string[]): Promise<MatchRecord[]>;
  byPair(tenantId: string, demandId: string, offerSetKey: string): Promise<MatchRecord | null>;
  /** Every match of a demand (bounded). */
  listForDemand(tenantId: string, demandId: string, limit: number): Promise<MatchRecord[]>;
  /** Matches that contain an offer (bounded), optionally by status. */
  listForOffer(
    tenantId: string,
    offerId: string,
    statuses: readonly MatchStatus[] | null,
    limit: number,
  ): Promise<MatchRecord[]>;
  listClosedByDeal(tenantId: string, dealId: string, limit: number): Promise<MatchRecord[]>;
  insert(m: MatchRecord): Promise<void>;
  /** Persists the new state, bumps version and updated_at, keeps match_offers in step. */
  update(m: MatchRecord): Promise<MatchRecord>;
  nextCode(tenantId: string, prefix: 'MAT' | 'BND'): Promise<string>;
}

export interface BundleRepository {
  get(tenantId: string, idOrCode: string): Promise<BundleRecord | null>;
  getMany(tenantId: string, ids: readonly string[]): Promise<BundleRecord[]>;
  insert(b: BundleRecord): Promise<void>;
  setMatch(tenantId: string, bundleId: string, matchId: string): Promise<void>;
}

export interface ExclusionRepository {
  replaceForDemand(tenantId: string, demandId: string, rows: readonly ExclusionRecord[]): Promise<void>;
  upsertPair(tenantId: string, row: ExclusionRecord): Promise<void>;
  deletePair(tenantId: string, demandId: string, offerId: string): Promise<void>;
}

export interface RunRepository {
  create(r: RunRecord): Promise<void>;
  get(tenantId: string, id: string): Promise<RunRecord | null>;
  activeForSubject(tenantId: string, subjectId: string): Promise<RunRecord | null>;
  update(tenantId: string, id: string, patch: Partial<Omit<RunRecord, 'id' | 'tenantId'>>): Promise<void>;
}

export interface DealRepository {
  upsert(d: DealRecord): Promise<void>;
  get(tenantId: string, id: string): Promise<DealRecord | null>;
  latestClosedForOffer(tenantId: string, offerId: string): Promise<DealRecord | null>;
  latestClosedForDemand(tenantId: string, demandId: string): Promise<DealRecord | null>;
}

export interface FeedbackRepository {
  insert(tenantId: string, f: FeedbackRecord): Promise<void>;
}

export interface WeightsRepository {
  active(tenantId: string): Promise<WeightsRecord | null>;
  version(tenantId: string, version: number): Promise<WeightsRecord | null>;
  /** Creates a new active version (deactivating the previous one). */
  create(tenantId: string, body: WeightsBody, createdBy: string | null): Promise<WeightsRecord>;
}

export interface HierarchyRepository {
  /** The tenant's hierarchy, cached in memory per reference_state.mm_version. */
  load(tenantId: string): Promise<Hierarchy>;
  version(tenantId: string): Promise<number>;
  replace(tenantId: string, nodes: readonly MmSourceNode[], version: number): Promise<void>;
  requestRefresh(tenantId: string, version: number | null): Promise<void>;
  cacheVocabulary(tenantId: string, version: string, checksum: string, body: unknown): Promise<void>;
}

export interface MergeLogRepository {
  record(tenantId: string, mergeId: string, table: string, rowId: string, before: unknown): Promise<void>;
  entries(
    tenantId: string,
    mergeId: string,
    limit: number,
  ): Promise<{ table: string; rowId: string; before: unknown }[]>;
  markUndone(tenantId: string, mergeId: string): Promise<void>;
}

/** A match event to publish (written to the outbox in the same transaction, aggregate version assigned). */
export type OutgoingEvent =
  | { type: 'match.suggested.v1'; match: MatchRecord }
  | { type: 'match.confirmed.v1'; match: MatchRecord; confirmedBy: string }
  | { type: 'match.rejected.v1'; match: MatchRecord; reason: RejectReason }
  | { type: 'match.closed.v1'; match: MatchRecord; reason: CloseReason }
  | { type: 'match.flagged.v1'; match: MatchRecord; flag: MatchFlag; cleared: boolean }
  | {
      type: 'match.reopened.v1';
      match: MatchRecord;
      reason: 'deal_cancelled' | 'merge_undone' | 'offer_reactivated' | 'demand_reactivated';
    }
  | {
      type: 'demand.matching_completed.v1';
      tenantId: string;
      demandId: string;
      runId: string;
      matchCount: number;
      bundleCount: number;
    }
  | {
      type: 'audit.recorded.v1';
      tenantId: string;
      actorUserId: string;
      action: string;
      subjectId: string;
      details: Record<string, string>;
    };

export interface EventPublisher {
  publish(e: OutgoingEvent): Promise<void>;
}

export interface RescoreQueue {
  /** Marks a subject dirty (deduped); sends one work message when the subject was not already pending. */
  markDirty(
    tenantId: string,
    type: SubjectType,
    id: string,
    reason: string,
    runId?: string | null,
  ): Promise<boolean>;
  /** Claims a pending subject (deletes the dedupe row); null when another worker already handled it. */
  claim(
    tenantId: string,
    type: SubjectType,
    id: string,
  ): Promise<{ reasons: string[]; runId: string | null } | null>;
  /** Queues a job continuation (full-rescore batches, micromarket-refresh) on the work queue. */
  enqueueJob(job: string, tenantId: string | null): Promise<void>;
}

export interface JobCursorStore {
  get(
    job: string,
    runDate: IsoDate,
    tenantId: string | null,
  ): Promise<{ cursor: string | null; processed: number; done: boolean } | null>;
  save(
    job: string,
    runDate: IsoDate,
    tenantId: string | null,
    state: { cursor: string | null; processed: number; done: boolean },
  ): Promise<void>;
}

/** Everything a use case can touch inside one transaction. */
export interface Store {
  mx: MxRepository;
  matches: MatchRepository;
  bundles: BundleRepository;
  exclusions: ExclusionRepository;
  runs: RunRepository;
  deals: DealRepository;
  feedback: FeedbackRepository;
  weights: WeightsRepository;
  hierarchy: HierarchyRepository;
  mergeLog: MergeLogRepository;
  queries: QueryRepository;
  events: EventPublisher;
  rescore: RescoreQueue;
  jobs: JobCursorStore;
}

/** Runs a unit of work in one transaction (outbox writes commit with the state change). */
export interface UnitOfWork {
  run<T>(
    correlationId: string,
    fn: (store: Store) => Promise<T>,
    options?: { statementTimeoutMs?: number },
  ): Promise<T>;
}

export interface Clock {
  now(): Date;
}

/** records' micromarket reference data (R-13), read with a service token; never on a request path. */
export interface MicromarketSource {
  fetchAll(tenantId: string): Promise<MmSourceNode[]>;
}

export interface IdGenerator {
  next(): string;
}
