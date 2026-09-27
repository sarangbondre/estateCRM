// Specialised queries of the journeys store (each backed by an index in LLD §3.5 / migrations). Implemented by
// adapters/store.ts; bounded by explicit limits.
import type { IsoDate } from '../domain/dates.js';
import type { GapCell } from './facts.js';
import type {
  CallRow,
  CapacityRow,
  DealEventRow,
  DealRow,
  DemandGapRow,
  LifeCurveRow,
  LeaseRenewalRow,
  MatchViewRow,
  NotificationRow,
  OfferViewRow,
  ProposalLinkRow,
  ProposalOptionRow,
  ProposalRow,
  QueueCounterRow,
  QueueItemRow,
  SettingsRow,
  SiteVisitRow,
  SourceQualityRow,
  SourcingRequestRow,
  StaffUserRow,
  SubjectContactRow,
  WatchlistTaskRow,
} from './model.js';

export interface CloseFilter {
  ids?: readonly string[];
  subjectId?: string;
  offerId?: string;
  demandId?: string;
  sections?: readonly string[];
}

export interface CounterDelta {
  userId: string;
  section: string;
  delta: number;
}

export interface OfferEngagementFacts {
  hasOpenDeal: boolean;
  hasCompletedVisit: boolean;
  hasSentProposal: boolean;
  hasConfirmedMatch: boolean;
  openMatchCount: number;
  confirmedMatchCount: number;
}

export interface DemandEngagementFacts {
  hasOpenDeal: boolean;
  hasCompletedVisit: boolean;
  hasSentProposal: boolean;
  hasConfirmedMatch: boolean;
  hasOpenSourcingRequest: boolean;
}

export interface RepointTarget {
  table: string;
  column: string;
  kind: 'scalar' | 'array';
}

/** Keyset position of a list (the sort key values of the last row + its id). */
export type Position = Record<string, string | number | null>;

export interface Page<T> {
  rows: T[];
}

export interface SectionItem extends QueueItemRow {
  life_stage: string | null;
  day_count: number | null;
  summary_offer: Pick<OfferViewRow, 'deal_type' | 'property_types' | 'micromarket' | 'area_sqft_min' | 'sale_price_inr_min' | 'rent_monthly_inr_min'> | null;
  summary_demand: {
    deal_types: string[];
    property_types: string[];
    micromarkets: string[];
    budget_inr_max: number | null;
    rent_monthly_inr_max: number | null;
  } | null;
}

export interface ListFilter {
  [key: string]: string | number | boolean | null | undefined | readonly string[];
}

export interface Queries {
  settingsByKind(kind: SettingsRow['kind']): Promise<SettingsRow | undefined>;

  // queue
  openItemFor(section: string, subjectType: string, subjectId: string): Promise<QueueItemRow | undefined>;
  closeOpenItems(filter: CloseFilter, status: 'done' | 'cancelled', reason: string, now: Date): Promise<QueueItemRow[]>;
  openItemsOf(filter: { offerId?: string; demandId?: string; subjectId?: string }, limit: number): Promise<QueueItemRow[]>;
  openItemsOfAssignee(userId: string, limit: number): Promise<QueueItemRow[]>;
  unassignedOpenItems(team: 'supply' | 'demand', limit: number): Promise<QueueItemRow[]>;
  bumpCounters(deltas: readonly CounterDelta[], now: Date): Promise<void>;
  countersOf(userId: string): Promise<QueueCounterRow[]>;
  overdueCount(userId: string, section: string, now: Date): Promise<number>;
  eligibleShouldCount(userId: string, today: IsoDate, cap: number): Promise<number>;
  sectionItems(
    userId: string,
    section: string,
    ranked: boolean,
    today: IsoDate,
    after: Position | undefined,
    limit: number,
  ): Promise<SectionItem[]>;
  markRankDirty(filter: { offerId?: string; all?: boolean }): Promise<number>;
  dirtyRankItems(limit: number): Promise<QueueItemRow[]>;
  loadOfActiveStaff(roles: readonly string[], team: 'supply' | 'demand'): Promise<{ userId: string; openCount: number }[]>;
  activeStaffByRole(roles: readonly string[], limit: number): Promise<StaffUserRow[]>;
  changedCounterUsers(limit: number): Promise<string[]>;
  markCountersEmitted(userId: string, at: Date): Promise<void>;
  reconcileCounters(userId: string): Promise<void>;

  // subjects and projections
  curveBySubject(subjectType: 'offer' | 'demand', subjectId: string): Promise<LifeCurveRow | undefined>;
  dueCurves(today: IsoDate, limit: number): Promise<LifeCurveRow[]>;
  offersOfProject(projectId: string, limit: number): Promise<OfferViewRow[]>;
  linkContacts(subjectType: 'offer' | 'demand', subjectId: string, personIds: readonly string[]): Promise<void>;
  subjectsOfPerson(personId: string, limit: number): Promise<SubjectContactRow[]>;
  linkMatchOffers(matchId: string, demandId: string, offerIds: readonly string[]): Promise<void>;
  countMatchesOfDemand(demandId: string, statuses: readonly string[]): Promise<number>;
  matchesOfDemand(demandId: string, statuses: readonly string[], limit: number): Promise<MatchViewRow[]>;
  confirmedMatchesOfOffer(offerId: string, limit: number): Promise<MatchViewRow[]>;
  offerEngagements(offerId: string, today: IsoDate): Promise<OfferEngagementFacts>;
  demandEngagements(demandId: string): Promise<DemandEngagementFacts>;
  ownersOfConfirmedMatchOffers(demandId: string): Promise<string[]>;
  watchlistTaskOfItem(watchlistItemId: string): Promise<WatchlistTaskRow | undefined>;
  capacityOf(userId: string): Promise<CapacityRow | undefined>;

