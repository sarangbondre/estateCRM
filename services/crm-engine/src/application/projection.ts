// Matchable projection from events (LLD §5.2): each consumed event updates offer_mx / demand_mx in the drain
// transaction and marks the subject dirty for the re-score pipeline. Out-of-order delivery: each field group has its
// own version (facts / price from records; life / commercial / status from journeys) and an event applies only when
// its aggregateVersion is newer than the stored one for that group. Contact ids are never stored (PII-free).
import type { components } from '@11e/contracts/events';
import type { AreaBasis } from '../domain/types.js';
import type { DemandRecord, OfferRecord, Store } from './ports.js';

type S = components['schemas'];

export interface EventMeta {
  eventId: string;
  tenantId: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  correlationId: string;
}

/** A journeys event arrived before the records event that creates the subject: retried by the drain (backoff). */
export class ProjectionGapError extends Error {
  override readonly name = 'ProjectionGapError';
}

const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const basis = (v: AreaBasis | null | undefined): AreaBasis | null => v ?? null;

type OfferFacts = S['OfferCreatedV1'];
type DemandFacts = S['DemandCreatedV1'];

/** Offer projection from full facts (offer.created.v1 / offer.updated.v1). */
export async function applyOfferFacts(store: Store, meta: EventMeta, f: OfferFacts): Promise<void> {
  const prev = await store.mx.getOffer(meta.tenantId, f.offerId);
  if (prev && meta.aggregateVersion <= prev.factsVersion) return; // stale or duplicate
  const h = await store.hierarchy.load(meta.tenantId);
  const priceNewer = !prev || meta.aggregateVersion > prev.priceVersion;
  const price = priceNewer
    ? {
        salePriceInrMin: nn(f.salePriceInrMin),
        salePriceInrMax: nn(f.salePriceInrMax),
        rentMonthlyInrMin: nn(f.rentMonthlyInrMin),
        rentMonthlyInrMax: nn(f.rentMonthlyInrMax),
        depositInr: nn(f.depositInr),
        currentRentInr: nn(f.currentRentInr),
        unitCount: nn(f.unitCount),
      }
    : {
        salePriceInrMin: prev.salePriceInrMin,
        salePriceInrMax: prev.salePriceInrMax,
        rentMonthlyInrMin: prev.rentMonthlyInrMin,
        rentMonthlyInrMax: prev.rentMonthlyInrMax,
        depositInr: prev.depositInr,
        currentRentInr: prev.currentRentInr,
        unitCount: prev.unitCount,
      };
  const micromarket = nn(f.micromarket);
  const locality = nn(f.locality);
  const mmPath = h.offerPath(micromarket, locality);
  const zone = mmPath.length
    ? (h.ancestry(mmPath[0] as string).find((n) => n.level === 'zone')?.name ?? null)
    : null;
  const rec: OfferRecord = {
    id: f.offerId,
    tenantId: meta.tenantId,
    code: f.code,
    propertyId: f.propertyId,
    projectId: nn(f.projectId),
    buildingKey: nn(f.buildingKey),
    dealType: f.dealType,
    market: nn(f.market),
    segment: nn(f.segment),
    propertyTypes: f.propertyTypes ?? [],
    bhkMin: nn(f.bhkMin),
    bhkMax: nn(f.bhkMax),
    areaSqftMin: nn(f.areaSqftMin),
    areaSqftMax: nn(f.areaSqftMax),
    areaBasis: basis(f.areaBasis),
    landAreaSqft: nn(f.landAreaSqft),
    ...price,
    micromarket,
    locality,
    mmPath,
    zone,
    outsideLaunchArea: f.outsideLaunchArea ?? false,
    tenancyStatus: nn(f.tenancyStatus),
    saleMode: nn(f.saleMode),
    possessionStatus: nn(f.possessionStatus),
    possessionDateRaw: nn(f.possessionDate),
    tenure: nn(f.tenure),
    agreementForm: nn(f.agreementForm),
    isJodi: nn(f.isJodi),
    parking: nn(f.parking),
    amenities: f.amenities ?? [],
    floorBand: nn(f.floorBand),
    totalFloors: nn(f.totalFloors),
    priceSheetDate: nn(f.priceSheetDate),
    lastSeenDate: nn(f.lastSeenDate),
    furnishing: nn(f.furnishing),
    recordStage: nn(f.recordStage),
    lifeStage: prev?.lifeStage ?? 'Fresh',
    commercialStatus: prev?.commercialStatus ?? 'Available', // journeys owns the Commercial axis (LLD §1)
    voided: prev?.voided ?? false,
    mergedInto: prev?.mergedInto ?? null,
    factsVersion: meta.aggregateVersion,
    priceVersion: priceNewer ? meta.aggregateVersion : (prev?.priceVersion ?? 0),
    lifeVersion: prev?.lifeVersion ?? 0,
    commercialVersion: prev?.commercialVersion ?? 0,
  };
  await store.mx.saveOffer(rec);
  await store.rescore.markDirty(meta.tenantId, 'offer', rec.id, prev ? 'offer.updated' : 'offer.created');
}

