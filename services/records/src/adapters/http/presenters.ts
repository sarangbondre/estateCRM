// Stored rows → contract DTOs (records.yaml schemas). Contacts, unit/wing/floor and raw text are never included;
// they are read through POST /v1/reveals. Labels are generated here from stored fields (BRD §4.2).
import { demandLabel, offerLabel } from '../../domain/labels.js';
import { maskPhone } from '../../domain/phone.js';
import type {
  DeskItemRow,
  EnquiryRow,
  MarketDataRow,
  MergeCandidateRow,
  MergeRow,
  OfferRow,
  PhotoRow,
  PriceSheetRow,
  SecondSourceRow,
  SightingRow,
  TouchRow,
} from '../../application/model.js';
import type {
  DemandView,
  MicromarketRef,
  OfferView,
  PersonView,
  ProjectView,
  PropertyView,
  SourceAdView,
} from '../../application/queries.js';
import type { ScoredCandidate } from '../../application/supply.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const mm = (m: MicromarketRef | null) => (m ? { id: m.id, name: m.name, level: m.level } : null);
const REVIEW_CODES = new Set(['side_defaulted', 'deal_type_missing', 'side_unclear', 'property_type_missing', 'other']);
const reviewCode = (c: string | null) => (c === null ? null : REVIEW_CODES.has(c) ? c : 'other');

export function offerSummary(o: OfferRow, segment: string | null) {
  return {
    id: o.id,
    code: o.code,
    dealType: o.deal_type,
    market: o.market,
    label: offerLabel(o.deal_type, o.market, segment),
    recordStage: o.record_stage,
    publicationLevel: o.publication_level,
  };
}

export function offerDto(v: OfferView) {
  const o = v.offer;
  const p = v.property;
  return {
    id: o.id,
    code: o.code,
    propertyId: p.id,
    propertyCode: p.code,
    projectId: o.project_id,
    dealType: o.deal_type,
    segment: p.segment,
    propertyTypes: p.property_types,
    propertyDetail: p.property_detail,
    bhkMin: p.bhk_min,
    bhkMax: p.bhk_max,
    areaSqftMin: p.area_sqft_min,
    areaSqftMax: p.area_sqft_max,
    areaBasis: p.area_basis,
    landAreaSqft: p.land_area_sqft,
    locality: p.locality,
    micromarket: mm(v.micromarket),
    city: p.city,
    state: p.state,
    landmark: p.landmark,
    locationText: p.location_text,
    outsideLaunchArea: p.outside_launch_area,
    market: o.market,
    salePriceInrMin: o.sale_price_inr_min,
    salePriceInrMax: o.sale_price_inr_max,
    saleRateInr: o.sale_rate_inr,
    saleRateUnit: o.sale_rate_unit,
    rentMonthlyInrMin: o.rent_monthly_inr_min,
    rentMonthlyInrMax: o.rent_monthly_inr_max,
    rentRatePsf: o.rent_rate_psf,
    depositInr: o.deposit_inr,
    depositMonths: o.deposit_months,
    currentRentInr: o.current_rent_inr,
    yieldPct: o.yield_pct,
    priceNegotiable: o.price_negotiable,
    priceText: o.price_text,
    saleMode: o.sale_mode,
    deadlineDate: o.deadline_date,
    tenancyStatus: o.tenancy_status,
    tenure: o.tenure,
    agreementForm: o.agreement_form,
    isJodi: o.is_jodi,
    possessionStatus: o.possession_status,
    possessionDate: o.possession_date,
    furnishing: o.furnishing,
    description: o.description,
    ...(o.revenue_share_text !== null ? { revenueShareText: o.revenue_share_text } : {}),
    revenueSharePct: o.revenue_share_pct,
    unitCount: o.unit_count,
    ownerUserId: o.owner_user_id,
    label: offerLabel(o.deal_type, o.market, p.segment),
    recordStage: o.record_stage,
    publicationLevel: o.publication_level,
    sourceType: o.source_type,
    captureMode: o.capture_mode,
    sideEvidence: o.side_evidence,
    needsReview: o.needs_review,
    reviewReason: o.review_reason,
    reviewReasonCode: reviewCode(o.review_reason_code),
    routeToSuggestion: o.route_to_suggestion,
    sourcedForDemandId: o.sourced_for_demand_id,
    sourcingRequestId: o.sourcing_request_id,
    sourcedForDemandCode: v.sourcedForDemandCode,
    signals: {
      enquiryCount: o.enquiry_count,
      sightingCount: o.sighting_count,
      secondSourceCount: o.second_source_count,
      hasPriceGap: o.has_price_gap,
    },
    photoIds: v.photoIds,
    firstSeenDate: o.first_seen_date,
    lastSeenAt: iso(o.last_seen_at),
    timesSeen: o.times_seen,
    sourceAdId: o.source_ad_id,
    externalRef: v.externalRef,
    status: o.status === 'merged' ? 'merged' : 'active',
    mergedIntoId: o.merged_into_id,
    createdAt: o.created_at.toISOString(),
    updatedAt: o.updated_at.toISOString(),
    version: o.version,
  };
}

