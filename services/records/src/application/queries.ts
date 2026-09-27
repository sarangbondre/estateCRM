// Read-side port: index-backed searches and batched view loading (records LLD §3 indexes, §8 performance).
import type {
  DemandRow,
  DeskItemRow,
  EnquiryRow,
  MarketDataRow,
  MergeCandidateRow,
  MicromarketRow,
  OfferRow,
  PersonPhoneRow,
  PersonRow,
  PhotoRow,
  PriceSheetRow,
  ProjectRow,
  PropertyRow,
  SecondSourceRow,
  SightingRow,
  SourceAdRow,
  TouchRow,
  VocabularyReleaseRow,
} from './model.js';

/** Keyset position: the last row's sort key and id (cursor content). */
export interface After {
  k: string | number | null;
  id: string;
}
export interface PageRequest {
  after?: After | undefined;
  /** Rows to fetch (callers ask for limit + 1 to know whether there is a next page). */
  limit: number;
}

export type SortKey = 'updatedAt' | '-updatedAt' | 'createdAt' | '-createdAt';

export interface OfferFilter {
  dealType?: string | undefined;
  market?: string | undefined;
  segment?: string | undefined;
  propertyType?: string | undefined;
  micromarketIds?: string[] | undefined;
  locality?: string | undefined;
  city?: string | undefined;
  outsideLaunchArea?: boolean | undefined;
  bhkMin?: number | undefined;
  bhkMax?: number | undefined;
  areaSqftMin?: number | undefined;
  areaSqftMax?: number | undefined;
  priceInrMin?: number | undefined;
  priceInrMax?: number | undefined;
  sourceType?: string | undefined;
  ownerUserId?: string | undefined;
  needsReview?: boolean | undefined;
  updatedSince?: Date | undefined;
  recordStage?: string | undefined;
  publicationLevel?: string | undefined;
  tenancyStatus?: string | undefined;
  saleMode?: string | undefined;
  furnishing?: string | undefined;
  possessionStatus?: string | undefined;
  propertyId?: string | undefined;
  projectId?: string | undefined;
  sourcedForDemandId?: string | undefined;
  hasPriceGap?: boolean | undefined;
  code?: string | undefined;
}

export interface PropertyFilter {
  segment?: string | undefined;
  propertyType?: string | undefined;
  micromarketIds?: string[] | undefined;
  locality?: string | undefined;
  city?: string | undefined;
  outsideLaunchArea?: boolean | undefined;
  buildingName?: string | undefined;
  projectId?: string | undefined;
  code?: string | undefined;
  updatedSince?: Date | undefined;
}

export interface ProjectFilter {
  micromarketIds?: string[] | undefined;
  locality?: string | undefined;
  city?: string | undefined;
  outsideLaunchArea?: boolean | undefined;
  developerPersonId?: string | undefined;
  hasRera?: boolean | undefined;
  code?: string | undefined;
  updatedSince?: Date | undefined;
}

export interface DemandFilter {
  dealType?: string | undefined;
  market?: string | undefined;
  segment?: string | undefined;
  propertyType?: string | undefined;
  micromarketIds?: string[] | undefined;
  locality?: string | undefined;
  outsideLaunchArea?: boolean | undefined;
  sourceType?: string | undefined;
  ownerUserId?: string | undefined;
  needsReview?: boolean | undefined;
  updatedSince?: Date | undefined;
  recordStage?: string | undefined;
  personId?: string | undefined;
  budgetInrMin?: number | undefined;
  budgetInrMax?: number | undefined;
  areaSqftMin?: number | undefined;
  areaSqftMax?: number | undefined;
  code?: string | undefined;
}

export interface PersonFilter {
  partyType?: string | undefined;
  participantRole?: string | undefined;
  flag?: string | undefined;
  companyName?: string | undefined;
  code?: string | undefined;
}

export interface EnquiryFilter {
  offerId?: string | undefined;
  projectId?: string | undefined;
  demandId?: string | undefined;
  campaignRef?: string | undefined;
  receivedSince?: Date | undefined;
}

export interface SourceAdFilter {
  sourceName?: string | undefined;
  sourceDate?: string | undefined;
  externalRef?: string | undefined;
  hasSplits?: boolean | undefined;
}

export interface CandidateFilter {
  aggregateType?: string | undefined;
  reason?: string | undefined;
  status?: string | undefined;
  uploadId?: string | undefined;
}

export interface DeskFilter {
  archived?: boolean | undefined;
  assigneeUserId?: string | undefined;
  sector?: string | undefined;
  dealType?: string | undefined;
  side?: string | undefined;
  deadlineWithinDays?: number | undefined;
  today?: string | undefined;
}

export interface MarketDataFilter {
  micromarketIds?: string[] | undefined;
  dealType?: string | undefined;
  segment?: string | undefined;
  source?: string | undefined;
  observedFrom?: string | undefined;
  observedTo?: string | undefined;
  includeVoided?: boolean | undefined;
}

export interface MicromarketRef {
  id: string;
  name: string;
  level: string;
}

export interface PartyView {
  personId: string;
  personCode: string;
  initials: string | null;
  role: string;
  partyType: string | null;
}

export interface OfferView {
  offer: OfferRow;
  property: PropertyRow;
  micromarket: MicromarketRef | null;
  photoIds: string[];
  contactPersonIds: string[];
  project: { code: string; latestPriceSheetDate: string | null } | null;
  sourcedForDemandCode: string | null;
  externalRef: string | null;
}

