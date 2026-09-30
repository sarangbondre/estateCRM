// Supply records (REC-03): properties with 1–4 offers (one per deal type), property-level dedup (US-07),
// offers (US-13), record axis, photo selection, second sources and price gaps (A-39).
import { normalisePhone } from '../domain/phone.js';
import { askingPrice, floorBand, possessionDateStart } from '../domain/property.js';
import { rankProperties } from '../domain/dedup.js';
import type { PropertyDecision, PropertyFacts, PropertyScore } from '../domain/dedup.js';
import { RecordsError, notFound } from '../domain/errors.js';
import { LOCATION_UNCLEAR_REASON, launchAreaVerdict } from '../domain/launch-area.js';
import { MANAGER_ROLES, decideOfferStage } from '../domain/record-stage.js';
import { buildingNorm, norm } from '../domain/text.js';
import { assertRanges } from '../domain/vocabulary.js';
import type { Actor, App } from './context.js';
import { launchCitiesOf, micromarketIndexOf, vocabularyOf } from './context.js';
import { activeOfferIdsOf, bumpOffersUpdated, emitOffersCreated, emitPriceChanged, emitStageChanged } from './emit.js';
import { OFFER_FIELDS, PROPERTY_FIELDS, assertOfferDealType, changedColumns, mapFields, mergeEdited } from './fields.js';
import { mustFind } from './lookup.js';
import type { OfferRow, PropertyRow, SourceType } from './model.js';
import { createPerson, mergedError, touchPeople } from './people.js';
import type { PersonInput } from './people.js';
import type { Tx } from './ports.js';
import type { PropertyCandidateData } from './queries.js';

export type Dto = Record<string, unknown>;

export interface PartyInputDto {
  personId?: string | null | undefined;
  newPerson?: PersonInput | null | undefined;
  role: string;
}

// --- property facts ------------------------------------------------------------------------------------------

/** Derived columns: normalised copies, micromarket resolution, floor band, building key, outside flag (Z-7). */
export async function deriveProperty(
  app: App,
  tx: Tx,
  row: PropertyRow,
  options: { sourceEdition?: string | null; micromarketGiven?: boolean } = {},
): Promise<{ row: PropertyRow; locationUnclear: boolean }> {
  const tree = await micromarketIndexOf(app, tx);
  const cities = await launchCitiesOf(app, tx);
  let micromarketId = row.micromarket_id;
  if (micromarketId && !tree.byId(micromarketId)) {
    throw new RecordsError('validation-failed', 'unknown micromarket', { errors: [{ field: 'micromarketId', code: 'not-found' }] });
  }
  if (!options.micromarketGiven && row.locality) micromarketId = tree.resolve(row.locality)?.id ?? null;
  const node = micromarketId ? tree.byId(micromarketId) : undefined;
  const verdict = launchAreaVerdict(
    { city: row.city, sourceEdition: options.sourceEdition ?? null, resolvedInLaunchArea: node?.in_launch_area },
    cities,
  );
  const bNorm = buildingNorm(row.building_name);
  const localityNorm = norm(row.locality);
  const place = micromarketId ?? localityNorm ?? norm(row.city) ?? '';
  return {
    row: {
      ...row,
      locality_norm: localityNorm,
      city_norm: norm(row.city),
      micromarket_id: micromarketId,
      building_norm: bNorm,
      building_key: bNorm ? app.hash.building(tx.tenantId, bNorm, place) : null,
      floor_band: floorBand(row.floor_no, row.total_floors),
      outside_launch_area: verdict.outside,
    },
    locationUnclear: verdict.locationUnclear,
  };
}

export function emptyProperty(app: App, tx: Tx, code: string): PropertyRow {
  return {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    code,
    segment: null,
    property_types: [],
    property_detail: null,
    land_use: null,
    locality: null,
    locality_norm: null,
    micromarket_id: null,
    city: null,
    city_norm: null,
    state: null,
    landmark: null,
    location_text: null,
    building_name: null,
    building_norm: null,
    wing: null,
    unit_no: null,
    floor_no: null,
    floor_band: null,
    parking: null,
    building_key: null,
    total_floors: null,
    area_sqft_min: null,
    area_sqft_max: null,
    area_basis: null,
    land_area_value: null,
    land_area_unit: null,
    land_area_sqft: null,
    area_text: null,
    bhk_min: null,
    bhk_max: null,
    features: null,
    amenities: [],
    project_id: null,
    outside_launch_area: false,
    photo_count: 0,
    has_real_photos: false,
    staff_edited_fields: [],
    last_seen_at: null,
    status: 'active',
    merged_into_id: null,
    created_at: tx.now,
    updated_at: tx.now,
    version: 1,
  };
}