export function propertyDto(v: PropertyView) {
  const p = v.property;
  return {
    id: p.id,
    code: p.code,
    segment: p.segment,
    propertyTypes: p.property_types,
    propertyDetail: p.property_detail,
    landUse: p.land_use,
    locality: p.locality,
    micromarket: mm(v.micromarket),
    city: p.city,
    state: p.state,
    landmark: p.landmark,
    locationText: p.location_text,
    outsideLaunchArea: p.outside_launch_area,
    buildingName: p.building_name,
    hasUnitDetails: p.wing !== null || p.unit_no !== null || p.floor_no !== null,
    floorBand: p.floor_band,
    totalFloors: p.total_floors,
    areaSqftMin: p.area_sqft_min,
    areaSqftMax: p.area_sqft_max,
    areaBasis: p.area_basis,
    landAreaValue: p.land_area_value,
    landAreaUnit: p.land_area_unit,
    landAreaSqft: p.land_area_sqft,
    areaText: p.area_text,
    bhkMin: p.bhk_min,
    bhkMax: p.bhk_max,
    features: p.features,
    amenities: p.amenities,
    parking: p.parking,
    projectId: p.project_id,
    offers: v.offers.map((o) => offerSummary(o, p.segment)),
    parties: v.parties.map((x) => ({
      personId: x.personId,
      personCode: x.personCode,
      ...(x.initials ? { displayName: x.initials } : { displayName: x.personCode }),
      role: x.role,
      partyType: x.partyType,
    })),
    photoCount: p.photo_count,
    hasRealPhotos: p.has_real_photos,
    lastSeenAt: iso(p.last_seen_at),
    status: p.status,
    mergedIntoId: p.merged_into_id,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
    version: p.version,
  };
}

export function candidateDto(c: ScoredCandidate) {
  const p = c.data.property;
  const area = p.area_sqft_min !== null ? `${p.area_sqft_min} sqft` : null;
  const bhk = p.bhk_min !== null ? `${p.bhk_min} BHK` : null;
  return {
    propertyId: p.id,
    code: p.code,
    score: c.score.score,
    reasons: c.score.reasons,
    summary: [p.segment, p.property_types.join('/'), p.locality, bhk, area].filter(Boolean).join(', '),
    offers: c.data.offers.map((o) => offerSummary(o, p.segment)),
  };
}

