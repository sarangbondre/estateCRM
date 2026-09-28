// Ingestion of rows.classified.v1 (REC-05, records LLD §4.2–§4.8, US-01/US-07a, CR-006 Z-3/Z-4/Z-5/Z-8).
// Per batch: migration map first, rows fetched from intake with a service token (R-2), sub-transactions of 100 rows,
// idempotent upserts by external ref + content hash, staff edits win (§4.3), route by record_scope + side.
import { possessionDateStart } from '../domain/property.js';
import { LOCATION_UNCLEAR_REASON, launchAreaVerdict } from '../domain/launch-area.js';
import { routeRow, splitOfferPrices } from '../domain/routing.js';
import type { Route } from '../domain/routing.js';
import { DESK_PREFIX, CODE_PADS } from '../domain/codes.js';
import { normalisePhone } from '../domain/phone.js';
import { norm } from '../domain/text.js';
import { openPendingFor, raiseCandidate, emitRaised } from './candidates.js';
import type { Actor, App } from './context.js';
import { launchCitiesOf, micromarketIndexOf, systemActor } from './context.js';
import { addTouchTo, emptyDemand, insertDemand, matchDemand, raiseDemandCandidates } from './demands.js';
import { activeOfferIdsOf, agg, bumpDemandsUpdated, bumpOffersUpdated, emitOffersCreated, emitPriceChanged, emitProject } from './emit.js';
import { voidSubject } from './voiding.js';
import { mergeInTx } from './merges.js';
import type {
  DemandRow,
  DeskItemRow,
  IngestedRecordRow,
  OfferRow,
  PersonRow,
  PropertyRow,
  SourceAdRow,
  SubjectKind,
} from './model.js';
import { createPerson, touchPeople } from './people.js';
import { queueSheetPhotos } from './photos.js';
import type { IntakeRow, Tx } from './ports.js';
import { deriveProperty, emptyOffer, emptyProperty, findPropertyDuplicates } from './supply.js';
import { askingPrice, priceGapPct, PRICE_GAP_THRESHOLD_PCT } from '../domain/property.js';

const CHUNK = 100;
const TOUCH_TIMEOUT_MS = 30_000;

export interface RowsClassified {
  uploadId: string;
  batchNo: number;
  migrationApplied?: boolean | undefined;
}

export class IntakeUnavailableError extends Error {
  override readonly name = 'IntakeUnavailableError';
}

/**
 * Batch entry point (event handler). `alreadyApplied`/`markApplied` run in the drain transaction so the batch ledger
 * commits with processed_events; rows are applied in their own sub-transactions and are idempotent on replay.
 */
export async function ingestBatch(
  app: App,
  actor: Actor,
  event: RowsClassified,
  ledger: { alreadyApplied(): Promise<boolean>; markApplied(rows: number): Promise<void> },
): Promise<{ rows: number }> {
  if (await ledger.alreadyApplied()) return { rows: 0 };
  if (!app.intake) throw new IntakeUnavailableError('intake client is not configured (SERVICE_CREDENTIAL)');
  if (event.migrationApplied) await applyMigrationMap(app, actor, event.uploadId);
  const batch = await app.intake.batch(actor.tenantId, event.uploadId, event.batchNo, actor.correlationId);
  for (let i = 0; i < batch.rows.length; i += CHUNK) {
    const chunk = batch.rows.slice(i, i + CHUNK);
    await app.uow.run(actor, (tx) => applyRows(app, tx, chunk, { uploadId: event.uploadId, batchNo: event.batchNo }), {
      timeoutMs: TOUCH_TIMEOUT_MS,
    });
  }
  await ledger.markApplied(batch.rows.length);
  return { rows: batch.rows.length };
}

export interface BatchCtx {
  uploadId: string | null;
  batchNo: number;
  /** Review resolution re-creates a record for a known person (no contacts in the rebuilt row). */
  person?: PersonRow | null | undefined;
}

async function applyRows(app: App, tx: Tx, rows: readonly IntakeRow[], ctx: BatchCtx): Promise<void> {
  const known = new Map<string, IngestedRecordRow>();
  for (const source of ['extractor', 'upload'] as const) {
    const refs = rows.filter((r) => r.externalSource === source).map((r) => r.externalRef);
    for (const rec of await tx.store.findIn('ingested_records', 'external_ref', refs, { external_source: source })) {
      known.set(`${rec.external_source}:${rec.external_ref}`, rec);
    }
  }
  for (const row of rows) {
    const rec = known.get(`${row.externalSource}:${row.externalRef}`);
    if (rec && rec.content_hash === row.contentHash && rec.status === 'active') await seenAgain(app, tx, rec, row, ctx);
    else if (rec && rec.status === 'active') await updateFromRow(app, tx, rec, row, ctx);
    else if (!rec) await createFromRow(app, tx, row, ctx);
    // rekeyed / merged / split refs: the migration map already moved their CRM work; nothing to apply.
  }
}

// --- facts from a row ------------------------------------------------------------------------------------------

const PROPERTY_FROM_ROW: [keyof IntakeRow, keyof PropertyRow][] = [
  ['segment', 'segment'],
  ['propertyTypes', 'property_types'],
  ['propertyDetail', 'property_detail'],
  ['landUse', 'land_use'],
  ['locality', 'locality'],
  ['city', 'city'],
  ['state', 'state'],
  ['landmark', 'landmark'],
  ['locationText', 'location_text'],
  ['areaSqftMin', 'area_sqft_min'],
  ['areaSqftMax', 'area_sqft_max'],
  ['areaBasis', 'area_basis'],
  ['landAreaValue', 'land_area_value'],
  ['landAreaUnit', 'land_area_unit'],
  ['landAreaSqft', 'land_area_sqft'],
  ['areaText', 'area_text'],
  ['bhkMin', 'bhk_min'],
  ['bhkMax', 'bhk_max'],
  ['features', 'features'],
];

const OFFER_TAGS_FROM_ROW: [keyof IntakeRow, keyof OfferRow][] = [
  ['saleMode', 'sale_mode'],
  ['tenancyStatus', 'tenancy_status'],
  ['tenure', 'tenure'],
  ['agreementForm', 'agreement_form'],
  ['possessionStatus', 'possession_status'],
  ['possessionDate', 'possession_date'],
  ['furnishing', 'furnishing'],
  ['deadlineDate', 'deadline_date'],
  ['isJodi', 'is_jodi'],
  ['priceText', 'price_text'],
  ['priceNegotiable', 'price_negotiable'],
];

