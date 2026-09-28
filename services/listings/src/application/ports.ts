// Ports of the listings application layer (LLD §2). Adapters implement them; use cases depend only on these.
import type {
  ChangeReason,
  DemandFacts,
  Level,
  OfferFacts,
  PhotoInfo,
  ProjectFacts,
  Publication,
  PublicationSettings,
  PublicSubjectType,
  SubjectType,
} from '../domain/types.js';
import type { ChangeType } from '../domain/levels.js';
import type { Finding } from '../domain/privacy.js';

export interface Clock {
  now(): Date;
}

export interface Random {
  bytes(n: number): Uint8Array;
  uuid(): string;
}

/** Stored public projection row (public_item). */
export interface PublicItemRow {
  id: string;
  publicId: string;
  subjectType: PublicSubjectType;
  level: Exclude<Level, 'Private'>;
  payload: Record<string, unknown>;
  payloadHash: string;
  publishedAt: Date;
  priceSortInr: number | null;
}

export interface PublicItemWrite extends Omit<PublicItemRow, 'publishedAt' | 'priceSortInr'> {
  publishedAt: Date;
  filters: {
    dealType: string | null;
    dealTypes: string[] | null;
    market: string | null;
    segment: string | null;
    city: string | null;
    micromarket: string | null;
    locality: string | null;
    micromarketPath: string[];
    propertyTypes: string[];
    bhkMin: number | null;
    bhkMax: number | null;
    areaSqftMin: number | null;
    areaSqftMax: number | null;
    salePriceInrMin: number | null;
    rentMonthlyInrMin: number | null;
    priceSortInr: number | null;
    possessionSort: string | null;
    saleMode: string | null;
    tenancyStatus: string | null;
    furnishing: string | null;
    projectPublicId: string | null;
  };
}

export interface ScanRecord {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  textSha256: string;
  rulesVersion: string;
  result: 'pass' | 'warning' | 'blocked';
  findings: Finding[];
  scannedBy: string;
  createdAt: Date;
}

export interface PrivateTermRow {
  propertyId: string;
  kind: 'building' | 'society' | 'wing' | 'unit';
  tokenHash: string;
  ngram: number;
  saltKeyId: string;
}

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  keyHash: string;
  status: 'active' | 'rotating' | 'revoked';
  rateLimitRps: number;
  burst: number;
  allowedOrigins: string[];
  graceEndsAt: Date | null;
  replacedByKeyId: string | null;
  lastUsedAt: Date | null;
  createdBy: string;
  revokedAt: Date | null;
  version: number;
  createdAt: Date;
}

export interface MergeLogEntry {
  mergeId: string;
  subjectType: SubjectType;
  subjectId: string;
  prior: { level: Level; publicId: string | null };
}

export interface AuditEntry {
  action: string;
  actorUserId: string;
  subjectType: string;
  subjectId: string;
  via: 'ui' | 'chat' | 'system';
  details: Record<string, string>;
}

export interface PublicationChange {
  publication: Publication;
  from: Level;
  to: Level;
  reason: ChangeReason;
}

/** Work items on the private queue q_listings_photos (slow work, CLAUDE.md §3.5). */
export type WorkItem =
  | { kind: 'photo-process'; tenantId: string; photoId: string }
  | { kind: 'photo-publish'; tenantId: string; photoId: string }
  | { kind: 'photo-unpublish'; tenantId: string; photoId: string }
  | { kind: 'scan-terms'; tenantId: string; propertyId: string }
  | { kind: 'micromarkets'; tenantId: string }
  | { kind: 'projection-refresh'; tenantId: string; after?: string | null };

/** Paging over a keyset (sort key, id). */
export interface PageRequest<C> {
  limit: number;
  after?: C | undefined;
}

export interface PublicationListFilter {
  subjectType?: SubjectType | undefined;
  level?: Level | undefined;
  lifeStage?: string | undefined;
  ceilingBelowLevel?: boolean | undefined;
}

export interface PublicationSummaryRow {
  publication: Publication;
  code: string;
  label: string | null;
}