export function projectDto(v: ProjectView) {
  const p = v.project;
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    developerPersonId: p.developer_person_id,
    developerName: p.developer_name,
    locality: p.locality,
    micromarket: mm(v.micromarket),
    city: p.city,
    state: p.state,
    landmark: p.landmark,
    locationText: p.location_text,
    outsideLaunchArea: p.outside_launch_area,
    reraNumber: p.rera_number,
    possessionDate: p.possession_date,
    amenities: p.amenities,
    floorPlanPhotoIds: p.floor_plan_photo_ids,
    latestPriceSheetDate: p.latest_price_sheet_date,
    publicationLevel: p.publication_level,
    configurations: v.configurations.map(offerDto),
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
    version: p.version,
  };
}

export function priceSheetDto(s: PriceSheetRow) {
  return {
    id: s.id,
    projectId: s.project_id,
    sheetDate: s.sheet_date,
    receivedVia: s.received_via,
    lines: s.lines as unknown[],
    createdOffers: s.created_offers,
    updatedOffers: s.updated_offers,
    priceChangedOffers: s.price_changed_offers,
    createdBy: s.created_by,
    createdAt: s.created_at.toISOString(),
  };
}

export function sightingDto(s: SightingRow, adCodes: Map<string, string>) {
  const sourceType = s.source_type === 'Channel' || s.source_type === 'Digi' || s.source_type === 'Direct' ? s.source_type : undefined;
  return {
    id: s.id,
    subjectType: s.subject_type,
    subjectId: s.subject_id,
    sourceAdId: s.source_ad_id,
    sourceAdCode: s.source_ad_id ? (adCodes.get(s.source_ad_id) ?? null) : null,
    uploadId: s.upload_id,
    rowId: s.row_id,
    externalRef: s.external_ref,
    splitIndex: s.split_index,
    ...(sourceType ? { sourceType } : {}),
    sourceName: s.source_name,
    seenOn: s.seen_on,
  };
}

export function secondSourceDto(s: SecondSourceRow) {
  const sourceType = s.source_type === 'Channel' || s.source_type === 'Digi' || s.source_type === 'Direct' ? s.source_type : undefined;
  return {
    id: s.id,
    propertyId: s.property_id,
    offerId: s.offer_id,
    sourceAdId: s.source_ad_id,
    personId: s.person_id,
    ...(sourceType ? { sourceType } : {}),
    sourceName: s.source_name,
    salePriceInrMin: s.sale_price_inr_min,
    salePriceInrMax: s.sale_price_inr_max,
    rentMonthlyInrMin: s.rent_monthly_inr_min,
    rentMonthlyInrMax: s.rent_monthly_inr_max,
    priceGapPct: s.price_gap_pct,
    priceGap: s.price_gap,
    status: s.status,
    seenOn: s.seen_on,
  };
}

export function photoDto(p: PhotoRow, url: string | null) {
  return {
    id: p.id,
    propertyId: p.property_id,
    origin: p.origin,
    isReal: p.is_real,
    status: p.status,
    url,
    width: p.width,
    height: p.height,
    fetchError: p.fetch_error,
    createdAt: p.created_at.toISOString(),
  };
}