function propertyFacts(row: IntakeRow): Partial<PropertyRow> {
  const out: Record<string, unknown> = {};
  for (const [k, col] of PROPERTY_FROM_ROW) {
    const v = row[k];
    if (v !== undefined) out[col] = Array.isArray(v) ? v : (v ?? null);
  }
  out['property_types'] ??= [];
  return out as Partial<PropertyRow>;
}

function offerFacts(row: IntakeRow, dealType: string): Partial<OfferRow> {
  const out: Record<string, unknown> = {};
  for (const [k, col] of OFFER_TAGS_FROM_ROW) {
    const v = row[k];
    if (v !== undefined) out[col] = v ?? null;
  }
  const prices = splitOfferPrices([dealType], {
    market: row.market ?? null,
    salePriceInrMin: row.salePriceInrMin ?? null,
    salePriceInrMax: row.salePriceInrMax ?? null,
    saleRateInr: row.saleRateInr ?? null,
    saleRateUnit: row.saleRateUnit ?? null,
    rentMonthlyInrMin: row.rentMonthlyInrMin ?? null,
    rentMonthlyInrMax: row.rentMonthlyInrMax ?? null,
    rentRatePsf: row.rentRatePsf ?? null,
    depositInr: row.depositInr ?? null,
    depositMonths: row.depositMonths ?? null,
    currentRentInr: row.currentRentInr ?? null,
    yieldPct: row.yieldPct ?? null,
  })[0]?.prices;
  if (prices) {
    Object.assign(out, {
      market: prices.market,
      sale_price_inr_min: prices.salePriceInrMin,
      sale_price_inr_max: prices.salePriceInrMax,
      sale_rate_inr: prices.saleRateInr,
      sale_rate_unit: prices.saleRateUnit,
      rent_monthly_inr_min: prices.rentMonthlyInrMin,
      rent_monthly_inr_max: prices.rentMonthlyInrMax,
      rent_rate_psf: prices.rentRatePsf,
      deposit_inr: prices.depositInr,
      deposit_months: prices.depositMonths,
      current_rent_inr: prices.currentRentInr,
      yield_pct: prices.yieldPct,
    });
  }
  out['possession_date_start'] = possessionDateStart((out['possession_date'] as string | null | undefined) ?? null);
  return out as Partial<OfferRow>;
}

const reviewOf = (row: IntakeRow) => ({
  needs_review: row.needsReview,
  review_reason: row.reviewReason ?? null,
  review_reason_code: row.reviewReasonCode ?? null,
});

const seenAt = (row: IntakeRow, now: Date) => (row.lastSeenDate ? new Date(`${row.lastSeenDate}T00:00:00Z`) : now);
const seenOn = (row: IntakeRow, now: Date) => row.lastSeenDate ?? row.sourceDate ?? now.toISOString().slice(0, 10);

/** Drops staff-edited columns from an extractor update (CRM work wins, §4.3). */
function withoutStaffEdits<T extends Record<string, unknown>>(patch: T, edited: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (!edited.includes(k)) out[k] = v;
  return out as Partial<T>;
}

// --- shared pieces --------------------------------------------------------------------------------------------

async function contactPerson(app: App, tx: Tx, row: IntakeRow, ctx?: BatchCtx): Promise<PersonRow | null> {
  if (ctx?.person !== undefined) return ctx.person;
  const phones = (row.phones ?? []).filter((p) => normalisePhone(p));
  if (!phones.length && !row.whatsappPhone && !(row.emails ?? []).length && !row.contactName) return null;
  const r = await createPerson(
    app,
    tx,
    {
      name: row.contactName ?? null,
      phones,
      whatsappPhone: row.whatsappPhone && normalisePhone(row.whatsappPhone) ? row.whatsappPhone : null,
      emails: row.emails ?? [],
      otherContact: row.otherContact ?? null,
      companyName: row.companyName ?? null,
      partyType: row.partyType ?? null,
      participantRole: row.participantRole ?? null,
    },
    { onExisting: 'reuse', strictPhones: false },
  );
  return r.person;
}

/** One source ad per parent ref (Z-3); split children bump its split_count. */
async function sourceAdFor(app: App, tx: Tx, row: IntakeRow, isNewRef: boolean): Promise<SourceAdRow> {
  const ref = row.parentExternalRef ?? row.externalRef;
  const [existing] = await tx.store.find('source_ads', { external_ref: ref }, { limit: 1, lock: true });
  if (existing) {
    if (isNewRef && row.parentExternalRef) await tx.store.update('source_ads', existing.id, { split_count: existing.split_count + 1 });
    return existing;
  }
  const sender = row.senderPhone ? normalisePhone(row.senderPhone) : null;
  const ad: SourceAdRow = {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    code: await tx.codes.next('AD', CODE_PADS.AD),
    external_ref: ref,
    source_channel: row.sourceChannel ?? null,
    source_name: row.sourceName ?? null,
    source_edition: row.sourceEdition ?? null,
    source_supplement: row.sourceSupplement ?? null,
    source_files: row.sourceFiles ?? null,
    source_language: row.sourceLanguage ?? null,
    source_date: row.sourceDate ?? null,
    source_page: row.sourcePage ?? null,
    ocr_used: row.ocrUsed ?? null,
    extraction_confidence: row.extractionConfidence ?? null,
    extractor_notes: row.extractorNotes ?? null,
    raw_text: row.rawText ?? null,
    text_variants: row.textVariants ?? null,
    sender_name: row.senderName ?? null,
    sender_phone: sender,
    sender_phone_hash: sender ? app.hash.phone(tx.tenantId, sender) : null,
    split_count: row.parentExternalRef ? 1 : 0,
    purged_at: null,
    created_at: tx.now,
    updated_at: tx.now,
  };
  await tx.store.insert('source_ads', ad);
  return ad;
}

async function sighting(
  app: App,
  tx: Tx,
  subject: { type: 'offer' | 'demand' | 'property' | 'person' | 'desk_item'; id: string },
  row: IntakeRow,
  ad: { id: string } | null,
  ctx: BatchCtx,
): Promise<boolean> {
  return tx.store.insertIgnore('sightings', {
    id: app.ids.next(),
    subject_type: subject.type,
    subject_id: subject.id,
    source_ad_id: ad?.id ?? null,
    upload_id: ctx.uploadId,
    row_id: row.rowId,
    external_ref: row.externalRef,
    split_index: row.splitIndex ?? null,
    source_type: row.sourceType,
    source_name: row.sourceName ?? null,
    seen_on: seenOn(row, tx.now),
  });
}