/** offer.price_changed.v1: typed `current` prices when newer than the stored price group. */
export async function applyOfferPriceChanged(
  store: Store,
  meta: EventMeta,
  e: S['OfferPriceChangedV1'],
): Promise<void> {
  const prev = await store.mx.getOffer(meta.tenantId, e.offerId);
  if (!prev) throw new ProjectionGapError(`offer ${e.offerId} not projected yet`);
  if (meta.aggregateVersion <= prev.priceVersion) return;
  const c = e.current;
  await store.mx.saveOffer({
    ...prev,
    salePriceInrMin: nn(c.salePriceInrMin),
    salePriceInrMax: nn(c.salePriceInrMax),
    rentMonthlyInrMin: nn(c.rentMonthlyInrMin),
    rentMonthlyInrMax: nn(c.rentMonthlyInrMax),
    depositInr: nn(c.depositInr),
    currentRentInr: nn(c.currentRentInr),
    unitCount: c.unitCount === undefined ? prev.unitCount : c.unitCount,
    priceVersion: meta.aggregateVersion,
  });
  await store.rescore.markDirty(meta.tenantId, 'offer', prev.id, 'offer.price_changed');
}

/** price_sheet.applied.v1: price sheet date on the changed offers; their prices arrive as offer.price_changed.v1. */
export async function applyPriceSheet(
  store: Store,
  meta: EventMeta,
  e: S['PriceSheetAppliedV1'],
): Promise<void> {
  const ids = (e.changedOfferIds ?? []).slice(0, 1000);
  for (const o of await store.mx.getOffers(meta.tenantId, ids)) {
    if (o.priceSheetDate && o.priceSheetDate >= e.sheetDate) continue;
    await store.mx.saveOffer({ ...o, priceSheetDate: e.sheetDate });
    await store.rescore.markDirty(meta.tenantId, 'offer', o.id, 'price_sheet.applied');
  }
}

/** offer.voided.v1 (terminal). */
export async function applyOfferVoided(
  store: Store,
  meta: EventMeta,
  e: S['OfferVoidedV1'],
): Promise<OfferRecord | null> {
  const prev = await store.mx.getOffer(meta.tenantId, e.offerId);
  if (!prev || prev.voided) return null;
  const next = { ...prev, voided: true };
  await store.mx.saveOffer(next);
  await store.rescore.markDirty(meta.tenantId, 'offer', prev.id, 'offer.voided');
  return next;
}