export interface PropertyView {
  property: PropertyRow;
  micromarket: MicromarketRef | null;
  offers: OfferRow[];
  parties: PartyView[];
}

export interface DemandView {
  demand: DemandRow;
  person: { code: string; initials: string | null } | null;
  micromarkets: MicromarketRef[];
  contactPersonIds: string[];
}

export interface PersonView {
  person: PersonRow;
  phones: PersonPhoneRow[];
  hasEmail: boolean;
  linked: { offers: number; demands: number; enquiries: number };
}

export interface ProjectView {
  project: ProjectRow;
  micromarket: MicromarketRef | null;
  configurations: OfferView[];
}

export interface SourceAdView {
  ad: SourceAdRow;
  children: { externalRef: string; splitIndex: string | null; subjectType: string; subjectId: string | null; code: string | null }[];
}

/** A property that may be the same as a new one, with what dedup scoring needs. */
export interface PropertyCandidateData {
  property: PropertyRow;
  offers: OfferRow[];
  phoneHashes: string[];
  /** Ingestion lineage of the property (split-sibling and extractor-trust rules). */
  lineage: { externalSource: string; parentExternalRef: string | null; sourceChannel: string | null }[];
}

export interface PropertyCandidateQuery {
  micromarketId: string | null;
  localityNorm: string | null;
  buildingNorm: string | null;
  segment: string | null;
  areaSqftMin: number | null;
  areaSqftMax: number | null;
  /** Never the record itself. */
  excludeIds?: string[] | undefined;
}

export interface Queries {
  // views (batched: no N+1)
  offerViews(ids: readonly string[]): Promise<OfferView[]>;
  propertyViews(ids: readonly string[]): Promise<PropertyView[]>;
  demandViews(ids: readonly string[]): Promise<DemandView[]>;
  personViews(ids: readonly string[]): Promise<PersonView[]>;
  projectViews(ids: readonly string[]): Promise<ProjectView[]>;
  sourceAdViews(ids: readonly string[]): Promise<SourceAdView[]>;
  micromarketRefs(ids: readonly string[]): Promise<MicromarketRef[]>;

  // lists
  listOffers(filter: OfferFilter, sort: SortKey, page: PageRequest): Promise<OfferRow[]>;
  listProperties(filter: PropertyFilter, page: PageRequest): Promise<PropertyRow[]>;
  listProjects(filter: ProjectFilter, page: PageRequest): Promise<ProjectRow[]>;
  listDemands(filter: DemandFilter, sort: SortKey, page: PageRequest): Promise<DemandRow[]>;
  listPeople(filter: PersonFilter, page: PageRequest): Promise<PersonRow[]>;
  listTouches(demandId: string, page: PageRequest): Promise<TouchRow[]>;
  listEnquiries(filter: EnquiryFilter, page: PageRequest): Promise<EnquiryRow[]>;
  listSourceAds(filter: SourceAdFilter, page: PageRequest): Promise<SourceAdRow[]>;
  listSightings(subjects: readonly { type: string; id: string }[], page: PageRequest): Promise<SightingRow[]>;
  listSecondSources(
    filter: { propertyId?: string | undefined; status?: string | undefined; priceGap?: boolean | undefined },
    page: PageRequest,
  ): Promise<SecondSourceRow[]>;
  listPhotos(propertyId: string, page: PageRequest): Promise<PhotoRow[]>;
  listPriceSheets(projectId: string, page: PageRequest): Promise<PriceSheetRow[]>;
  listCandidates(filter: CandidateFilter, page: PageRequest): Promise<MergeCandidateRow[]>;
  listDesk(desk: string, filter: DeskFilter, page: PageRequest): Promise<DeskItemRow[]>;
  listNetwork(filter: DeskFilter, page: PageRequest): Promise<PersonRow[]>;
  listMicromarkets(
    filter: { parentId?: string | undefined; level?: string | undefined; q?: string | undefined },
    page: PageRequest,
  ): Promise<MicromarketRow[]>;
  listVocabularyReleases(page: PageRequest): Promise<VocabularyReleaseRow[]>;
  listMarketData(filter: MarketDataFilter, page: PageRequest): Promise<MarketDataRow[]>;

  // dedup and reference lookups
  propertyCandidates(q: PropertyCandidateQuery): Promise<PropertyCandidateData[]>;
  /** Active persons holding any of these phone hashes (most recently active first). */
  personsByPhoneHashes(hashes: readonly string[]): Promise<{ person: PersonRow; phoneHash: string }[]>;
  personsByEmailHashes(hashes: readonly string[]): Promise<{ person: PersonRow; emailHash: string }[]>;
  /** Open (active, not closed, not exited Lost/Invalid) demands of a person or company created since `since`. */
  demandCandidates(q: { personId: string | null; companyNorm: string | null; since: Date; excludeId?: string }): Promise<DemandRow[]>;
  /** Node whose name or alias equals `nameNorm` (most specific level first). */
  resolveMicromarket(nameNorm: string): Promise<MicromarketRow | undefined>;
  /** Nodes (other than excludeId) whose name/alias is any of `namesNorm`. */
  micromarketsNamed(namesNorm: readonly string[], excludeId?: string): Promise<MicromarketRow[]>;
  /** The ids plus all their descendants (depth ≤ 4, capped at 200). */
  micromarketDescendants(ids: readonly string[]): Promise<string[]>;
  adjacentIds(ids: readonly string[]): Promise<Map<string, string[]>>;
}