async function recordIngested(
  app: App,
  tx: Tx,
  row: IntakeRow,
  ctx: BatchCtx,
  subject: { type: SubjectKind; id: string | null; propertyId?: string | null; deskItemId?: string | null; sourceAdId?: string | null },
): Promise<IngestedRecordRow> {
  const rec: IngestedRecordRow = {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    external_source: row.externalSource,
    external_ref: row.externalRef,
    parent_external_ref: row.parentExternalRef ?? null,
    split_index: row.splitIndex ?? null,
    record_scope: row.recordScope ?? null,
    source_channel: row.sourceChannel ?? null,
    content_hash: row.contentHash,
    primary_subject_type: subject.type,
    primary_subject_id: subject.id,
    property_id: subject.propertyId ?? null,
    desk_item_id: subject.deskItemId ?? null,
    source_ad_id: subject.sourceAdId ?? null,
    status: 'active',
    replaced_by_refs: null,
    last_upload_id: ctx.uploadId,
    last_row_id: row.rowId,
    created_at: tx.now,
    updated_at: tx.now,
  };
  await tx.store.insert('ingested_records', rec);
  // A pending possible_repeat that targeted this ref opens now (Z-4).
  if (subject.id && (subject.type === 'offer' || subject.type === 'demand')) {
    await openPendingFor(tx, row.externalRef, { type: subject.type, id: subject.id });
  }
  return rec;
}

/** possible_repeat_of (Z-4): a candidate between the two primary subjects, pending until the target arrives. */
async function possibleRepeat(app: App, tx: Tx, row: IntakeRow, subject: { type: 'offer' | 'demand'; id: string }, ctx: BatchCtx) {
  if (!row.possibleRepeatOf) return;
  const [target] = await tx.store.find(
    'ingested_records',
    { external_source: row.externalSource, external_ref: row.possibleRepeatOf },
    { limit: 1 },
  );
  if (target?.primary_subject_type && target.primary_subject_type !== subject.type) return;
  await raiseCandidate(app, tx, {
    aggregateType: subject.type,
    leftId: subject.id,
    rightId: target?.primary_subject_id ?? null,
    rightExternalRef: target ? null : row.possibleRepeatOf,
    reason: 'possible_repeat',
    score: 1,
    evidence: { possibleRepeatOf: true },
    uploadId: ctx.uploadId,
  });
}