/** Demand projection from full facts (demand.created.v1 / demand.updated.v1). */
export async function applyDemandFacts(store: Store, meta: EventMeta, f: DemandFacts): Promise<void> {
  const prev = await store.mx.getDemand(meta.tenantId, f.demandId);
  if (prev && meta.aggregateVersion <= prev.factsVersion) return;
  const h = await store.hierarchy.load(meta.tenantId);
  const micromarkets = f.micromarkets ?? [];
  const localities = f.localities ?? [];
  const rec: DemandRecord = {
    id: f.demandId,
    tenantId: meta.tenantId,
    code: f.code,
    dealTypes: f.dealTypes,
    market: nn(f.market),
    segment: nn(f.segment),
    propertyTypes: f.propertyTypes ?? [],
    bhkMin: nn(f.bhkMin),
    bhkMax: nn(f.bhkMax),
    areaSqftMin: nn(f.areaSqftMin),
    areaSqftMax: nn(f.areaSqftMax),
    areaBasis: basis(f.areaBasis),
    budgetInrMin: nn(f.budgetInrMin),
    budgetInrMax: nn(f.budgetInrMax),
    rentMonthlyInrMin: nn(f.rentMonthlyInrMin),
    rentMonthlyInrMax: nn(f.rentMonthlyInrMax),
    micromarkets,
    localities,
    mmExpanded: h.demandExpanded(micromarkets, localities),
    moveInFrom: nn(f.moveInFrom),
    moveInBy: nn(f.moveInBy),
    statedTags: f.statedTags ?? {},
    outsideLaunchArea: f.outsideLaunchArea ?? false,
    recordStage: nn(f.recordStage),
    qualified: prev?.qualified ?? f.recordStage === 'Qualified',
    ownerUserId: nn(f.ownerUserId),
    lifeStage: prev?.lifeStage ?? 'Fresh',
    commercialStatus: prev?.commercialStatus ?? 'New',
    exitType: prev?.exitType ?? null,
    voided: prev?.voided ?? false,
    mergedInto: prev?.mergedInto ?? null,
    factsVersion: meta.aggregateVersion,
    lifeVersion: prev?.lifeVersion ?? 0,
    statusVersion: prev?.statusVersion ?? 0,
  };
  await store.mx.saveDemand(rec);
  await store.rescore.markDirty(meta.tenantId, 'demand', rec.id, prev ? 'demand.updated' : 'demand.created');
}

/** demand.voided.v1 (terminal). */
export async function applyDemandVoided(
  store: Store,
  meta: EventMeta,
  e: S['DemandVoidedV1'],
): Promise<DemandRecord | null> {
  const prev = await store.mx.getDemand(meta.tenantId, e.demandId);
  if (!prev || prev.voided) return null;
  const next = { ...prev, voided: true };
  await store.mx.saveDemand(next);
  await store.rescore.markDirty(meta.tenantId, 'demand', prev.id, 'demand.voided');
  return next;
}

async function offerOrGap(store: Store, meta: EventMeta, id: string): Promise<OfferRecord> {
  const o = await store.mx.getOffer(meta.tenantId, id);
  if (!o) throw new ProjectionGapError(`offer ${id} not projected yet`);
  return o;
}

async function demandOrGap(store: Store, meta: EventMeta, id: string): Promise<DemandRecord> {
  const d = await store.mx.getDemand(meta.tenantId, id);
  if (!d) throw new ProjectionGapError(`demand ${id} not projected yet`);
  return d;
}

/** Result of a journeys state change: the record before and after (null when the event was stale). */
export interface Change<T> {
  before: T;
  after: T;
}

/** lifecycle.stage_changed.v1 for an offer (life group). */
export async function applyOfferStage(
  store: Store,
  meta: EventMeta,
  id: string,
  to: string,
): Promise<Change<OfferRecord> | null> {
  const prev = await offerOrGap(store, meta, id);
  if (meta.aggregateVersion <= prev.lifeVersion) return null;
  const next = { ...prev, lifeStage: to, lifeVersion: meta.aggregateVersion };
  await store.mx.saveOffer(next);
  await store.rescore.markDirty(meta.tenantId, 'offer', id, 'lifecycle.stage_changed');
  return { before: prev, after: next };
}