export function demandDto(v: DemandView) {
  const d = v.demand;
  const tags = (d.stated_tags ?? {}) as Record<string, unknown>;
  const statedTags: Record<string, unknown> = {};
  for (const k of ['saleMode', 'tenancyStatus', 'tenure', 'agreementForm', 'isJodi', 'possessionStatus', 'furnishing']) {
    if (tags[k] !== undefined) statedTags[k] = tags[k];
  }
  return {
    id: d.id,
    code: d.code,
    personId: d.person_id,
    personCode: v.person?.code ?? null,
    clientDisplayName: v.person ? (v.person.initials ?? v.person.code) : null,
    dealTypes: d.deal_types,
    market: d.market,
    segment: d.segment,
    propertyTypes: d.property_types,
    micromarketIds: d.micromarket_ids,
    localities: d.localities,
    budgetInrMin: d.budget_inr_min,
    budgetInrMax: d.budget_inr_max,
    rentMonthlyInrMin: d.rent_monthly_inr_min,
    rentMonthlyInrMax: d.rent_monthly_inr_max,
    areaSqftMin: d.area_sqft_min,
    areaSqftMax: d.area_sqft_max,
    areaBasis: d.area_basis,
    bhkMin: d.bhk_min,
    bhkMax: d.bhk_max,
    moveInFrom: d.move_in_from,
    moveInBy: d.move_in_by,
    moveInText: d.move_in_text,
    statedTags,
    decisionMaker: d.decision_maker,
    introducingBrokerPersonId: d.introducing_broker_person_id,
    sharedCommissionNote: d.shared_commission_note,
    sharedCommissionPct: d.shared_commission_pct,
    ownerUserId: d.owner_user_id,
    companyName: d.company_name,
    micromarkets: v.micromarkets.map((m) => ({ id: m.id, name: m.name, level: m.level })),
    label: demandLabel(d.deal_types, d.market, d.segment),
    recordStage: d.record_stage,
    publicationLevel: d.publication_level,
    sourceType: d.source_type,
    captureMode: d.capture_mode,
    sideEvidence: d.side_evidence,
    needsReview: d.needs_review,
    reviewReason: d.review_reason,
    reviewReasonCode: reviewCode(d.review_reason_code),
    firstTouchId: d.first_touch_id,
    touchCount: d.touch_count,
    outsideLaunchArea: d.outside_launch_area,
    status: d.status === 'merged' ? 'merged' : 'active',
    mergedIntoId: d.merged_into_id,
    createdAt: d.created_at.toISOString(),
    updatedAt: d.updated_at.toISOString(),
    version: d.version,
  };
}

export function touchDto(t: TouchRow) {
  return {
    id: t.id,
    demandId: t.demand_id,
    sourceType: t.source_type,
    captureMode: t.capture_mode,
    sourceDetail: t.source_detail,
    occurredAt: t.occurred_at.toISOString(),
    isFirstTouch: t.is_first_touch,
    sourceAdId: t.source_ad_id,
    enquiryId: t.enquiry_id,
    referrerPersonId: t.referrer_person_id,
    uploadId: t.upload_id,
  };
}

export function personDto(v: PersonView) {
  const p = v.person;
  const deps = Array.isArray(p.dependencies) ? (p.dependencies as Record<string, unknown>[]) : [];
  return {
    id: p.id,
    code: p.code,
    displayName: p.name_initials ?? p.code,
    phonesMasked: v.phones.filter((x) => x.kind === 'phone').map((x) => maskPhone(x.phone_e164)),
    hasEmail: v.hasEmail,
    hasWhatsapp: v.phones.some((x) => x.kind === 'whatsapp'),
    companyName: p.company_name,
    partyType: p.party_type,
    participantRole: p.participant_role,
    flags: p.flags,
    dependencies: deps.map((d) => ({
      text: typeof d['text'] === 'string' ? d['text'] : '',
      offerId: (d['offerId'] as string | null | undefined) ?? null,
      demandId: (d['demandId'] as string | null | undefined) ?? null,
    })),
    linked: v.linked,
    status: p.status,
    mergedIntoId: p.merged_into_id,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
    version: p.version,
  };
}

export function enquiryDto(e: EnquiryRow) {
  return {
    id: e.id,
    code: e.code,
    personId: e.person_id,
    sourceExport: e.source_export,
    campaignRef: e.campaign_ref,
    formRef: e.form_ref,
    listingRef: e.listing_ref,
    offerId: e.offer_id,
    projectId: e.project_id,
    demandId: e.demand_id,
    touchId: e.touch_id,
    hasMessage: e.message !== null,
    receivedAt: e.received_at.toISOString(),
    uploadId: e.upload_id,
  };
}