export function emptyOffer(app: App, tx: Tx, code: string, propertyId: string, dealType: string): OfferRow {
  return {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    code,
    property_id: propertyId,
    project_id: null,
    deal_type: dealType,
    market: null,
    sale_price_inr_min: null,
    sale_price_inr_max: null,
    sale_rate_inr: null,
    sale_rate_unit: null,
    rent_monthly_inr_min: null,
    rent_monthly_inr_max: null,
    deposit_inr: null,
    current_rent_inr: null,
    rent_rate_psf: null,
    yield_pct: null,
    deposit_months: null,
    price_negotiable: null,
    price_text: null,
    sale_mode: null,
    tenancy_status: null,
    tenure: null,
    agreement_form: null,
    possession_status: null,
    furnishing: null,
    deadline_date: null,
    is_jodi: null,
    possession_date: null,
    possession_date_start: null,
    description: null,
    revenue_share_text: null,
    revenue_share_pct: null,
    unit_count: null,
    record_stage: 'Captured',
    publication_level: 'Private',
    publication_version: 0,
    source_type: 'Direct',
    capture_mode: 'typed_in',
    side_evidence: null,
    needs_review: false,
    review_reason: null,
    review_reason_code: null,
    route_to_suggestion: null,
    sourced_for_demand_id: null,
    sourcing_request_id: null,
    owner_user_id: null,
    ingested_record_id: null,
    source_ad_id: null,
    first_seen_date: null,
    last_seen_at: null,
    times_seen: 1,
    enquiry_count: 0,
    sighting_count: 0,
    second_source_count: 0,
    has_price_gap: false,
    closed_at: null,
    retired_at: null,
    renewal_of_offer_id: null,
    retired_reason: null,
    staff_edited_fields: [],
    status: 'active',
    void_reason: null,
    merged_into_id: null,
    created_at: tx.now,
    updated_at: tx.now,
    version: 1,
  };
}

function propertyRanges(p: Dto, prefix = 'property/') {
  assertRanges([
    [`${prefix}areaSqft`, p['areaSqftMin'] as number | null, p['areaSqftMax'] as number | null],
    [`${prefix}bhk`, p['bhkMin'] as number | null, p['bhkMax'] as number | null],
  ]);
}

function offerRanges(o: Dto, prefix: string) {
  assertRanges([
    [`${prefix}salePriceInr`, o['salePriceInrMin'] as number | null, o['salePriceInrMax'] as number | null],
    [`${prefix}rentMonthlyInr`, o['rentMonthlyInrMin'] as number | null, o['rentMonthlyInrMax'] as number | null],
  ]);
}

/** Builds (not inserts) a new property from API input. */
export async function propertyFromInput(app: App, tx: Tx, input: Dto): Promise<{ row: PropertyRow; locationUnclear: boolean }> {
  propertyRanges(input);
  const vocab = await vocabularyOf(app, tx);
  const mapped = mapFields(input, PROPERTY_FIELDS, vocab, 'property/');
  const base = { ...emptyProperty(app, tx, await tx.codes.next('PRP', 5)), ...mapped } as PropertyRow;
  return deriveProperty(app, tx, base, { micromarketGiven: input['micromarketId'] !== undefined && input['micromarketId'] !== null });
}

/** Builds (not inserts) an offer on `propertyId` from API input. */
export async function offerFromInput(
  app: App,
  tx: Tx,
  propertyId: string,
  input: Dto,
  prefix: string,
  base: Partial<OfferRow> = {},
): Promise<OfferRow> {
  offerRanges(input, prefix);
  const vocab = await vocabularyOf(app, tx);
  const mapped = mapFields(input, OFFER_FIELDS, vocab, prefix);
  assertOfferDealType(mapped['deal_type'], mapped['market'], prefix);
  const offer = {
    ...emptyOffer(app, tx, await tx.codes.next('INV', 5), propertyId, mapped['deal_type'] as string),
    ...base,
    ...mapped,
  } as OfferRow;
  offer.possession_date_start = possessionDateStart(offer.possession_date);
  return offer;
}