export interface PublicListFilter {
  subjectType: PublicSubjectType;
  dealType?: string | undefined;
  market?: string | undefined;
  segment?: string | undefined;
  propertyType?: string | undefined;
  city?: string | undefined;
  micromarket?: string | undefined;
  locality?: string | undefined;
  bhkMin?: number | undefined;
  bhkMax?: number | undefined;
  areaSqftMin?: number | undefined;
  areaSqftMax?: number | undefined;
  salePriceInrMax?: number | undefined;
  rentMonthlyInrMax?: number | undefined;
  priceInrMax?: number | undefined;
  possessionBy?: string | undefined;
  saleMode?: string | undefined;
  tenancyStatus?: string | undefined;
  furnishing?: string | undefined;
  level?: 'Anonymous' | 'Public' | undefined;
  projectPublicId?: string | undefined;
  sort: 'newest' | 'priceAsc' | 'priceDesc';
}

/** Keyset position: newest → (publishedAt, id); price sorts → (price, id) with nulls last. */
export interface PublicCursor {
  t: string;
  id: string;
  p?: string | null;
}

export interface ChangeRow {
  seq: number;
  publicId: string;
  subjectType: PublicSubjectType;
  changeType: ChangeType;
  level: 'Anonymous' | 'Public' | null;
  occurredAt: Date;
}

/**
 * Transaction-bound repository for one tenant. Every method runs inside the caller's transaction, so state changes,
 * projections, change-feed rows and outbox events commit together (CLAUDE.md §3.4).
 */
export interface Store {
  readonly tenantId: string;
  readonly correlationId: string;

  // inputs
  getOffer(id: string): Promise<OfferFacts | undefined>;
  findOfferId(idOrCode: string): Promise<string | undefined>;
  saveOffer(facts: OfferFacts): Promise<void>;
  offersOfProperty(propertyId: string, limit: number): Promise<string[]>;
  offersOfProject(projectId: string, limit: number): Promise<string[]>;
  markScanTermsFetched(propertyId: string, at: Date): Promise<void>;

  getProject(id: string): Promise<ProjectFacts | undefined>;
  findProjectId(idOrCode: string): Promise<string | undefined>;
  saveProject(facts: ProjectFacts): Promise<void>;
  projectsOfOffer(offerId: string, limit: number): Promise<string[]>;

  getDemand(id: string): Promise<DemandFacts | undefined>;
  findDemandId(idOrCode: string): Promise<string | undefined>;
  saveDemand(facts: DemandFacts): Promise<void>;

  // publication
  getPublication(
    subjectType: SubjectType,
    subjectId: string,
    forUpdate?: boolean,
  ): Promise<Publication | undefined>;
  insertPublication(p: Publication): Promise<void>;
  updatePublication(p: Publication): Promise<void>;
  publicIdTaken(publicId: string): Promise<boolean>;
  listPublications(
    filter: PublicationListFilter,
    page: PageRequest<{ t: string; id: string }>,
  ): Promise<PublicationSummaryRow[]>;

  // settings
  getSettings(): Promise<PublicationSettings | undefined>;
  saveSettings(s: PublicationSettings, isNew: boolean): Promise<void>;

  // public projection + change feed
  getPublicItem(id: string): Promise<PublicItemRow | undefined>;
  upsertPublicItem(item: PublicItemWrite): Promise<void>;
  deletePublicItem(id: string): Promise<void>;
  appendChange(entry: {
    publicId: string;
    subjectType: PublicSubjectType;
    changeType: ChangeType;
    level: 'Anonymous' | 'Public' | null;
    occurredAt: Date;
  }): Promise<void>;
  micromarketAncestors(): Promise<Record<string, string[]>>;
  saveMicromarkets(ancestors: Record<string, string[]>): Promise<void>;
  saveVocabularyRelease(version: string, checksum: string): Promise<void>;
  /** Publications of this tenant by id (projection refresh batches). */
  publicationsAfter(
    afterId: string | null,
    limit: number,
  ): Promise<{ subjectType: SubjectType; subjectId: string; id: string }[]>;