  // demand gap and source quality
  demandGapCell(segment: string, dealType: string, micromarket: string): Promise<DemandGapRow | undefined>;
  sourceQuality(sourceType: string): Promise<SourceQualityRow | undefined>;
  adjustGapCells(cells: readonly GapCell[], demandDelta: number, supplyDelta: number, now: Date): Promise<void>;
  recomputeDemandGap(now: Date, today: IsoDate): Promise<number>;
  recomputeSourceQuality(now: Date, since: IsoDate): Promise<number>;

  // engagements
  openSourcingRequestsOfDemand(demandId: string): Promise<SourcingRequestRow[]>;
  openDealOfDemand(demandId: string): Promise<DealRow | undefined>;
  openDealsOfOffer(offerId: string, limit: number): Promise<DealRow[]>;
  dealOfMatch(matchId: string): Promise<DealRow | undefined>;
  proposalOptions(proposalId: string): Promise<ProposalOptionRow[]>;
  replaceProposalOptions(proposalId: string, options: readonly { position: number; matchId: string; offerIds: string[] }[]): Promise<void>;
  activeLink(proposalId: string): Promise<ProposalLinkRow | undefined>;
  linkByHash(hash: Buffer): Promise<ProposalLinkRow | undefined>;
  revokeLinks(proposalId: string, at: Date): Promise<number>;
  recordLinkOpen(link: ProposalLinkRow, at: Date, ipHash: Buffer | null, uaFamily: string | null): Promise<ProposalLinkRow>;
  openProposalIdsOfOffer(offerId: string, limit: number): Promise<string[]>;
  dealEvents(dealId: string, limit: number): Promise<DealEventRow[]>;
  leaseRenewalOfDeal(dealId: string): Promise<LeaseRenewalRow | undefined>;
  visitsOfDemand(demandId: string, statuses: readonly string[], limit: number): Promise<SiteVisitRow[]>;

  // lists (keyset pages; the adapter owns the ORDER BY of each list)
  listCalls(f: { subjectId?: string; personId?: string; loggedBy?: string; from?: Date; to?: Date }, after: Position | undefined, limit: number): Promise<CallRow[]>;
  callsLoggedSince(userId: string, since: Date): Promise<number>;
  listCapacities(team: string | undefined, after: Position | undefined, limit: number): Promise<CapacityRow[]>;
  listSourcingRequests(f: ListFilter, after: Position | undefined, limit: number): Promise<SourcingRequestRow[]>;
  listProposals(f: ListFilter, after: Position | undefined, limit: number): Promise<ProposalRow[]>;
  listSiteVisits(f: ListFilter, after: Position | undefined, limit: number): Promise<SiteVisitRow[]>;
  listDeals(f: ListFilter, today: IsoDate, after: Position | undefined, limit: number): Promise<DealRow[]>;
  listLeaseRenewals(f: ListFilter, after: Position | undefined, limit: number): Promise<LeaseRenewalRow[]>;
  listNotifications(userId: string, unreadOnly: boolean, after: Position | undefined, limit: number): Promise<NotificationRow[]>;
  unreadCount(userId: string): Promise<number>;
  unreadByDedupeKey(userId: string, key: string): Promise<NotificationRow | undefined>;
  markRead(userId: string, ids: readonly string[] | null, upTo: Date | null, at: Date): Promise<number>;
  listWatchlistTasks(f: ListFilter, today: IsoDate, after: Position | undefined, limit: number): Promise<WatchlistTaskRow[]>;
  subjectStates(subjectType: 'offer' | 'demand', since: Date | undefined, after: Position | undefined, limit: number): Promise<
    { id: string; commercial_status: string; exit_type: string | null; stage: string | null; day_count: number | null; version: number; updated_at: Date }[]
  >;

  // jobs
  dueLeaseRenewals(today: IsoDate, limit: number): Promise<LeaseRenewalRow[]>;
  dueDormantRevisits(today: IsoDate, after: Position | undefined, limit: number): Promise<{ id: string; revisit_date: IsoDate }[]>;
  overdueDeals(today: IsoDate, after: Position | undefined, limit: number): Promise<DealRow[]>;
  overdueSourcingRequests(today: IsoDate, after: Position | undefined, limit: number): Promise<SourcingRequestRow[]>;
  jobCursor(job: string, runDate: IsoDate): Promise<{ cursor: string | null; processed: number; done: boolean } | undefined>;
  saveJobCursor(job: string, runDate: IsoDate, cursor: string | null, processed: number, done: boolean, now: Date): Promise<void>;
  purgeBefore(kind: 'notifications' | 'link_opens' | 'pii_notes' | 'snapshots', before: Date, limit: number): Promise<{ count: number; paths: string[] }>;

  // merges
  repoint(mergeId: string, target: RepointTarget, from: string, to: string, limit: number): Promise<number>;
  logBefore(mergeId: string, table: string, rowId: string, before: Record<string, unknown>): Promise<void>;
  /** Restores before-images; returns the survivor ids the merge had pointed rows to. */
  restoreMerge(mergeId: string, limit: number): Promise<string[]>;
}
