// Event payloads built from stored records (records LLD §4.17, events catalogue v0.2). Payloads never carry contact
// PII: people travel as ids (contactPersonIds), buildings as an opaque buildingKey.
import type { EventDataMap } from '@11e/contracts/events';
import type { DemandView, OfferView, ProjectView } from './queries.js';

type OfferFacts = EventDataMap['offer.created.v1'];
type DemandFacts = EventDataMap['demand.created.v1'];
type ProjectFacts = EventDataMap['project.created.v1'];

/** Drops null/undefined members (event schemas declare optional, non-nullable fields). */
export function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function offerFacts(v: OfferView): OfferFacts {
  const o = v.offer;
  const p = v.property;
  const facts = compact({
    offerId: o.id,
    code: o.code,
    propertyId: o.property_id,
    projectId: o.project_id,
    dealType: o.deal_type,
    market: o.market,
    segment: p.segment,
    propertyTypes: p.property_types,
    bhkMin: p.bhk_min,
    bhkMax: p.bhk_max,
    areaSqftMin: p.area_sqft_min,
    areaSqftMax: p.area_sqft_max,
    areaBasis: p.area_basis as OfferFacts['areaBasis'],
    landAreaSqft: p.land_area_sqft,
    salePriceInrMin: o.sale_price_inr_min,
    salePriceInrMax: o.sale_price_inr_max,
    rentMonthlyInrMin: o.rent_monthly_inr_min,
    rentMonthlyInrMax: o.rent_monthly_inr_max,
    depositInr: o.deposit_inr,
    currentRentInr: o.current_rent_inr,
    locality: p.locality,
    micromarket: p.micromarket_id,
    city: p.city,
    outsideLaunchArea: p.outside_launch_area,
    tenancyStatus: o.tenancy_status,
    saleMode: o.sale_mode,
    possessionStatus: o.possession_status,
    possessionDate: o.possession_date,
    furnishing: o.furnishing,
    unitCount: o.unit_count,
    recordStage: o.record_stage as OfferFacts['recordStage'],
    photoCount: p.photo_count,
    hasRealPhotos: p.has_real_photos,
    selectedPhotoIds: v.photoIds,
    sourceType: o.source_type,
    sourcedForDemandId: o.sourced_for_demand_id,
    ownerUserId: o.owner_user_id,
    contactPersonIds: v.contactPersonIds,
    buildingKey: p.building_key,
    floorBand: p.floor_band,
    totalFloors: p.total_floors,
    parking: p.parking,
    amenities: p.amenities,
    tenure: o.tenure,
    agreementForm: o.agreement_form,
    isJodi: o.is_jodi,
    priceSheetDate: v.project?.latestPriceSheetDate ?? null,
    lastSeenDate: day(o.last_seen_at ?? p.last_seen_at),
    // G-R11: the offer id when a description exists; listings fetches and sanitises the text via GET /v1/offers/{id}.
    publicDescriptionSource: o.description ? o.id : null,
    projectCode: v.project?.code ?? null,
  });
  return facts as OfferFacts;
}

export function demandFacts(v: DemandView): DemandFacts {
  const d = v.demand;
  const statedTags: Record<string, string> = {};
  for (const [k, val] of Object.entries(d.stated_tags ?? {})) {
    if (typeof val === 'string') statedTags[k] = val;
    else if (typeof val === 'boolean') statedTags[k] = String(val);
  }
  return compact({
    demandId: d.id,
    code: d.code,
    dealTypes: d.deal_types,
    market: d.market,
    segment: d.segment,
    propertyTypes: d.property_types,
    bhkMin: d.bhk_min,
    bhkMax: d.bhk_max,
    areaSqftMin: d.area_sqft_min,
    areaSqftMax: d.area_sqft_max,
    areaBasis: d.area_basis as DemandFacts['areaBasis'],
    budgetInrMin: d.budget_inr_min,
    budgetInrMax: d.budget_inr_max,
    rentMonthlyInrMin: d.rent_monthly_inr_min,
    rentMonthlyInrMax: d.rent_monthly_inr_max,
    micromarkets: d.micromarket_ids,
    localities: d.localities,
    moveInBy: d.move_in_by,
    statedTags,
    outsideLaunchArea: d.outside_launch_area,
    recordStage: d.record_stage as DemandFacts['recordStage'],
    sourceType: d.source_type,
    ownerUserId: d.owner_user_id,
    contactPersonIds: v.contactPersonIds,
    moveInFrom: d.move_in_from,
    lastSeenDate: day(d.last_seen_at),
  }) as DemandFacts;
}

export function projectFacts(v: ProjectView): ProjectFacts {
  const p = v.project;
  return compact({
    projectId: p.id,
    code: p.code,
    name: p.name,
    developerPersonId: p.developer_person_id,
    developerName: p.developer_name,
    reraNumber: p.rera_number,
    locality: p.locality,
    micromarket: p.micromarket_id,
    city: p.city,
    possessionDate: p.possession_date,
    amenities: p.amenities,
    offerIds: v.configurations.map((c) => c.offer.id),
  }) as ProjectFacts;
}

/** `offer.price_changed.v1` previous/current (only the fields that exist). */
export function priceSnapshot(o: {
  sale_price_inr_min: number | null;
  sale_price_inr_max: number | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
  deposit_inr: number | null;
  current_rent_inr: number | null;
  unit_count: number | null;
}): EventDataMap['offer.price_changed.v1']['current'] {
  return compact<Record<string, number | null>>({
    salePriceInrMin: o.sale_price_inr_min,
    salePriceInrMax: o.sale_price_inr_max,
    rentMonthlyInrMin: o.rent_monthly_inr_min,
    rentMonthlyInrMax: o.rent_monthly_inr_max,
    depositInr: o.deposit_inr,
    currentRentInr: o.current_rent_inr,
    unitCount: o.unit_count,
  }) as EventDataMap['offer.price_changed.v1']['current'];
}