export function sourceAdDto(v: SourceAdView) {
  const a = v.ad;
  return {
    id: a.id,
    code: a.code,
    externalRef: a.external_ref,
    sourceChannel: a.source_channel,
    sourceName: a.source_name,
    sourceEdition: a.source_edition,
    sourceSupplement: a.source_supplement,
    sourceDate: a.source_date,
    sourcePage: a.source_page,
    sourceFiles: a.source_files,
    sourceLanguage: a.source_language,
    ocrUsed: a.ocr_used,
    extractionConfidence: a.extraction_confidence,
    extractorNotes: a.extractor_notes,
    splitCount: a.split_count,
    children: v.children,
    hasRawText: a.raw_text !== null,
    createdAt: a.created_at.toISOString(),
  };
}

export function mergeCandidateDto(c: MergeCandidateRow, codes: Map<string, string>) {
  return {
    id: c.id,
    aggregateType: c.aggregate_type,
    leftId: c.left_id,
    leftCode: codes.get(c.left_id) ?? '',
    rightId: c.right_id,
    rightCode: c.right_id ? (codes.get(c.right_id) ?? null) : null,
    rightExternalRef: c.right_external_ref,
    reason: c.reason,
    score: c.score,
    evidence: (c.evidence ?? {}) as Record<string, unknown>,
    status: c.status,
    uploadId: c.upload_id,
    createdAt: c.created_at.toISOString(),
    resolvedBy: c.resolved_by,
    resolvedAt: iso(c.resolved_at),
  };
}

export function mergeDto(m: MergeRow) {
  return {
    id: m.id,
    aggregateType: m.aggregate_type,
    survivorId: m.survivor_id,
    mergedIds: m.merged_ids,
    status: m.status,
    source: m.source,
    movedCounts: m.moved_counts,
    performedBy: m.performed_by,
    performedAt: m.performed_at.toISOString(),
    undoneBy: m.undone_by,
    undoneAt: iso(m.undone_at),
  };
}

export function deskItemDto(d: DeskItemRow) {
  return {
    id: d.id,
    code: d.code,
    desk: d.desk,
    recordScope: d.record_scope,
    side: d.side,
    dealTypes: d.deal_types,
    sector: d.sector,
    includesProperty: d.includes_property,
    businessDescription: d.business_description_redacted,
    participantRole: null,
    signalType: d.signal_type,
    partyType: d.party_type,
    deadlineDate: d.deadline_date,
    linkedPropertyId: d.linked_property_id,
    personId: d.person_id,
    assigneeUserId: d.assignee_user_id,
    archived: d.archived_at !== null,
    outsideLaunchArea: d.outside_launch_area,
    createdAt: d.created_at.toISOString(),
    version: d.version,
  };
}

/** Network desk: people with a participant role projected into the DeskItem shape. */
export function networkItemDto(v: PersonView) {
  const p = v.person;
  return {
    id: p.id,
    code: p.code,
    desk: 'network',
    recordScope: 'Market Participant',
    side: 'None',
    dealTypes: [],
    sector: null,
    includesProperty: null,
    businessDescription: null,
    participantRole: p.participant_role,
    signalType: null,
    partyType: p.party_type,
    deadlineDate: null,
    linkedPropertyId: null,
    personId: p.id,
    assigneeUserId: null,
    archived: false,
    outsideLaunchArea: false,
    createdAt: p.created_at.toISOString(),
    version: p.version,
  };
}

export function marketDataDto(m: MarketDataRow) {
  return {
    id: m.id,
    propertyId: m.property_id,
    offerId: m.offer_id,
    dealId: m.deal_id,
    micromarketId: m.micromarket_id,
    locality: m.locality,
    dealType: m.deal_type,
    segment: m.segment,
    propertyType: m.property_type,
    priceInr: m.price_inr,
    rentMonthlyInr: m.rent_monthly_inr,
    areaSqft: m.area_sqft,
    areaBasis: m.area_basis,
    observedOn: m.observed_on,
    source: m.source,
    voided: m.voided_at !== null,
    notes: m.notes,
  };
}