// --- dedup ---------------------------------------------------------------------------------------------------

export function factsOf(p: PropertyRow, offers: readonly OfferRow[], phoneHashes: readonly string[]): PropertyFacts {
  const prices: Record<string, number | null> = {};
  for (const o of offers) prices[o.deal_type] = askingPrice(o);
  return {
    segment: p.segment,
    propertyTypes: p.property_types,
    buildingNorm: p.building_norm,
    micromarketId: p.micromarket_id,
    localityNorm: p.locality_norm,
    floorNo: p.floor_no,
    areaSqftMin: p.area_sqft_min,
    areaSqftMax: p.area_sqft_max,
    areaBasis: p.area_basis,
    bhkMin: p.bhk_min,
    bhkMax: p.bhk_max,
    prices,
    phoneHashes,
  };
}

export interface ScoredCandidate {
  data: PropertyCandidateData;
  score: PropertyScore;
  decision: PropertyDecision;
}

/** Candidates ≥ 0.60 for a (not yet stored) property, best first. */
export async function findPropertyDuplicates(
  tx: Tx,
  property: PropertyRow,
  offers: readonly OfferRow[],
  phoneHashes: readonly string[],
  filter: (c: PropertyCandidateData) => boolean = () => true,
): Promise<ScoredCandidate[]> {
  const found = (
    await tx.q.propertyCandidates({
      micromarketId: property.micromarket_id,
      localityNorm: property.locality_norm,
      buildingNorm: property.building_norm,
      segment: property.segment,
      areaSqftMin: property.area_sqft_min,
      areaSqftMax: property.area_sqft_max,
      excludeIds: [property.id],
    })
  ).filter(filter);
  const input = factsOf(property, offers, phoneHashes);
  const ranked = rankProperties(
    input,
    found.map((d) => ({ ...factsOf(d.property, d.offers, d.phoneHashes), data: d })),
  );
  return ranked
    .filter((r) => r.decision !== 'new')
    .map((r) => ({ data: r.candidate.data, score: r.score, decision: r.decision }));
}

export function duplicateError(candidates: ScoredCandidate[], present: (c: ScoredCandidate) => Dto) {
  return new RecordsError('duplicate-property-suspected', 'possible duplicates found; pick one or confirm a new property', {
    extensions: { candidates: candidates.slice(0, 10).map(present) },
  });
}

async function partyPhoneHashes(app: App, tx: Tx, parties: readonly PartyInputDto[]): Promise<string[]> {
  const hashes: string[] = [];
  for (const p of parties) {
    for (const raw of p.newPerson?.phones ?? []) {
      const e = normalisePhone(raw);
      if (e) hashes.push(app.hash.phone(tx.tenantId, e));
    }
    if (p.personId) {
      const phones = await tx.store.find('person_phones', { person_id: p.personId }, { limit: 20 });
      hashes.push(...phones.map((x) => x.phone_hash));
    }
  }
  return [...new Set(hashes)];
}

export async function linkParties(
  app: App,
  tx: Tx,
  subject: { type: 'property' | 'offer' | 'demand' | 'project' | 'desk_item'; id: string },
  parties: readonly PartyInputDto[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const p of parties) {
    let personId = p.personId ?? null;
    let partyType: string | null = null;
    if (personId) {
      const person = await tx.store.get('persons', personId);
      if (!person) throw new RecordsError('validation-failed', 'unknown person', { errors: [{ field: 'parties/personId', code: 'not-found' }] });
      if (person.status === 'merged') personId = person.merged_into_id;
      partyType = person.party_type;
    } else if (p.newPerson) {
      const r = await createPerson(app, tx, p.newPerson, { onExisting: 'reuse' });
      personId = r.person.id;
      partyType = r.person.party_type;
    }
    if (!personId) continue;
    await tx.store.insertIgnore('record_parties', {
      id: app.ids.next(),
      subject_type: subject.type,
      subject_id: subject.id,
      person_id: personId,
      role: p.role,
      party_type_at_capture: partyType,
    });
    ids.push(personId);
  }
  await touchPeople(tx, ids);
  return ids;
}

