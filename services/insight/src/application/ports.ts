// Ports of the insight application layer (LLD §2). Adapters implement them; use cases depend only on these.
import type { DemandDims, FactDims, OfferDims } from '../domain/readmodel/rollupKeys.js';
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