/** offer.confirmed.v1: the offer is Fresh again (reconfirm cleared; Expired matches may reopen). */
export async function applyOfferConfirmed(
  store: Store,
  meta: EventMeta,
  e: S['OfferConfirmedV1'],
): Promise<Change<OfferRecord> | null> {
  const prev = await offerOrGap(store, meta, e.offerId);
  if (meta.aggregateVersion <= prev.lifeVersion) return null;
  const next = { ...prev, lifeStage: 'Fresh', lifeVersion: meta.aggregateVersion };
  await store.mx.saveOffer(next);
  await store.rescore.markDirty(meta.tenantId, 'offer', prev.id, 'offer.confirmed');
  return { before: prev, after: next };
}

/** offer.commercial_status_changed.v1 / offer.retired.v1 (commercial group). */
export async function applyOfferCommercial(
  store: Store,
  meta: EventMeta,
  id: string,
  to: string,
  reason: string,
): Promise<Change<OfferRecord> | null> {
  const prev = await offerOrGap(store, meta, id);
  if (meta.aggregateVersion <= prev.commercialVersion) return null;
  const next = { ...prev, commercialStatus: to, commercialVersion: meta.aggregateVersion };
  await store.mx.saveOffer(next);
  await store.rescore.markDirty(meta.tenantId, 'offer', id, reason);
  return { before: prev, after: next };
}

/** lifecycle.stage_changed.v1 for a demand (life group). */
export async function applyDemandStage(
  store: Store,
  meta: EventMeta,
  id: string,
  to: string,
): Promise<Change<DemandRecord> | null> {
  const prev = await demandOrGap(store, meta, id);
  if (meta.aggregateVersion <= prev.lifeVersion) return null;
  const next = { ...prev, lifeStage: to, lifeVersion: meta.aggregateVersion };
  await store.mx.saveDemand(next);
  await store.rescore.markDirty(meta.tenantId, 'demand', id, 'lifecycle.stage_changed');
  return { before: prev, after: next };
}

/** demand.status_changed.v1 / demand.exited.v1 / demand.reactivated.v1 (status group). */
export async function applyDemandStatus(
  store: Store,
  meta: EventMeta,
  id: string,
  patch: Partial<Pick<DemandRecord, 'commercialStatus' | 'exitType'>>,
  reason: string,
): Promise<Change<DemandRecord> | null> {
  const prev = await demandOrGap(store, meta, id);
  if (meta.aggregateVersion <= prev.statusVersion) return null;
  const next = { ...prev, ...patch, statusVersion: meta.aggregateVersion };
  await store.mx.saveDemand(next);
  await store.rescore.markDirty(meta.tenantId, 'demand', id, reason);
  return { before: prev, after: next };
}

/** demand.confirmed.v1: re-score (Stale → Fresh arrives as the stage event). */
export async function applyDemandConfirmed(
  store: Store,
  meta: EventMeta,
  e: S['DemandConfirmedV1'],
): Promise<void> {
  await demandOrGap(store, meta, e.demandId);
  await store.rescore.markDirty(meta.tenantId, 'demand', e.demandId, 'demand.confirmed');
}

/** vocabulary.released.v1 / micromarkets.updated.v1: cache and queue micromarket-refresh (then a full re-score). */
export async function applyReferenceRelease(
  store: Store,
  meta: EventMeta,
  e: { vocabulary?: S['VocabularyReleasedV1']; micromarkets?: S['MicromarketsUpdatedV1'] },
  vocabularyBody: (version: string) => unknown,
): Promise<void> {
  if (e.vocabulary)
    await store.hierarchy.cacheVocabulary(
      meta.tenantId,
      e.vocabulary.version,
      e.vocabulary.checksum,
      vocabularyBody(e.vocabulary.version),
    );
  await store.hierarchy.requestRefresh(meta.tenantId, e.micromarkets?.version ?? null);
  await store.rescore.enqueueJob('micromarket-refresh', meta.tenantId);
}