// --- use cases -----------------------------------------------------------------------------------------------

export interface CreatePropertyInput {
  property: Dto;
  offers: Dto[];
  parties?: PartyInputDto[] | undefined;
  sourceType?: SourceType | undefined;
  sourceDetail?: string | undefined;
  sideEvidence?: string | undefined;
  confirmNewDespiteCandidates?: boolean | undefined;
}

export interface SupplyResult {
  propertyId: string;
  offerIds: string[];
}

/**
 * Creates a property with its offers in the caller's transaction (manual entry, quick add, add supply).
 * Dedup first: candidates ≥ 0.60 → 409 duplicate-property-suspected unless confirmed.
 */
export async function createSupply(
  app: App,
  tx: Tx,
  actor: Actor,
  input: CreatePropertyInput,
  offerBase: Partial<OfferRow>,
  present: (c: ScoredCandidate) => Dto,
): Promise<SupplyResult> {
  const { row: property, locationUnclear } = await propertyFromInput(app, tx, input.property);
  const dealTypes = new Set<string>();
  const offers: OfferRow[] = [];
  for (const [i, o] of input.offers.entries()) {
    const offer = await offerFromInput(app, tx, property.id, o, `offers/${i}/`, {
      source_type: input.sourceType ?? 'Direct',
      capture_mode: 'typed_in',
      side_evidence: input.sideEvidence ?? null,
      owner_user_id: actor.role === 'Supply agent' ? actor.userId : null,
      ...(locationUnclear ? { needs_review: true, review_reason: LOCATION_UNCLEAR_REASON, review_reason_code: 'other' } : {}),
      ...offerBase,
    });
    if (dealTypes.has(offer.deal_type)) throw new RecordsError('deal-type-exists', `two offers with deal type ${offer.deal_type}`);
    dealTypes.add(offer.deal_type);
    offers.push(offer);
  }
  if (!input.confirmNewDespiteCandidates) {
    const hashes = await partyPhoneHashes(app, tx, input.parties ?? []);
    const dupes = await findPropertyDuplicates(tx, property, offers, hashes);
    if (dupes.length) throw duplicateError(dupes, present);
  }
  await tx.store.insert('properties', property);
  await tx.store.insert('offers', offers);
  await linkParties(app, tx, { type: 'property', id: property.id }, input.parties ?? []);
  await emitOffersCreated(tx, offers.map((o) => o.id));
  return { propertyId: property.id, offerIds: offers.map((o) => o.id) };
}

export async function createPropertyUseCase(
  app: App,
  actor: Actor,
  input: CreatePropertyInput,
  present: (c: ScoredCandidate) => Dto,
): Promise<SupplyResult> {
  return app.uow.run(actor, (tx) => createSupply(app, tx, actor, input, {}, present));
}

export async function checkDuplicates(
  app: App,
  actor: Actor,
  input: { property: Dto; phones?: string[] | undefined; dealType?: string | null | undefined },
): Promise<{ candidates: ScoredCandidate[]; decision: PropertyDecision }> {
  return app.uow.run(actor, async (tx) => {
    const { row } = await propertyFromInput(app, tx, input.property);
    const hashes = await partyPhoneHashes(app, tx, [{ role: 'Contact', newPerson: { phones: input.phones ?? [] } }]);
    const candidates = await findPropertyDuplicates(tx, row, [], hashes);
    return { candidates, decision: candidates[0]?.decision ?? 'new' };
  });
}