  // photos
  getPhoto(id: string): Promise<PhotoInfo | undefined>;
  photosByIds(ids: readonly string[]): Promise<PhotoInfo[]>;
  photosOfProperty(propertyId: string, limit: number): Promise<PhotoInfo[]>;
  savePhotoAdded(p: {
    id: string;
    propertyId: string;
    origin: string;
    isReal: boolean;
    sourceStoragePath: string;
    hasTextDetected: boolean | null;
  }): Promise<boolean>;
  markPhotoRemoved(id: string): Promise<void>;
  markPhotoReady(id: string, privatePath: string, width: number, height: number): Promise<void>;
  /** Counts a failed attempt; `failed` at maxAttempts. Returns the attempts so far. */
  markPhotoAttempt(id: string, maxAttempts: number): Promise<number>;
  getPhotoFull(id: string): Promise<(PhotoInfo & { privatePath: string | null }) | undefined>;
  /** A Public offer on the property still selects this photo. */
  photoUsedByPublicOffer(photoId: string, propertyId: string): Promise<boolean>;
  setPhotoPublic(id: string, publicName: string, publicPath: string | null): Promise<void>;

  // privacy
  termsForProperty(propertyId: string): Promise<PrivateTermRow[]>;
  tenantTermHashes(hashes: readonly string[]): Promise<PrivateTermRow[]>;
  replaceTerms(propertyId: string, terms: readonly PrivateTermRow[], at: Date): Promise<void>;
  saveScan(scan: ScanRecord): Promise<void>;
  getScan(id: string): Promise<ScanRecord | undefined>;

  // API keys
  insertApiKey(row: ApiKeyRow): Promise<void>;
  getApiKey(id: string, forUpdate?: boolean): Promise<ApiKeyRow | undefined>;
  updateApiKey(row: ApiKeyRow): Promise<void>;
  listApiKeys(
    status: ApiKeyRow['status'] | undefined,
    limit: number,
    after: { t: string; id: string } | undefined,
  ): Promise<ApiKeyRow[]>;

  // public API reads (public_item / change_feed only)
  listPublicItems(
    filter: PublicListFilter,
    limit: number,
    after: PublicCursor | undefined,
  ): Promise<PublicItemRow[]>;
  getPublicItemByPublicId(
    subjectType: PublicSubjectType,
    publicId: string,
  ): Promise<PublicItemRow | undefined>;
  changesAfter(seq: number, limit: number, notAfter: Date): Promise<ChangeRow[]>;
  firstChangeAtOrAfter(at: Date): Promise<number | undefined>;
  lastChangeSeq(): Promise<number>;

  // merges
  logMerge(entry: MergeLogEntry): Promise<void>;
  mergeEntries(mergeId: string, limit: number): Promise<MergeLogEntry[]>;

  // events (outbox, same transaction)
  emitPublicationChanged(change: PublicationChange): Promise<void>;
  emitAudit(entry: AuditEntry): Promise<void>;
  /** Enqueue slow work in the same transaction. */
  enqueue(item: WorkItem): Promise<void>;
}

export interface UnitOfWork {
  /** Runs fn in one transaction bound to the tenant. */
  run<T>(tenantId: string, correlationId: string, fn: (store: Store) => Promise<T>): Promise<T>;
}

/** records GET /internal/v1/properties/{id}/scan-terms (service token, R-20). */
export interface ScanTermsReader {
  fetch(
    tenantId: string,
    propertyId: string,
  ): Promise<{ saltKeyId: string; terms: Omit<PrivateTermRow, 'propertyId' | 'saltKeyId'>[] } | 'not-found'>;
}

/** HMAC of a normalised text token with the scan salt shared with records (R-20). */
export interface TermHasher {
  hash(token: string): string;
}

/** records micromarket hierarchy (R-13) for the micromarket filter paths. */
export interface MicromarketReader {
  ancestors(tenantId: string): Promise<Record<string, string[]>>;
}

/** records GET /internal/v1/photos/{id}/signed-url (L-2) → bytes of the original. */
export interface PhotoSource {
  download(tenantId: string, photoId: string): Promise<Uint8Array>;
}

export interface ImageProcessor {
  /** EXIF/GPS and other metadata stripped. */
  sanitise(
    bytes: Uint8Array,
  ): Promise<{ bytes: Uint8Array; width: number; height: number; contentType: string; ext: string }>;
}

/** Supabase Storage buckets listings-photos (private) and listings-public (public CDN). */
export interface PhotoStore {
  putPrivate(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  copyToPublic(privatePath: string, publicPath: string): Promise<void>;
  removePublic(publicPath: string): Promise<void>;
  removePrivate(privatePath: string): Promise<void>;
  publicUrl(publicPath: string): string;
}
