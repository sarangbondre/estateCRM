// Event payload → read-model column patches (LLD §3.1 "Filled by"). Pure: no I/O, no contact data is ever copied
// (events carry none; person ids are pseudonymous and only used to fetch contacts at export time).
import type { EventDataMap } from '@11e/contracts/events';
import { periodStart } from '../dates.js';
import type { DemandRow, OfferRow } from './rows.js';

type OfferFacts = EventDataMap['offer.created.v1'];
type DemandFacts = EventDataMap['demand.created.v1'];

const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Full offer facts (offer.created / offer.updated carry the whole snapshot). */
export function offerFacts(d: OfferFacts): Partial<OfferRow> {
  const types = d.propertyTypes ?? [];
  return {
    code: d.code,
    property_id: d.propertyId,
    project_id: n(d.projectId),
    deal_type: d.dealType,
    market: n(d.market),
    segment: n(d.segment),
    property_types: types,
    property_type_primary: types[0] ?? null,
    bhk_min: n(d.bhkMin),
    bhk_max: n(d.bhkMax),
    area_sqft_min: n(d.areaSqftMin),
    area_sqft_max: n(d.areaSqftMax),
    area_basis: n(d.areaBasis),
    land_area_sqft: n(d.landAreaSqft),
    sale_price_inr_min: n(d.salePriceInrMin),
    sale_price_inr_max: n(d.salePriceInrMax),
    rent_monthly_inr_min: n(d.rentMonthlyInrMin),
    rent_monthly_inr_max: n(d.rentMonthlyInrMax),
    deposit_inr: n(d.depositInr),
    current_rent_inr: n(d.currentRentInr),
    locality: n(d.locality),
    micromarket: n(d.micromarket),
    city: n(d.city),
    outside_launch_area: d.outsideLaunchArea ?? false,
    tenancy_status: n(d.tenancyStatus),
    sale_mode: n(d.saleMode),
    possession_status: n(d.possessionStatus),
    possession_date: n(d.possessionDate),
    possession_sort: periodStart(d.possessionDate),
    furnishing: n(d.furnishing),
    unit_count: n(d.unitCount),
    source_type: n(d.sourceType),
    owner_user_id: n(d.ownerUserId),
    sourced_for_demand_id: n(d.sourcedForDemandId),
    contact_person_ids: d.contactPersonIds ?? [],
    ...(d.photoCount !== undefined ? { photo_count: d.photoCount } : {}),
    ...(d.hasRealPhotos !== undefined ? { has_real_photos: d.hasRealPhotos } : {}),
    ...(d.recordStage !== undefined ? { record_stage: d.recordStage } : {}),
  };
}

/** Full demand facts (demand.created / demand.updated). */
export function demandFacts(d: DemandFacts): Partial<DemandRow> {
  const types = d.propertyTypes ?? [];
  return {
    code: d.code,
    deal_types: d.dealTypes,
    deal_type_primary: d.dealTypes[0] ?? null,
    market: n(d.market),
    segment: n(d.segment),
    property_types: types,
    property_type_primary: types[0] ?? null,
    bhk_min: n(d.bhkMin),
    bhk_max: n(d.bhkMax),
    area_sqft_min: n(d.areaSqftMin),
    area_sqft_max: n(d.areaSqftMax),
    area_basis: n(d.areaBasis),
    budget_inr_min: n(d.budgetInrMin),
    budget_inr_max: n(d.budgetInrMax),
    rent_monthly_inr_min: n(d.rentMonthlyInrMin),
    rent_monthly_inr_max: n(d.rentMonthlyInrMax),
    micromarkets: d.micromarkets ?? [],
    localities: d.localities ?? [],
    move_in_by: n(d.moveInBy),
    stated_tags: d.statedTags ?? {},
    outside_launch_area: d.outsideLaunchArea ?? false,
    owner_user_id: n(d.ownerUserId),
    contact_person_ids: d.contactPersonIds ?? [],
    ...(d.recordStage !== undefined ? { record_stage: d.recordStage } : {}),
  };
}

/** Price fields of offer.price_changed.v1 `current` (only the keys present change). */
export function offerPrices(c: EventDataMap['offer.price_changed.v1']['current']): Partial<OfferRow> {
  const out: Partial<OfferRow> = {};
  if (c.salePriceInrMin !== undefined) out.sale_price_inr_min = c.salePriceInrMin;
  if (c.salePriceInrMax !== undefined) out.sale_price_inr_max = c.salePriceInrMax;
  if (c.rentMonthlyInrMin !== undefined) out.rent_monthly_inr_min = c.rentMonthlyInrMin;
  if (c.rentMonthlyInrMax !== undefined) out.rent_monthly_inr_max = c.rentMonthlyInrMax;
  if (c.depositInr !== undefined) out.deposit_inr = c.depositInr;
  if (c.currentRentInr !== undefined) out.current_rent_inr = c.currentRentInr;
  if (c.unitCount !== undefined) out.unit_count = c.unitCount;
  return out;
}

/** Record stages at which an offer counts as verified (first time only; LLD §3.1 rm_offer). */
export const VERIFIED_STAGES: readonly string[] = ['Verified', 'Qualified'];

/** Status of a match after an event (crm-engine LLD vocabulary). */
export const MATCH_STATUS = {
  suggested: 'Suggested',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  closed: 'Closed',
} as const;

/** Deal statuses in rm_deal. */
export const DEAL_STATUS = { open: 'open', closed: 'closed', cancelled: 'cancelled' } as const;

/** Queue section keys of `queue.counts_changed.v1` (journeys LLD §4.3.1), used by the dashboard tiles. */
export const QUEUE_SECTIONS = {
  supply: ['must_call', 'should_call', 'sourcing_requests', 'watchlist_tasks'],
  demand: [
    'to_contact',
    'to_qualify',
    'reconfirm_due',
    'needs_sourcing',
    'in_sourcing',
    'sourcing_requests_open',
    'open_matches',
    'proposals_out',
    'site_visits_this_week',
    'deals_follow_up',
    'dormant_revisits',
  ],
} as const;

/** Stable id of a row-stat bucket (one row per upload and classification bucket, no row content). */
export function rowStatKey(parts: (string | boolean | null | undefined)[]): string {
  return parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('|');
}
