// Mapping of records' offer/demand fact events onto the local projections (LLD §3.2, §5.2). Pure functions.
import type { EventDataMap } from '@11e/contracts/events';
import { istDate, normalisePeriodStart } from '../domain/dates.js';
import type { IsoDate } from '../domain/dates.js';
import type { DemandViewRow, OfferViewRow } from './model.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const asDate = (v: unknown): IsoDate | null => (typeof v === 'string' && DATE.test(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const uuids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && UUID.test(x)))] : [];
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

type OfferFacts = EventDataMap['offer.created.v1'] | EventDataMap['offer.updated.v1'];
type DemandFacts = EventDataMap['demand.created.v1'] | EventDataMap['demand.updated.v1'];

/** Offer fact columns of offer_view from a full-facts event. */
export function offerFacts(d: OfferFacts, occurredAt: Date): Omit<OfferViewRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'captured_on' | 'publication_level' | 'publication_version' | 'stage_version' | 'voided' | 'merged_into'> {
  const seen = asDate(d.lastSeenDate) ?? istDate(occurredAt);
  return {
    code: d.code,
    property_id: d.propertyId,
    project_id: uuid(d.projectId),
    deal_type: d.dealType,
    market: text(d.market),
    segment: text(d.segment),
    property_types: texts(d.propertyTypes),
    micromarket: text(d.micromarket),
    locality: text(d.locality),
    city: text(d.city),
    outside_launch_area: d.outsideLaunchArea === true,
    possession_status: text(d.possessionStatus),
    possession_date_raw: text(d.possessionDate),
    available_from: normalisePeriodStart(text(d.possessionDate)),
    sale_price_inr_min: int(d.salePriceInrMin),
    sale_price_inr_max: int(d.salePriceInrMax),
    rent_monthly_inr_min: int(d.rentMonthlyInrMin),
    rent_monthly_inr_max: int(d.rentMonthlyInrMax),
    area_sqft_min: num(d.areaSqftMin),
    area_sqft_max: num(d.areaSqftMax),
    unit_count: int(d.unitCount),
    record_stage: d.recordStage ?? 'Enriched',
    has_real_photos: d.hasRealPhotos === true,
    source_type: text(d.sourceType),
    sourced_for_demand_id: uuid(d.sourcedForDemandId),
    owner_user_id: uuid(d.ownerUserId),
    price_sheet_date: asDate(d.priceSheetDate),
    contact_person_ids: uuids(d.contactPersonIds),
    last_seen_on: seen,
    facts_version: 0,
  };
}

export function demandFacts(d: DemandFacts, occurredAt: Date): Omit<DemandViewRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'captured_on' | 'touch_count' | 'voided' | 'merged_into'> {
  return {
    code: d.code,
    deal_types: texts(d.dealTypes),
    market: text(d.market),
    segment: text(d.segment),
    property_types: texts(d.propertyTypes),
    micromarkets: texts(d.micromarkets),
    localities: texts(d.localities),
    budget_inr_min: int(d.budgetInrMin),
    budget_inr_max: int(d.budgetInrMax),
    rent_monthly_inr_min: int(d.rentMonthlyInrMin),
    rent_monthly_inr_max: int(d.rentMonthlyInrMax),
    area_sqft_min: num(d.areaSqftMin),
    area_sqft_max: num(d.areaSqftMax),
    move_in_from: asDate(d.moveInFrom),
    move_in_by: asDate(d.moveInBy),
    outside_launch_area: d.outsideLaunchArea === true,
    record_stage: d.recordStage ?? 'Captured',
    source_type: text(d.sourceType),
    owner_user_id: uuid(d.ownerUserId),
    contact_person_ids: uuids(d.contactPersonIds),
    last_seen_on: asDate(d.lastSeenDate) ?? istDate(occurredAt),
    facts_version: 0,
  };
}

export interface GapCell {
  segment: string;
  dealType: string;
  micromarket: string;
}

export const offerCell = (o: Pick<OfferViewRow, 'segment' | 'deal_type' | 'micromarket' | 'outside_launch_area'>): GapCell | null =>
  o.segment && o.micromarket && !o.outside_launch_area
    ? { segment: o.segment, dealType: o.deal_type, micromarket: o.micromarket }
    : null;

export function demandCells(d: Pick<DemandViewRow, 'segment' | 'deal_types' | 'micromarkets' | 'outside_launch_area'>): GapCell[] {
  if (!d.segment || d.outside_launch_area) return [];
  const cells: GapCell[] = [];
  for (const dealType of d.deal_types) for (const micromarket of d.micromarkets) cells.push({ segment: d.segment, dealType, micromarket });
  return cells.slice(0, 50);
}

export const sameCell = (a: GapCell | null, b: GapCell | null) =>
  !!a && !!b && a.segment === b.segment && a.dealType === b.dealType && a.micromarket === b.micromarket;

/** Record stages at or beyond Contacted clear the "offer not yet Contacted" Must call condition (JA-3). */
export const isContacted = (recordStage: string) => ['Contacted', 'Verified', 'Qualified'].includes(recordStage);
