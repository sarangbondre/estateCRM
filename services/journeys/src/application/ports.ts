// Ports of the journeys application layer (CLAUDE.md §3.1). Adapters implement them; use cases depend only on these.
import type { EventDataMap, EventType } from '@11e/contracts/events';
import type { IsoDate } from '../domain/dates.js';
import type { OfferContent, PropertyContent, Snapshot } from '../domain/proposals.js';
import type { NewRow, TableName, Tables } from './model.js';
import type { Queries } from './queries.js';

/** R-7: automatic actions use the reserved system actor. */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

export interface UpdateOptions {
  /** Optimistic concurrency: no update (undefined) when the row version differs. */
  expectedVersion?: number;
}

/** Generic tenant-scoped row access by primary key (every table has `id` and `tenant_id`). */
export interface Rows {
  get<T extends TableName>(table: T, id: string, opts?: { forUpdate?: boolean }): Promise<Tables[T] | undefined>;
  getMany<T extends TableName>(table: T, ids: readonly string[]): Promise<Tables[T][]>;
  byCode<T extends CodedTable>(table: T, code: string): Promise<Tables[T] | undefined>;
  insert<T extends TableName>(table: T, row: NewRow<T>): Promise<Tables[T]>;
  /** Sets updated_at, and version + 1 on versioned tables. Undefined when not found or the version differs. */
  update<T extends TableName>(
    table: T,
    id: string,
    patch: Partial<Tables[T]>,
    opts?: UpdateOptions,
  ): Promise<Tables[T] | undefined>;
}
export type CodedTable = 'offer_view' | 'demand_view' | 'sourcing_requests' | 'proposals' | 'site_visits' | 'deals' | 'calls';

export interface EventSink {
  /** Outbox write in the current transaction; aggregateVersion comes from aggregate_versions (strictly increasing). */
  emit<T extends EventType>(
    type: T,
    aggregate: { type: string; id: string },
    data: EventDataMap[T],
  ): Promise<void>;
}

export type WorkMessage =
  | { kind: 'build_snapshot'; tenantId: string; proposalId: string; correlationId: string }
  | { kind: 'render_pdf'; tenantId: string; proposalId: string; correlationId: string };

export interface WorkQueue {
  /** Sent in the current transaction (pgmq is transactional). */
  send(msg: WorkMessage): Promise<void>;
}

/** Everything a use case may touch inside one transaction for one tenant. */
export interface Tx {
  readonly tenantId: string;
  readonly now: Date;
  /** IST business date of `now`. */
  readonly today: IsoDate;
  readonly correlationId: string;
  readonly rows: Rows;
  readonly q: Queries;
  readonly events: EventSink;
  readonly work: WorkQueue;
  newId(): string;
  /** Memo for per-transaction caches (settings). */
  readonly memo: Map<string, unknown>;
}

export interface TxMeta {
  correlationId: string;
  /** Statement timeout for the transaction (default 2 s; jobs use more). */
  statementTimeoutMs?: number;
}

export interface TxRunner {
  run<T>(tenantId: string, meta: TxMeta, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Distinct tenants that have rows in a table-driven job's due index (loose index scan). */
  tenants(): Promise<string[]>;
}

export interface Clock {
  now(): Date;
}

/** Records' existing GET endpoints (R-2 service token): proposal content. */
export interface ProposalContentPort {
  offer(tenantId: string, offerId: string): Promise<OfferContent | null>;
  property(tenantId: string, propertyId: string): Promise<PropertyContent | null>;
  photos(tenantId: string, propertyId: string): Promise<{ id: string; url: string | null; caption: string | null }[]>;
}

/** listings GET /v1/publication-settings (R-2 service token): the 11 Estates MahaRERA agent number. */
export interface PublicationSettingsPort {
  mahareraAgentNumber(tenantId: string): Promise<string | null>;
}

export interface FileStoragePort {
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Copies a remote file (e.g. a records photo signed URL) into the bucket. */
  copyFromUrl(url: string, path: string): Promise<void>;
  signedUrl(path: string, expiresInSec: number): Promise<string>;
  /** Batch signing (one round trip); same order as `paths`. */
  signedUrls(paths: readonly string[], expiresInSec: number): Promise<string[]>;
  remove(paths: readonly string[]): Promise<void>;
}

export interface PdfInput {
  code: string;
  generatedAt: Date;
  snapshot: Snapshot;
  /** Signed photo URLs per option position (short-lived). */
  photoUrls: Record<number, string[]>;
}

export interface PdfRendererPort {
  render(input: PdfInput): Promise<Uint8Array>;
}

export interface TokenPort {
  /** 32 random bytes, base64url (43 chars). */
  newToken(): string;
  hash(token: string): Buffer;
  /** Salted hash of an IP address (salt rotated monthly). */
  ipHash(ip: string, at: Date): Buffer;
}

/** Outbound dependencies, grouped for the composition root. */
export interface Integrations {
  content: ProposalContentPort;
  publication: PublicationSettingsPort;
  storage: FileStoragePort;
  pdf: PdfRendererPort;
  tokens: TokenPort;
  /** Base URL of web's public proposal route (https://<web>/p/{token}). */
  publicBaseUrl: string;
}