async function enquiryFor(
  app: App,
  tx: Tx,
  row: IntakeRow,
  ctx: BatchCtx,
  link: { personId: string | null; offerId?: string | null; demandId?: string | null; touchId?: string | null },
) {
  if (!row.campaignRef && !row.formRef && !row.listingRef && !row.projectRef && !row.enquiryMessage) return;
  let projectId: string | null = null;
  if (row.projectRef) {
    const byCode = /^PRJ-\d+$/.test(row.projectRef) ? await tx.store.getByCode('projects', row.projectRef) : undefined;
    const byName = byCode ? [] : await tx.store.find('projects', { name_norm: norm(row.projectRef) ?? '' }, { limit: 1 });
    projectId = byCode?.id ?? byName[0]?.id ?? null;
  }
  const id = app.ids.next();
  const inserted = await tx.store.insertIgnore('enquiries', {
    id,
    code: await tx.codes.next('ENQ', CODE_PADS.ENQ),
    person_id: link.personId,
    source_export: row.sourceName ?? null,
    campaign_ref: row.campaignRef ?? null,
    form_ref: row.formRef ?? null,
    listing_ref: row.listingRef ?? null,
    offer_id: link.offerId ?? null,
    project_id: projectId,
    demand_id: link.demandId ?? null,
    touch_id: link.touchId ?? null,
    message: row.enquiryMessage ?? null,
    received_at: row.enquiryReceivedAt ? new Date(row.enquiryReceivedAt) : tx.now,
    upload_id: ctx.uploadId,
    row_id: row.rowId,
  });
  if (!inserted) return;
  if (link.offerId) {
    const o = await tx.store.get('offers', link.offerId);
    if (o) await tx.store.update('offers', o.id, { enquiry_count: o.enquiry_count + 1 });
  }
  await tx.events.emit('enquiry.received.v1', agg('enquiry', id, 1), {
    enquiryId: id,
    code: (await tx.store.get('enquiries', id))?.code ?? '',
    ...(link.offerId ? { offerId: link.offerId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(row.campaignRef ? { campaignRef: row.campaignRef } : {}),
    ...(link.demandId ? { demandId: link.demandId } : {}),
    receivedAt: (row.enquiryReceivedAt ? new Date(row.enquiryReceivedAt) : tx.now).toISOString(),
  });
}

// --- new refs --------------------------------------------------------------------------------------------------

export async function createFromRow(app: App, tx: Tx, row: IntakeRow, ctx: BatchCtx): Promise<void> {
  const route = routeRow({ recordScope: row.recordScope, side: row.side, includesProperty: row.includesProperty });
  switch (route.kind) {
    case 'supply':
      await createSupplyFromRow(app, tx, row, ctx);
      return;
    case 'demand':
      await createDemandFromRow(app, tx, row, ctx);
      return;
    case 'desk':
      await createDeskFromRow(app, tx, row, ctx, route);
      return;
    case 'network':
      await createNetworkFromRow(app, tx, row, ctx);
      return;
    case 'unrouted':
      await holdUnrouted(app, tx, row, ctx);
      return;
  }
}

async function holdUnrouted(app: App, tx: Tx, row: IntakeRow, ctx: BatchCtx) {
  await tx.store.insertIgnore('unrouted_rows', {
    id: app.ids.next(),
    external_source: row.externalSource,
    external_ref: row.externalRef,
    upload_id: ctx.uploadId,
    batch_no: ctx.batchNo,
    row_id: row.rowId,
    row_snapshot: row,
    status: 'waiting',
    routed_at: null,
  });
  await recordIngested(app, tx, row, ctx, { type: 'unrouted', id: null });
}

/** Builds and derives the property of a supply row (not inserted). */
async function propertyOfRow(app: App, tx: Tx, row: IntakeRow) {
  const base = { ...emptyProperty(app, tx, await tx.codes.next('PRP', CODE_PADS.PRP)), ...propertyFacts(row) } as PropertyRow;
  base.last_seen_at = seenAt(row, tx.now);
  return deriveProperty(app, tx, base, { sourceEdition: row.sourceEdition ?? null });
}

async function offersOfRow(
  app: App,
  tx: Tx,
  row: IntakeRow,
  propertyId: string,
  dealTypes: readonly string[],
  extra: Partial<OfferRow>,
): Promise<OfferRow[]> {
  const out: OfferRow[] = [];
  for (const { dealType } of splitOfferPrices(dealTypes, {
    market: null,
    salePriceInrMin: null,
    salePriceInrMax: null,
    saleRateInr: null,
    saleRateUnit: null,
    rentMonthlyInrMin: null,
    rentMonthlyInrMax: null,
    rentRatePsf: null,
    depositInr: null,
    depositMonths: null,
    currentRentInr: null,
    yieldPct: null,
  })) {
    out.push({
      ...emptyOffer(app, tx, await tx.codes.next('INV', CODE_PADS.INV), propertyId, dealType),
      ...offerFacts(row, dealType),
      // R-10: ingested records start at Enriched.
      record_stage: 'Enriched',
      source_type: row.sourceType,
      capture_mode: 'uploaded',
      side_evidence: row.sideEvidence ?? null,
      ...reviewOf(row),
      route_to_suggestion: row.routeTo ?? null,
      first_seen_date: row.firstSeenDate ?? null,
      last_seen_at: seenAt(row, tx.now),
      times_seen: row.timesSeen ?? 1,
      sighting_count: 1,
      ...extra,
    } as OfferRow);
  }
  return out;
}

/** Project + configuration offer when project_name and market Primary (LLD §4.2). */
async function projectOfRow(app: App, tx: Tx, row: IntakeRow, property: PropertyRow): Promise<{ id: string } | null> {
  if (!row.projectName || row.market !== 'Primary') return null;
  const nameNorm = norm(row.projectName) ?? '';
  await tx.advisoryLock(`project:${nameNorm}`);
  const [existing] = await tx.store.find('projects', { name_norm: nameNorm, micromarket_id: property.micromarket_id }, { limit: 1 });
  if (existing) return existing;
  const id = app.ids.next();
  await tx.store.insert('projects', {
    id,
    code: await tx.codes.next('PRJ', CODE_PADS.PRJ),
    name: row.projectName,
    name_norm: nameNorm,
    developer_person_id: null,
    developer_name: row.developerName ?? null,
    locality: property.locality,
    locality_norm: property.locality_norm,
    city: property.city,
    city_norm: property.city_norm,
    state: property.state,
    landmark: property.landmark,
    location_text: property.location_text,
    micromarket_id: property.micromarket_id,
    rera_number: row.reraNumber ?? null,
    possession_date: row.possessionDate ?? null,
    amenities: [],
    floor_plan_photo_ids: [],
    latest_price_sheet_date: null,
    publication_level: 'Private',
    publication_version: 0,
    outside_launch_area: property.outside_launch_area,
    staff_edited_fields: [],
    version: 1,
  });
  await emitProject(tx, 'project.created.v1', id);
  return { id };
}

const PARTY_ROLE: Record<string, string> = { Sale: 'Seller', Lease: 'Landlord', JV: 'Landowner', Pagdi: 'Seller' };

async function linkPerson(app: App, tx: Tx, subject: { type: 'property' | 'demand' | 'desk_item'; id: string }, person: PersonRow | null, role: string) {
  if (!person) return;
  await tx.store.insertIgnore('record_parties', {
    id: app.ids.next(),
    subject_type: subject.type,
    subject_id: subject.id,
    person_id: person.id,
    role: person.party_type === 'Broker' ? 'Broker' : role,
    party_type_at_capture: person.party_type,
  });
}

async function createSupplyFromRow(app: App, tx: Tx, row: IntakeRow, ctx: BatchCtx) {
  const ad = await sourceAdFor(app, tx, row, true);
  const person = await contactPerson(app, tx, row, ctx);
  const { row: property, locationUnclear } = await propertyOfRow(app, tx, row);
  const dealTypes = row.dealTypes?.length ? row.dealTypes : [];
  const review = locationUnclear && !row.needsReview ? { needs_review: true, review_reason: LOCATION_UNCLEAR_REASON, review_reason_code: 'other' } : {};
  const draftOffers = await offersOfRow(app, tx, row, property.id, dealTypes, { source_ad_id: ad.id, ...review });
  const phoneHashes = person ? (await tx.store.find('person_phones', { person_id: person.id }, { limit: 10 })).map((p) => p.phone_hash) : [];

  // Dedup (§4.4): split siblings are never candidates; extractor rows trust their own channel's dedup (Z-4).
  const dupes = await findPropertyDuplicates(tx, property, draftOffers, phoneHashes, (c) =>
    !c.lineage.some(
      (l) =>
        (row.parentExternalRef && l.parentExternalRef === row.parentExternalRef) ||
        (row.externalSource === 'extractor' && l.externalSource === 'extractor' && (l.sourceChannel ?? null) === (row.sourceChannel ?? null)),
    ),
  );
  const best = dupes[0];
  if (best?.decision === 'same_property') {
    await attachToExisting(app, tx, row, ctx, best.data.property, draftOffers, person, ad);
    return;
  }
  const project = await projectOfRow(app, tx, row, property);
  if (project) property.project_id = project.id;
  await tx.store.insert('properties', property);
  const offers = draftOffers.map((o) => ({ ...o, project_id: project?.id ?? null }));
  await tx.store.insert('offers', offers);
  await linkPerson(app, tx, { type: 'property', id: property.id }, person, PARTY_ROLE[dealTypes[0] ?? 'Sale'] ?? 'Contact');
  for (const o of offers) await sighting(app, tx, { type: 'offer', id: o.id }, row, ad, ctx);
  const rec = await recordIngested(app, tx, row, ctx, {
    type: offers.length ? 'offer' : 'unrouted',
    id: offers[0]?.id ?? null,
    propertyId: property.id,
    sourceAdId: ad.id,
  });
  await tx.store.updateWhere('offers', { property_id: property.id }, { ingested_record_id: rec.id });
  if (row.photoUrls?.length) await queueSheetPhotos(app, tx, property.id, row.photoUrls);
  await emitOffersCreated(tx, offers.map((o) => o.id));
  if (best?.decision === 'uncertain') {
    await raiseCandidate(app, tx, {
      aggregateType: 'property',
      leftId: property.id,
      rightId: best.data.property.id,
      reason: 'property_match',
      score: best.score.score,
      evidence: { score: best.score.score, reasons: best.score.reasons },
      uploadId: ctx.uploadId,
    });
  }
  if (offers[0]) {
    await possibleRepeat(app, tx, row, { type: 'offer', id: offers[0].id }, ctx);
    await enquiryFor(app, tx, row, ctx, { personId: person?.id ?? null, offerId: offers[0].id });
  }
}

/**
 * Same property (≥ 0.85 with a building): a repost by the same person and deal is a sighting; another source is a
 * second source (price gap > 5%, A-39); a new deal type is a new offer on the existing property.
 */
async function attachToExisting(
  app: App,
  tx: Tx,
  row: IntakeRow,
  ctx: BatchCtx,
  property: PropertyRow,
  drafts: OfferRow[],
  person: PersonRow | null,
  ad: SourceAdRow,
) {
  const existing = await tx.store.find('offers', { property_id: property.id, status: 'active' }, { limit: 100 });
  const parties = await tx.store.find('record_parties', { subject_type: 'property', subject_id: property.id }, { limit: 100 });
  const samePerson = person !== null && parties.some((p) => p.person_id === person.id);
  const created: OfferRow[] = [];
  let primary: string | null = null;
  for (const draft of drafts) {
    const match = existing.find((o) => o.deal_type === draft.deal_type && o.project_id === null);
    if (!match) {
      created.push({ ...draft, property_id: property.id });
      continue;
    }
    primary ??= match.id;
    const inserted = await sighting(app, tx, { type: 'offer', id: match.id }, row, ad, ctx);
    const patch: Partial<OfferRow> = {
      last_seen_at: new Date(Math.max(match.last_seen_at?.getTime() ?? 0, seenAt(row, tx.now).getTime())),
      times_seen: match.times_seen + (inserted ? 1 : 0),
      sighting_count: match.sighting_count + (inserted ? 1 : 0),
    };
    if (!samePerson) {
      const theirs = askingPrice({ ...match, ...draft, deal_type: draft.deal_type });
      const gap = priceGapPct(askingPrice(match), theirs);
      const isGap = gap !== null && gap > PRICE_GAP_THRESHOLD_PCT;
      const sourceId = app.ids.next();
      const added = await tx.store.insertIgnore('second_sources', {
        id: sourceId,
        property_id: property.id,
        offer_id: match.id,
        source_ad_id: ad.id,
        person_id: person?.id ?? null,
        source_type: row.sourceType,
        source_name: row.sourceName ?? null,
        sale_price_inr_min: draft.sale_price_inr_min,
        sale_price_inr_max: draft.sale_price_inr_max,
        rent_monthly_inr_min: draft.rent_monthly_inr_min,
        rent_monthly_inr_max: draft.rent_monthly_inr_max,
        price_gap_pct: gap,
        price_gap: isGap,
        status: 'open',
        seen_on: seenOn(row, tx.now),
        resolved_by: null,
        resolved_at: null,
      });
      if (added) {
        patch.second_source_count = match.second_source_count + 1;
        if (isGap) {
          patch.has_price_gap = true;
          await emitRaised(tx, sourceId, 'price_gap', 'offer');
        }
      }
    }
    await tx.store.update('offers', match.id, patch);
  }
  if (created.length) {
    await tx.store.insert('offers', created);
    for (const o of created) await sighting(app, tx, { type: 'offer', id: o.id }, row, ad, ctx);
  }
  await linkPerson(app, tx, { type: 'property', id: property.id }, person, PARTY_ROLE[drafts[0]?.deal_type ?? 'Sale'] ?? 'Contact');
  await tx.store.update('properties', property.id, { last_seen_at: seenAt(row, tx.now) });
  const rec = await recordIngested(app, tx, row, ctx, {
    type: 'offer',
    id: primary ?? created[0]?.id ?? null,
    propertyId: property.id,
    sourceAdId: ad.id,
  });
  for (const o of created) await tx.store.update('offers', o.id, { ingested_record_id: rec.id });
  await emitOffersCreated(tx, created.map((o) => o.id));
  await touchPeople(tx, [person?.id]);
}

/** Demand rows: the budget is the row's sale price, the rent its rent fields (Appendix C, one price set per row). */
async function demandOfRow(app: App, tx: Tx, row: IntakeRow, person: PersonRow | null): Promise<DemandRow> {
  const tree = await micromarketIndexOf(app, tx);
  const cities = await launchCitiesOf(app, tx);
  const node = row.locality ? tree.resolve(row.locality) : undefined;
  const verdict = launchAreaVerdict({ city: row.city ?? null, sourceEdition: row.sourceEdition ?? null, resolvedInLaunchArea: node?.in_launch_area }, cities);
  const d = emptyDemand(app, tx, await tx.codes.next('DEM', CODE_PADS.DEM));
  const tags: Record<string, unknown> = {};
  for (const [k, col] of [
    ['saleMode', 'saleMode'],
    ['tenancyStatus', 'tenancyStatus'],
    ['tenure', 'tenure'],
    ['agreementForm', 'agreementForm'],
    ['possessionStatus', 'possessionStatus'],
    ['furnishing', 'furnishing'],
    ['isJodi', 'isJodi'],
  ] as const) {
    const v = row[k];
    if (v !== null && v !== undefined) tags[col] = v;
  }
  return {
    ...d,
    person_id: person?.id ?? null,
    company_name: row.companyName ?? person?.company_name ?? null,
    company_norm: norm(row.companyName ?? person?.company_name ?? null),
    deal_types: row.dealTypes ?? [],
    market: row.market ?? null,
    segment: row.segment ?? null,
    property_types: row.propertyTypes ?? [],
    micromarket_ids: node ? [node.id] : [],
    localities: row.locality ? [row.locality] : [],
    budget_inr_min: row.salePriceInrMin ?? null,
    budget_inr_max: row.salePriceInrMax ?? null,
    rent_monthly_inr_min: row.rentMonthlyInrMin ?? null,
    rent_monthly_inr_max: row.rentMonthlyInrMax ?? null,
    area_sqft_min: row.areaSqftMin ?? null,
    area_sqft_max: row.areaSqftMax ?? null,
    area_basis: row.areaBasis ?? null,
    bhk_min: row.bhkMin ?? null,
    bhk_max: row.bhkMax ?? null,
    stated_tags: tags,
    record_stage: 'Enriched',
    source_type: row.sourceType,
    capture_mode: 'uploaded',
    side_evidence: row.sideEvidence ?? null,
    ...reviewOf(row),
    ...(verdict.locationUnclear && !row.needsReview ? { needs_review: true, review_reason: LOCATION_UNCLEAR_REASON, review_reason_code: 'other' } : {}),
    outside_launch_area: verdict.outside,
    last_seen_at: seenAt(row, tx.now),
  };
}

async function createDemandFromRow(app: App, tx: Tx, row: IntakeRow, ctx: BatchCtx) {
  const ad = await sourceAdFor(app, tx, row, true);
  const person = await contactPerson(app, tx, row, ctx);
  const draft = await demandOfRow(app, tx, row, person);
  draft.source_ad_id = ad.id;
  const source = {
    sourceType: row.sourceType,
    captureMode: 'uploaded' as const,
    sourceDetail: row.sourceName ?? null,
    occurredAt: seenAt(row, tx.now),
    sourceAdId: ad.id,
    uploadId: ctx.uploadId,
    rowId: row.rowId,
  };
  const match = await matchDemand(tx, draft);
  let demandId: string;
  let touchId: string | null;
  if (match.decision === 'touch' && match.best) {
    const touch = await addTouchTo(app, tx, match.best, source);
    demandId = match.best.id;
    touchId = touch?.id ?? null;
  } else {
    const touch = await insertDemand(app, tx, draft, source);
    demandId = draft.id;
    touchId = touch.id;
    await raiseDemandCandidates(app, tx, draft.id, match.similar, ctx.uploadId);
  }
  await sighting(app, tx, { type: 'demand', id: demandId }, row, ad, ctx);
  const rec = await recordIngested(app, tx, row, ctx, { type: 'demand', id: demandId, sourceAdId: ad.id });
  if (match.decision !== 'touch') await tx.store.update('demands', demandId, { ingested_record_id: rec.id });
  await possibleRepeat(app, tx, row, { type: 'demand', id: demandId }, ctx);
  await enquiryFor(app, tx, row, ctx, { personId: person?.id ?? null, demandId, touchId });
}

async function createDeskFromRow(app: App, tx: Tx, row: IntakeRow, ctx: BatchCtx, route: Extract<Route, { kind: 'desk' }>) {
  const ad = await sourceAdFor(app, tx, row, true);
  const person = await contactPerson(app, tx, row, ctx);
  const cities = await launchCitiesOf(app, tx);
  let linkedPropertyId: string | null = null;
  if (route.withProperty) {
    // D-14: a business that includes property also creates the property and its offers.
    const { row: property } = await propertyOfRow(app, tx, row);
    const offers = await offersOfRow(app, tx, row, property.id, (row.dealTypes ?? []).filter((d) => ['Sale', 'Lease', 'JV', 'Pagdi'].includes(d)), {
      source_ad_id: ad.id,
    });
    await tx.store.insert('properties', property);
    await tx.store.insert('offers', offers);
    await linkPerson(app, tx, { type: 'property', id: property.id }, person, 'Contact');
    await emitOffersCreated(tx, offers.map((o) => o.id));
    linkedPropertyId = property.id;
  }
  const description = row.businessDescription ?? null;
  const item: DeskItemRow = {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    code: await tx.codes.next(DESK_PREFIX[route.desk], CODE_PADS[DESK_PREFIX[route.desk]]),
    desk: route.desk,
    record_scope: row.recordScope ?? 'Business',
    side: row.side ?? null,
    deal_types: row.dealTypes ?? [],
    sector: row.sector ?? null,
    includes_property: row.includesProperty ?? null,
    signal_type: row.signalType ?? null,
    party_type: row.partyType ?? null,
    business_description: description,
    business_description_redacted: description ? app.redactor.redact(description) : null,
    deadline_date: row.deadlineDate ?? null,
    linked_property_id: linkedPropertyId,
    person_id: person?.id ?? null,
    assignee_user_id: null,
    archived_at: null,
    note: null,
    outside_launch_area: row.city ? launchAreaVerdict({ city: row.city }, cities).outside : false,
    ingested_record_id: null,
    staff_edited_fields: [],
    status: 'active',
    created_at: tx.now,
    updated_at: tx.now,
    version: 1,
  };
  const rec = await recordIngested(app, tx, row, ctx, { type: 'desk_item', id: item.id, deskItemId: item.id, propertyId: linkedPropertyId, sourceAdId: ad.id });
  await tx.store.insert('desk_items', { ...item, ingested_record_id: rec.id });
  await sighting(app, tx, { type: 'desk_item', id: item.id }, row, ad, ctx);
  if (route.desk === 'watchlist') {
    await tx.events.emit('watchlist_item.created.v1', agg('watchlist_item', item.id, 1), {
      watchlistItemId: item.id,
      code: item.code,
      signalType: item.signal_type ?? 'Other',
      ...(item.deadline_date ? { deadlineDate: item.deadline_date } : {}),
    });
  } else {
    await tx.events.emit('desk_item.created.v1', agg('desk_item', item.id, 1), {
      deskItemId: item.id,
      code: item.code,
      recordScope: item.record_scope,
      ...(item.deal_types.length ? { dealTypes: item.deal_types } : {}),
      ...(item.side ? { side: item.side } : {}),
      ...(item.sector ? { sector: item.sector } : {}),
      ...(linkedPropertyId ? { linkedPropertyId } : {}),
    });
  }
}

/** Market Participant (Network desk = people with a participant role; G-R13: deskItemId = person id). */
async function createNetworkFromRow(app: App, tx: Tx, row: IntakeRow, ctx: BatchCtx) {
  const ad = await sourceAdFor(app, tx, row, true);
  let person = await contactPerson(app, tx, row, ctx);
  if (!person) {
    person = (
      await createPerson(app, tx, { name: row.contactName ?? row.companyName ?? null, companyName: row.companyName ?? null, participantRole: row.participantRole ?? null, partyType: row.partyType ?? null }, { onExisting: 'reuse', strictPhones: false })
    ).person;
  }
  if (!person.participant_role && row.participantRole) {
    await tx.store.update('persons', person.id, { participant_role: row.participantRole, version: person.version + 1 });
  }
  await sighting(app, tx, { type: 'person', id: person.id }, row, ad, ctx);
  await recordIngested(app, tx, row, ctx, { type: 'person', id: person.id, sourceAdId: ad.id });
  await tx.events.emit('desk_item.created.v1', agg('desk_item', person.id, 1), {
    deskItemId: person.id,
    code: person.code,
    recordScope: 'Market Participant',
    side: 'None',
    ...(row.participantRole ?? person.participant_role ? { participantRole: (row.participantRole ?? person.participant_role) as string } : {}),
  });
}

// --- known refs ------------------------------------------------------------------------------------------------

/** Same content: only last seen / times seen and a sighting; no domain event. */
async function seenAgain(app: App, tx: Tx, rec: IngestedRecordRow, row: IntakeRow, ctx: BatchCtx) {
  await tx.store.update('ingested_records', rec.id, { last_upload_id: ctx.uploadId, last_row_id: row.rowId });
  const ad = rec.source_ad_id ? { id: rec.source_ad_id } : null;
  if (rec.primary_subject_type === 'offer' && rec.property_id) {
    const offers = await tx.store.find('offers', { property_id: rec.property_id, status: 'active' }, { limit: 20 });
    for (const o of offers.filter((x) => x.ingested_record_id === rec.id || x.id === rec.primary_subject_id)) {
      const inserted = await sighting(app, tx, { type: 'offer', id: o.id }, row, ad, ctx);
      if (!inserted) continue;
      await tx.store.update('offers', o.id, {
        last_seen_at: new Date(Math.max(o.last_seen_at?.getTime() ?? 0, seenAt(row, tx.now).getTime())),
        times_seen: Math.max(o.times_seen + 1, row.timesSeen ?? 0),
        sighting_count: o.sighting_count + 1,
      });
    }
  } else if (rec.primary_subject_type === 'demand' && rec.primary_subject_id) {
    if (await sighting(app, tx, { type: 'demand', id: rec.primary_subject_id }, row, ad, ctx)) {
      await tx.store.update('demands', rec.primary_subject_id, { last_seen_at: seenAt(row, tx.now) });
    }
  } else if (rec.primary_subject_id && (rec.primary_subject_type === 'desk_item' || rec.primary_subject_type === 'person')) {
    await sighting(app, tx, { type: rec.primary_subject_type, id: rec.primary_subject_id }, row, ad, ctx);
  }
}

/** Changed content of a known ref: facts update except staff-edited fields; updated (+ price_changed) events. */
async function updateFromRow(app: App, tx: Tx, rec: IngestedRecordRow, row: IntakeRow, ctx: BatchCtx) {
  const route = routeRow({ recordScope: row.recordScope, side: row.side, includesProperty: row.includesProperty });
  const kind = route.kind === 'supply' ? 'offer' : route.kind === 'demand' ? 'demand' : route.kind === 'unrouted' ? 'unrouted' : null;
  if (kind && rec.primary_subject_type && kind !== rec.primary_subject_type && rec.primary_subject_type !== 'desk_item' && rec.primary_subject_type !== 'person') {
    // The side or scope changed in the new file: void the old record and create the right one (§4.16).
    await voidSubject(tx, rec, 'side_changed');
    await tx.store.delete('ingested_records', { id: rec.id });
    await createFromRow(app, tx, row, ctx);
    return;
  }
  await tx.store.update('ingested_records', rec.id, { content_hash: row.contentHash, last_upload_id: ctx.uploadId, last_row_id: row.rowId, record_scope: row.recordScope ?? null });
  if (rec.primary_subject_type === 'offer' && rec.property_id) {
    const property = await tx.store.get('properties', rec.property_id, { lock: true });
    if (!property || property.status !== 'active') return;
    const facts = withoutStaffEdits(propertyFacts(row) as Record<string, unknown>, property.staff_edited_fields);
    const { row: derived } = await deriveProperty(app, tx, { ...property, ...facts } as PropertyRow, { sourceEdition: row.sourceEdition ?? null });
    const { id: _i, tenant_id: _t, created_at: _c, updated_at: _u, code: _code, ...rest } = derived;
    void [_i, _t, _c, _u, _code];
    await tx.store.update('properties', property.id, { ...rest, last_seen_at: seenAt(row, tx.now), version: property.version + 1 });
    const offers = await tx.store.find('offers', { property_id: property.id, status: 'active' }, { limit: 20 });
    const ad = rec.source_ad_id ? { id: rec.source_ad_id } : null;
    const created: OfferRow[] = [];
    for (const dealType of row.dealTypes ?? []) {
      const o = offers.find((x) => x.deal_type === dealType && x.project_id === null);
      if (!o) {
        if (['Sale', 'Lease', 'JV', 'Pagdi'].includes(dealType)) {
          created.push(...(await offersOfRow(app, tx, row, property.id, [dealType], { source_ad_id: rec.source_ad_id, ingested_record_id: rec.id })));
        }
        continue;
      }
      const patch = withoutStaffEdits(
        {
          ...offerFacts(row, dealType),
          ...reviewOf(row),
          last_seen_at: new Date(Math.max(o.last_seen_at?.getTime() ?? 0, seenAt(row, tx.now).getTime())),
          times_seen: Math.max(o.times_seen, row.timesSeen ?? 1),
        } as Record<string, unknown>,
        o.staff_edited_fields,
      );
      await tx.store.update('offers', o.id, patch as Partial<OfferRow>);
      await sighting(app, tx, { type: 'offer', id: o.id }, row, ad, ctx);
      await emitPriceChanged(tx, o, 'upload');
    }
    if (created.length) {
      await tx.store.insert('offers', created);
      await emitOffersCreated(tx, created.map((o) => o.id));
    }
    await bumpOffersUpdated(tx, (await activeOfferIdsOf(tx, [property.id])).filter((id) => !created.some((c) => c.id === id)));
  } else if (rec.primary_subject_type === 'demand' && rec.primary_subject_id) {
    const demand = await tx.store.get('demands', rec.primary_subject_id, { lock: true });
    if (!demand || demand.status !== 'active') return;
    const person = demand.person_id ? ((await tx.store.get('persons', demand.person_id)) ?? null) : null;
    const draft = await demandOfRow(app, tx, row, person);
    const patch = withoutStaffEdits(
      {
        deal_types: draft.deal_types,
        market: draft.market,
        segment: draft.segment,
        property_types: draft.property_types,
        micromarket_ids: draft.micromarket_ids,
        localities: draft.localities,
        budget_inr_min: draft.budget_inr_min,
        budget_inr_max: draft.budget_inr_max,
        rent_monthly_inr_min: draft.rent_monthly_inr_min,
        rent_monthly_inr_max: draft.rent_monthly_inr_max,
        area_sqft_min: draft.area_sqft_min,
        area_sqft_max: draft.area_sqft_max,
        area_basis: draft.area_basis,
        bhk_min: draft.bhk_min,
        bhk_max: draft.bhk_max,
        stated_tags: draft.stated_tags,
        needs_review: draft.needs_review,
        review_reason: draft.review_reason,
        review_reason_code: draft.review_reason_code,
        outside_launch_area: draft.outside_launch_area,
        last_seen_at: draft.last_seen_at,
      } as Record<string, unknown>,
      demand.staff_edited_fields,
    );
    await tx.store.update('demands', demand.id, patch as Partial<DemandRow>);
    await sighting(app, tx, { type: 'demand', id: demand.id }, row, rec.source_ad_id ? { id: rec.source_ad_id } : null, ctx);
    await bumpDemandsUpdated(tx, [demand.id]);
  } else if (rec.primary_subject_type === 'desk_item' && rec.primary_subject_id) {
    const item = await tx.store.get('desk_items', rec.primary_subject_id, { lock: true });
    if (!item) return;
    const description = row.businessDescription ?? null;
    await tx.store.update(
      'desk_items',
      item.id,
      withoutStaffEdits(
        {
          deal_types: row.dealTypes ?? [],
          sector: row.sector ?? null,
          signal_type: row.signalType ?? null,
          party_type: row.partyType ?? null,
          business_description: description,
          business_description_redacted: description ? app.redactor.redact(description) : null,
          deadline_date: row.deadlineDate ?? null,
        },
        item.staff_edited_fields,
      ) as Partial<DeskItemRow>,
    );
  } else if (rec.primary_subject_type === 'unrouted') {
    await tx.store.updateWhere('unrouted_rows', { external_source: rec.external_source, external_ref: rec.external_ref }, { row_snapshot: row, row_id: row.rowId, upload_id: ctx.uploadId });
  }
}

// --- migration map (§4.8) -------------------------------------------------------------------------------------

/**
 * Applies the upload's migration map before any of its batches (resumable, 200 entries per transaction):
 * kept → re-key; merged → merge old's subject into the target's (source migration_map, reversible); split → the old
 * subject follows the first new ref, the others arrive as new rows.
 */
export async function applyMigrationMap(app: App, actor: Actor, uploadId: string): Promise<void> {
  if (!app.intake) throw new IntakeUnavailableError('intake client is not configured');
  for (let guard = 0; guard < 10_000; guard++) {
    const state = await app.uow.run(actor, async (tx) => {
      await tx.advisoryLock(`migration:${uploadId}`);
      const [m] = await tx.store.find('upload_migrations', { upload_id: uploadId }, { limit: 1, lock: true });
      if (!m) {
        await tx.store.insert('upload_migrations', { id: app.ids.next(), upload_id: uploadId, status: 'applying', entries_applied: 0, cursor: null, applied_at: null });
        return { done: false, cursor: null as string | null, lastEntry: 0 };
      }
      return { done: m.status === 'applied', cursor: m.cursor, lastEntry: m.entries_applied };
    });
    if (state.done) return;
    const page = await app.intake.migrationMap(actor.tenantId, uploadId, state.cursor, actor.correlationId);
    const pending = page.items.filter((e) => e.entryNo > state.lastEntry).sort((a, b) => a.entryNo - b.entryNo);
    const slice = pending.slice(0, 200);
    await app.uow.run(
      actor,
      async (tx) => {
        await tx.advisoryLock(`migration:${uploadId}`);
        const [m] = await tx.store.find('upload_migrations', { upload_id: uploadId }, { limit: 1, lock: true });
        if (!m || m.status === 'applied' || m.entries_applied !== state.lastEntry) return; // someone else progressed
        for (const e of slice) await applyEntry(app, tx, actor, e);
        const pageDone = pending.length <= 200;
        const finished = pageDone && page.nextCursor === null;
        await tx.store.update('upload_migrations', m.id, {
          entries_applied: slice.at(-1)?.entryNo ?? m.entries_applied,
          cursor: pageDone ? page.nextCursor : m.cursor,
          status: finished ? 'applied' : 'applying',
          applied_at: finished ? tx.now : null,
        });
      },
      { timeoutMs: TOUCH_TIMEOUT_MS },
    );
  }
}

async function findRef(tx: Tx, ref: string) {
  const rows = await tx.store.find('ingested_records', { external_ref: ref }, { limit: 2 });
  return rows.find((r) => r.status === 'active') ?? rows[0];
}

async function applyEntry(app: App, tx: Tx, actor: Actor, e: { oldRef: string; newRefs: string[]; action: 'kept' | 'merged' | 'split' }) {
  const old = await findRef(tx, e.oldRef);
  if (!old) return; // unknown old ref: no-op
  const [first, ...rest] = e.newRefs;
  if (!first) return;
  if (e.action === 'split') {
    await tx.store.insertIgnore('ingested_records', { ...old, id: app.ids.next(), external_ref: first, status: 'active', replaced_by_refs: null });
    await tx.store.update('ingested_records', old.id, { status: 'split', replaced_by_refs: e.newRefs });
    void rest;
    return;
  }
  const target = await findRef(tx, first);
  if (!target || target.id === old.id) {
    await tx.store.update('ingested_records', old.id, { external_ref: first });
    return;
  }
  // Both known: merge old's primary subject into the target's (kept with an existing new ref is treated as merged).
  const type = old.primary_subject_type;
  if (
    type &&
    type === target.primary_subject_type &&
    (type === 'offer' || type === 'demand' || type === 'person') &&
    old.primary_subject_id &&
    target.primary_subject_id &&
    old.primary_subject_id !== target.primary_subject_id
  ) {
    const aggregate = type === 'offer' && old.property_id && target.property_id && old.property_id !== target.property_id ? 'property' : type;
    const survivor = aggregate === 'property' ? target.property_id! : target.primary_subject_id;
    const mergedId = aggregate === 'property' ? old.property_id! : old.primary_subject_id;
    const table = aggregate === 'property' ? 'properties' : aggregate === 'offer' ? 'offers' : aggregate === 'demand' ? 'demands' : 'persons';
    const [a, b] = await Promise.all([tx.store.get(table, survivor), tx.store.get(table, mergedId)]);
    if (a?.status === 'active' && b?.status === 'active') {
      await mergeInTx(app, tx, { aggregateType: aggregate, survivorId: survivor, mergedIds: [mergedId], source: 'migration_map', performedBy: null, userRequest: false }, systemActor(actor.tenantId, actor.correlationId));
    }
  }
  await tx.store.update('ingested_records', old.id, { status: 'merged', replaced_by_refs: e.newRefs });
}

/** Nightly resolve-pending-repeats: pending possible_repeat candidates whose target ref has arrived open up. */
export async function resolvePendingRepeats(app: App, actor: Actor): Promise<{ processed: number; more: boolean }> {
  return app.uow.run(actor, async (tx) => {
    const pending = await tx.store.find('merge_candidates', { status: 'pending_target' }, { limit: 200 });
    let opened = 0;
    for (const c of pending) {
      if (!c.right_external_ref) continue;
      const target = await findRef(tx, c.right_external_ref);
      if (target?.primary_subject_id && target.primary_subject_type === c.aggregate_type) {
        opened += (await openPendingFor(tx, c.right_external_ref, { type: c.aggregate_type, id: target.primary_subject_id })).length;
      }
    }
    return { processed: opened, more: false };
  });
}