/** POST /v1/offers: a further offer on an existing property (one per deal type). */
export async function createOffer(
  app: App,
  actor: Actor,
  input: { propertyId: string; offer: Dto; recordStage?: string | undefined; sourceType?: SourceType | undefined },
): Promise<string> {
  return app.uow.run(actor, async (tx) => {
    const property = await tx.store.get('properties', input.propertyId, { lock: true });
    if (!property) throw notFound('property');
    if (property.status === 'merged') throw mergedError(property.merged_into_id);
    const offer = await offerFromInput(app, tx, property.id, input.offer, 'offer/', {
      source_type: input.sourceType ?? 'Direct',
      record_stage: input.recordStage ?? 'Captured',
      owner_user_id: actor.role === 'Supply agent' ? actor.userId : null,
    });
    const clash = await tx.store.find('offers', { property_id: property.id, deal_type: offer.deal_type, status: 'active', project_id: null }, { limit: 1 });
    if (clash.length) throw new RecordsError('deal-type-exists', `the property already has an active ${offer.deal_type} offer`);
    if (offer.record_stage === 'Verified' || offer.record_stage === 'Qualified') {
      decideOfferStage('Captured', offer.record_stage, actor.role, property.has_real_photos);
    }
    await tx.store.insert('offers', offer);
    await emitOffersCreated(tx, [offer.id]);
    return offer.id;
  });
}

export async function patchOffer(app: App, actor: Actor, idOrCode: string, patch: Dto, ifMatch: number | undefined): Promise<string> {
  return app.uow.run(actor, async (tx) => {
    const offer = await mustFind(tx, 'offers', idOrCode, { lock: true });
    if (offer.status === 'merged') throw mergedError(offer.merged_into_id);
    if (ifMatch !== undefined && ifMatch !== offer.version) throw new RecordsError('version-mismatch');
    if (patch['ownerUserId'] !== undefined && !MANAGER_ROLES.includes(actor.role)) {
      throw new RecordsError('forbidden', 'changing the owner needs Admin or Manager');
    }
    offerRanges({ ...offerPriceView(offer), ...patch }, '');
    const vocab = await vocabularyOf(app, tx);
    const mapped = mapFields(patch, OFFER_FIELDS, vocab);
    assertOfferDealType(offer.deal_type, mapped['market'] !== undefined ? mapped['market'] : offer.market, '');
    if (mapped['possession_date'] !== undefined) mapped['possession_date_start'] = possessionDateStart(mapped['possession_date'] as string | null);
    const changed = changedColumns(offer as unknown as Dto, mapped);
    if (!changed.length) return offer.id;
    await tx.store.update('offers', offer.id, {
      ...(mapped as Partial<OfferRow>),
      staff_edited_fields: mergeEdited(offer.staff_edited_fields, changed.filter((c) => c !== 'possession_date_start')),
    });
    await emitPriceChanged(tx, offer, 'edit');
    await bumpOffersUpdated(tx, [offer.id]);
    return offer.id;
  });
}

const offerPriceView = (o: OfferRow) => ({
  salePriceInrMin: o.sale_price_inr_min,
  salePriceInrMax: o.sale_price_inr_max,
  rentMonthlyInrMin: o.rent_monthly_inr_min,
  rentMonthlyInrMax: o.rent_monthly_inr_max,
});

export async function changeOfferStage(app: App, actor: Actor, idOrCode: string, to: string, ifMatch: number | undefined): Promise<string> {
  return app.uow.run(actor, async (tx) => {
    const offer = await mustFind(tx, 'offers', idOrCode, { lock: true });
    if (offer.status === 'merged') throw mergedError(offer.merged_into_id);
    if (ifMatch !== undefined && ifMatch !== offer.version) throw new RecordsError('version-mismatch');
    const property = await tx.store.get('properties', offer.property_id);
    const decision = decideOfferStage(offer.record_stage, to, actor.role, property?.has_real_photos ?? false);
    if (decision.kind === 'noop') return offer.id;
    await tx.store.update('offers', offer.id, { record_stage: to });
    await emitStageChanged(tx, offer.id, decision.from, decision.to, actor.userId, property?.has_real_photos ?? false);
    await bumpOffersUpdated(tx, [offer.id]);
    return offer.id;
  });
}

export async function putOfferPhotos(app: App, actor: Actor, idOrCode: string, photoIds: string[], ifMatch: number | undefined) {
  return app.uow.run(actor, async (tx) => {
    const offer = await mustFind(tx, 'offers', idOrCode, { lock: true });
    if (offer.status === 'merged') throw mergedError(offer.merged_into_id);
    if (ifMatch !== undefined && ifMatch !== offer.version) throw new RecordsError('version-mismatch');
    const ids = [...new Set(photoIds)];
    const photos = await tx.store.getMany('photos', ids);
    if (photos.length !== ids.length || photos.some((p) => p.property_id !== offer.property_id || p.status !== 'ready')) {
      throw new RecordsError('photo-not-on-property');
    }
    await tx.store.delete('offer_photos', { offer_id: offer.id });
    await tx.store.insert(
      'offer_photos',
      ids.map((photoId, sort) => ({ offer_id: offer.id, photo_id: photoId, sort })),
    );
    await bumpOffersUpdated(tx, [offer.id]);
    return offer.id;
  });
}

export async function patchProperty(app: App, actor: Actor, idOrCode: string, patch: Dto, ifMatch: number | undefined): Promise<string> {
  return app.uow.run(actor, async (tx) => {
    const property = await mustFind(tx, 'properties', idOrCode, { lock: true });
    if (property.status === 'merged') throw mergedError(property.merged_into_id);
    if (ifMatch !== undefined && ifMatch !== property.version) throw new RecordsError('version-mismatch');
    const vocab = await vocabularyOf(app, tx);
    const mapped = mapFields(patch, PROPERTY_FIELDS, vocab, '');
    const next = { ...property, ...mapped } as PropertyRow;
    propertyRanges(
      { areaSqftMin: next.area_sqft_min, areaSqftMax: next.area_sqft_max, bhkMin: next.bhk_min, bhkMax: next.bhk_max },
      '',
    );
    const changed = changedColumns(property as unknown as Dto, mapped);
    if (!changed.length) return property.id;
    const relocated = mapped['locality'] !== undefined || mapped['city'] !== undefined || mapped['micromarket_id'] !== undefined;
    const { row } = await deriveProperty(app, tx, next, {
      micromarketGiven: mapped['micromarket_id'] !== undefined ? mapped['micromarket_id'] !== null : !relocated,
    });
    const { id: _id, tenant_id: _t, created_at: _c, updated_at: _u, ...facts } = row;
    void [_id, _t, _c, _u];
    await tx.store.update('properties', property.id, {
      ...facts,
      staff_edited_fields: mergeEdited(property.staff_edited_fields, changed),
      version: property.version + 1,
    });
    await bumpOffersUpdated(tx, await activeOfferIdsOf(tx, [property.id]));
    return property.id;
  });
}

/** Accept a second source's price into the linked offer, or dismiss the gap (409 already-resolved). */
export async function resolveSecondSource(app: App, actor: Actor, id: string, action: 'accept_price' | 'dismiss'): Promise<string> {
  return app.uow.run(actor, async (tx) => {
    const src = await tx.store.get('second_sources', id, { lock: true });
    if (!src) throw notFound('second source');
    if (src.status !== 'open') throw new RecordsError('already-resolved');
    await tx.store.update('second_sources', id, {
      status: action === 'accept_price' ? 'accepted' : 'dismissed',
      resolved_by: actor.userId,
      resolved_at: tx.now,
    });
    if (src.offer_id) {
      const offer = await tx.store.get('offers', src.offer_id, { lock: true });
      if (offer && offer.status === 'active') {
        const open = await tx.store.find('second_sources', { offer_id: offer.id, status: 'open', price_gap: true }, { limit: 1 });
        const patch: Partial<OfferRow> = { has_price_gap: open.length > 0 };
        if (action === 'accept_price') {
          if (src.sale_price_inr_min !== null || src.sale_price_inr_max !== null) {
            patch.sale_price_inr_min = src.sale_price_inr_min;
            patch.sale_price_inr_max = src.sale_price_inr_max;
          }
          if (src.rent_monthly_inr_min !== null || src.rent_monthly_inr_max !== null) {
            patch.rent_monthly_inr_min = src.rent_monthly_inr_min;
            patch.rent_monthly_inr_max = src.rent_monthly_inr_max;
          }
        }
        if (changedColumns(offer as unknown as Dto, patch as Dto).length) {
          await tx.store.update('offers', offer.id, patch);
          if (action === 'accept_price') await emitPriceChanged(tx, offer, 'edit');
          await bumpOffersUpdated(tx, [offer.id]);
        }
      }
    }
    return id;
  });
}
