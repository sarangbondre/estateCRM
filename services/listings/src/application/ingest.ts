// Event consumers (LLD §5.2, §4.3, §4.12): each applies an input change in the drain transaction, recomputes the
// ceiling there and auto-downgrades (≤ 1 min end to end, NFR-10). Stale versions are ignored per producer.
import type { EventDataMap, EventType } from '@11e/contracts/events';
import { restoredLevel } from '../domain/autoDowngrade.js';
import type { DemandFacts, LifeStage, OfferFacts, ProjectFacts } from '../domain/types.js';
import { SYSTEM_ACTOR } from '../domain/types.js';
import type { Services } from './context.js';
import { newPublication, reconcile, savePublication, setLevel, syncProjection, loadFacts } from './engine.js';
import type { Store } from './ports.js';

/** The envelope fields a consumer needs (conventions §5). */
export interface Incoming<T extends EventType> {
  eventId: string;
  eventType: T;
  producer: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  data: EventDataMap[T];
}

/** A journeys/crm-engine fact arrived before records' create event: retried with backoff, then dead-lettered. */
export class SubjectNotYetKnown extends Error {
  override readonly name = 'SubjectNotYetKnown';
}

const PROPERTY_CASCADE = 100;

// ---- offers (records) ----------------------------------------------------------------------------------------------

type OfferEventData = EventDataMap['offer.created.v1'];

const num = (v: number | undefined | null) => (v === undefined ? null : v);

function offerFactsFrom(d: OfferEventData, prev: OfferFacts | undefined, version: number): OfferFacts {
  return {
    id: d.offerId,
    code: d.code,
    propertyId: d.propertyId,
    projectId: d.projectId ?? null,
    dealType: d.dealType,
    market: d.market ?? null,
    segment: d.segment ?? null,
    propertyTypes: d.propertyTypes ?? [],
    bhkMin: num(d.bhkMin),
    bhkMax: num(d.bhkMax),
    areaSqftMin: num(d.areaSqftMin),
    areaSqftMax: num(d.areaSqftMax),
    areaBasis: d.areaBasis ?? null,
    landAreaSqft: num(d.landAreaSqft),
    salePriceInrMin: num(d.salePriceInrMin),
    salePriceInrMax: num(d.salePriceInrMax),
    rentMonthlyInrMin: num(d.rentMonthlyInrMin),
    rentMonthlyInrMax: num(d.rentMonthlyInrMax),
    locality: d.locality ?? null,
    micromarket: d.micromarket ?? null,
    city: d.city ?? null,
    outsideLaunchArea: d.outsideLaunchArea ?? false,
    tenancyStatus: d.tenancyStatus ?? null,
    saleMode: d.saleMode ?? null,
    possessionStatus: d.possessionStatus ?? null,
    furnishing: d.furnishing ?? null,
    possessionDate: d.possessionDate ?? null,
    unitCount: num(d.unitCount),
    floorBand: d.floorBand ?? null,
    totalFloors: num(d.totalFloors),
    parking: num(d.parking),
    amenities: d.amenities ?? [],
    selectedPhotoIds: d.selectedPhotoIds ?? [],
    recordStage: d.recordStage ?? prev?.recordStage ?? null,
    hasRealPhotos: d.hasRealPhotos ?? prev?.hasRealPhotos ?? false,
    // journeys-side and lifecycle facts are kept
    voidedReason: prev?.voidedReason ?? null,
    commercialStatus: prev?.commercialStatus ?? null,
    lifeStage: prev?.lifeStage ?? null,
    lifeDay: prev?.lifeDay ?? null,
    retiredReason: prev?.retiredReason ?? null,
    mergedIntoId: prev?.mergedIntoId ?? null,
    recordsVersion: version,
    journeysVersion: prev?.journeysVersion ?? 0,
  };
}

async function upsertOffer(s: Services, store: Store, e: Incoming<'offer.created.v1' | 'offer.updated.v1'>) {
  const prev = await store.getOffer(e.data.offerId);
  if (prev && prev.recordsVersion >= e.aggregateVersion) return;
  const facts = offerFactsFrom(e.data, prev, e.aggregateVersion);
  await store.saveOffer(facts);
  if (!prev || prev.propertyId !== facts.propertyId)
    await store.enqueue({ kind: 'scan-terms', tenantId: store.tenantId, propertyId: facts.propertyId });
  await reconcile(s, store, 'offer', facts.id);
  // The project that lists this offer may have been created before it.
  if (prev?.projectId && prev.projectId !== facts.projectId)
    await reconcile(s, store, 'project', prev.projectId, { cascade: false });
}

/** Applies a records change to a known offer when its version is newer. */
async function patchOfferFromRecords(
  s: Services,
  store: Store,
  e: Incoming<EventType>,
  offerId: string,
  patch: (o: OfferFacts) => void,
) {
  const o = await store.getOffer(offerId);
  if (!o) throw new SubjectNotYetKnown(`offer ${offerId}`);
  if (e.aggregateId === offerId && o.recordsVersion >= e.aggregateVersion) return;
  patch(o);
  if (e.aggregateId === offerId) o.recordsVersion = e.aggregateVersion;
  await store.saveOffer(o);
  await reconcile(s, store, 'offer', offerId);
}

/** Applies a journeys change to a known offer when its version is newer. */
async function patchOfferFromJourneys(
  s: Services,
  store: Store,
  e: Incoming<EventType>,
  offerId: string,
  patch: (o: OfferFacts) => void,
) {
  const o = await store.getOffer(offerId);
  if (!o) throw new SubjectNotYetKnown(`offer ${offerId}`);
  const sameAggregate = e.aggregateId === offerId;
  if (sameAggregate && o.journeysVersion >= e.aggregateVersion) return;
  patch(o);
  if (sameAggregate) o.journeysVersion = e.aggregateVersion;
  await store.saveOffer(o);
  await reconcile(s, store, 'offer', offerId);
}

// ---- demands -------------------------------------------------------------------------------------------------------

type DemandEventData = EventDataMap['demand.created.v1'];

function demandFactsFrom(d: DemandEventData, prev: DemandFacts | undefined, version: number): DemandFacts {
  return {
    id: d.demandId,
    code: d.code,
    dealTypes: d.dealTypes,
    market: d.market ?? null,
    segment: d.segment ?? null,
    propertyTypes: d.propertyTypes ?? [],
    micromarkets: d.micromarkets ?? [],
    areaSqftMin: num(d.areaSqftMin),
    areaSqftMax: num(d.areaSqftMax),
    areaBasis: d.areaBasis ?? null,
    budgetInrMin: num(d.budgetInrMin),
    budgetInrMax: num(d.budgetInrMax),
    rentMonthlyInrMin: num(d.rentMonthlyInrMin),
    rentMonthlyInrMax: num(d.rentMonthlyInrMax),
    moveInBy: d.moveInBy ?? null,
    status: prev?.status ?? null,
    lifeStage: prev?.lifeStage ?? null,
    exitType: prev?.exitType ?? null,
    matched: prev?.matched ?? false,
    postRequested: prev?.postRequested ?? false,
    sourcingRequestId: prev?.sourcingRequestId ?? null,
    voidedReason: prev?.voidedReason ?? null,
    mergedIntoId: prev?.mergedIntoId ?? null,
    recordsVersion: version,
    journeysVersion: prev?.journeysVersion ?? 0,
  };
}

async function upsertDemand(
  s: Services,
  store: Store,
  e: Incoming<'demand.created.v1' | 'demand.updated.v1'>,
) {
  const prev = await store.getDemand(e.data.demandId);
  if (prev && prev.recordsVersion >= e.aggregateVersion) return;
  await store.saveDemand(demandFactsFrom(e.data, prev, e.aggregateVersion));
  await reconcile(s, store, 'demand_post', e.data.demandId);
}

async function patchDemand(
  s: Services,
  store: Store,
  e: Incoming<EventType>,
  demandId: string,
  producer: 'records' | 'journeys' | 'other',
  patch: (d: DemandFacts) => void,
): Promise<DemandFacts | undefined> {
  const d = await store.getDemand(demandId);
  if (!d) throw new SubjectNotYetKnown(`demand ${demandId}`);
  const same = e.aggregateId === demandId;
  if (same && producer === 'records' && d.recordsVersion >= e.aggregateVersion) return undefined;
  if (same && producer === 'journeys' && d.journeysVersion >= e.aggregateVersion) return undefined;
  patch(d);
  if (same && producer === 'records') d.recordsVersion = e.aggregateVersion;
  if (same && producer === 'journeys') d.journeysVersion = e.aggregateVersion;
  await store.saveDemand(d);
  await reconcile(s, store, 'demand_post', demandId);
  return d;
}

// ---- projects ------------------------------------------------------------------------------------------------------

async function upsertProject(
  s: Services,
  store: Store,
  e: Incoming<'project.created.v1' | 'project.updated.v1'>,
) {
  const d = e.data;
  const prev = await store.getProject(d.projectId);
  if (prev && prev.recordsVersion >= e.aggregateVersion) return;
  const facts: ProjectFacts = {
    id: d.projectId,
    code: d.code,
    name: d.name,
    developerName: d.developerName ?? null,
    city: d.city ?? null,
    micromarket: d.micromarket ?? null,
    locality: d.locality ?? null,
    reraNumber: d.reraNumber ?? null,
    possessionDate: d.possessionDate ?? null,
    amenities: d.amenities ?? [],
    offerIds: d.offerIds ?? [],
    recordsVersion: e.aggregateVersion,
  };
  await store.saveProject(facts);
  // RERA re-check on its configuration offers, then the project item (cascade).
  await reconcile(s, store, 'project', facts.id);
  await reconcile(s, store, 'project', facts.id, { cascade: false });
}

// ---- photos --------------------------------------------------------------------------------------------------------

async function reconcileProperty(s: Services, store: Store, propertyId: string) {
  for (const id of await store.offersOfProperty(propertyId, PROPERTY_CASCADE))
    await reconcile(s, store, 'offer', id);
}

// ---- merges --------------------------------------------------------------------------------------------------------

async function merged(s: Services, store: Store, e: Incoming<'records.merged.v1'>) {
  const d = e.data;
  if (d.aggregateType === 'property') {
    for (const id of [d.survivorId, ...d.mergedIds])
      await store.enqueue({ kind: 'scan-terms', tenantId: store.tenantId, propertyId: id });
    return;
  }
  if (d.aggregateType !== 'offer' && d.aggregateType !== 'demand') return;
  const type = d.aggregateType === 'offer' ? 'offer' : 'demand_post';
  for (const id of d.mergedIds) {
    const pub = await store.getPublication(type, id);
    if (pub)
      await store.logMerge({
        mergeId: d.mergeId,
        subjectType: type,
        subjectId: id,
        prior: { level: pub.level, publicId: pub.publicId },
      });
    if (type === 'offer') {
      const o = await store.getOffer(id);
      if (!o) continue;
      o.mergedIntoId = d.survivorId;
      await store.saveOffer(o);
    } else {
      const dm = await store.getDemand(id);
      if (!dm) continue;
      dm.mergedIntoId = d.survivorId;
      await store.saveDemand(dm);
    }
    await reconcile(s, store, type, id);
  }
}

async function mergeUndone(s: Services, store: Store, e: Incoming<'records.merge_undone.v1'>) {
  const d = e.data;
  if (d.aggregateType === 'property') {
    for (const id of d.restoredIds)
      await store.enqueue({ kind: 'scan-terms', tenantId: store.tenantId, propertyId: id });
    return;
  }
  if (d.aggregateType !== 'offer' && d.aggregateType !== 'demand') return;
  const type = d.aggregateType === 'offer' ? 'offer' : 'demand_post';
  const log = new Map((await store.mergeEntries(d.mergeId, 500)).map((x) => [x.subjectId, x]));
  for (const id of d.restoredIds) {
    if (type === 'offer') {
      const o = await store.getOffer(id);
      if (!o) continue;
      o.mergedIntoId = null;
      await store.saveOffer(o);
    } else {
      const dm = await store.getDemand(id);
      if (!dm) continue;
      dm.mergedIntoId = null;
      await store.saveDemand(dm);
    }
    const pub = await reconcile(s, store, type, id);
    const prior = log.get(id);
    if (!pub || !prior) continue;
    // HLD §7 saga: restore the pre-merge level, capped at today's ceiling (the one exception to "never auto-raise").
    const level = restoredLevel(type, prior.prior.level, pub.ceiling);
    if (level === pub.level) continue;
    await setLevel(s, store, pub, level, 'user', { userId: SYSTEM_ACTOR, via: 'system' });
    await store.emitAudit({
      action: 'publication.auto_changed',
      actorUserId: SYSTEM_ACTOR,
      subjectType: type,
      subjectId: id,
      via: 'system',
      details: { to: level, reason: 'merge_undone', mergeId: d.mergeId },
    });
    await savePublication(s, store, pub);
    const facts = await loadFacts(store, type, id);
    if (facts) await syncProjection(s, store, pub, facts, await store.getSettings());
  }
}

// ---- demand posts (journeys) ---------------------------------------------------------------------------------------

async function sourcingStarted(s: Services, store: Store, e: Incoming<'demand.sourcing_started.v1'>) {
  const d = e.data;
  const facts = await patchDemand(s, store, e, d.demandId, 'journeys', (x) => {
    x.postRequested = d.postAnonymously;
    x.sourcingRequestId = d.sourcingRequestId ?? x.sourcingRequestId;
    x.status = 'Sourcing';
  });
  if (!facts || !d.postAnonymously) return;
  // The C-11 toggle is the user's click: publish the post at Anonymous when the ceiling allows it.
  const pub = await newPublication(s, store, 'demand_post', d.demandId);
  if (pub.ceiling !== 'Anonymous' || pub.level === 'Anonymous') return;
  await setLevel(s, store, pub, 'Anonymous', 'user', { userId: SYSTEM_ACTOR, via: 'system' });
  await store.emitAudit({
    action: 'publication.set',
    actorUserId: SYSTEM_ACTOR,
    subjectType: 'demand_post',
    subjectId: d.demandId,
    via: 'system',
    details: { from: 'Private', to: 'Anonymous', trigger: 'demand.sourcing_started' },
  });
  await savePublication(s, store, pub);
  const all = await loadFacts(store, 'demand_post', d.demandId);
  if (all) await syncProjection(s, store, pub, all, await store.getSettings());
}

// ---- the handler table ---------------------------------------------------------------------------------------------

export type Handler<T extends EventType> = (s: Services, store: Store, e: Incoming<T>) => Promise<void>;
export type HandlerTable = { [T in EventType]?: Handler<T> };

const LIFE_STAGES: readonly string[] = ['Fresh', 'Ageing', 'Stale', 'Expired', 'Paused'];
const lifeStage = (v: string): LifeStage | null => (LIFE_STAGES.includes(v) ? (v as LifeStage) : null);

/** Exactly the listings subscriptions of events.yaml v0.2 (a test keeps them in step with event-topology.json). */
export const handlers: HandlerTable = {
  'offer.created.v1': upsertOffer,
  'offer.updated.v1': upsertOffer,
  'offer.price_changed.v1': (s, store, e) =>
    patchOfferFromRecords(s, store, e, e.data.offerId, (o) => {
      const c = e.data.current;
      o.salePriceInrMin = num(c.salePriceInrMin);
      o.salePriceInrMax = num(c.salePriceInrMax);
      o.rentMonthlyInrMin = num(c.rentMonthlyInrMin);
      o.rentMonthlyInrMax = num(c.rentMonthlyInrMax);
      if (c.unitCount !== undefined) o.unitCount = c.unitCount;
    }),
  'offer.record_stage_changed.v1': (s, store, e) =>
    patchOfferFromRecords(s, store, e, e.data.offerId, (o) => {
      o.recordStage = e.data.to;
      if (e.data.hasRealPhotos !== undefined) o.hasRealPhotos = e.data.hasRealPhotos;
    }),
  'offer.voided.v1': (s, store, e) =>
    patchOfferFromRecords(s, store, e, e.data.offerId, (o) => {
      o.voidedReason = e.data.reason;
    }),
  'photo.added.v1': async (s, store, e) => {
    const d = e.data;
    const inserted = await store.savePhotoAdded({
      id: d.photoId,
      propertyId: d.propertyId,
      origin: d.origin,
      isReal: d.isReal ?? false,
      sourceStoragePath: d.storagePath,
      hasTextDetected: d.hasTextDetected ?? null,
    });
    if (inserted)
      await store.enqueue({ kind: 'photo-process', tenantId: store.tenantId, photoId: d.photoId });
    void s;
  },
  'photo.removed.v1': async (s, store, e) => {
    const photo = await store.getPhoto(e.data.photoId);
    if (!photo) return;
    await store.markPhotoRemoved(photo.id);
    if (photo.publicPath)
      await store.enqueue({ kind: 'photo-unpublish', tenantId: store.tenantId, photoId: photo.id });
    await reconcileProperty(s, store, e.data.propertyId);
  },
  'project.created.v1': upsertProject,
  'project.updated.v1': upsertProject,
  'demand.created.v1': upsertDemand,
  'demand.updated.v1': upsertDemand,
  'demand.voided.v1': async (s, store, e) => {
    await patchDemand(s, store, e, e.data.demandId, 'records', (d) => {
      d.voidedReason = e.data.reason;
    });
  },
  'records.merged.v1': merged,
  'records.merge_undone.v1': mergeUndone,
  'vocabulary.released.v1': async (s, store, e) => {
    await store.saveVocabularyRelease(e.data.version, e.data.checksum);
    await store.enqueue({ kind: 'projection-refresh', tenantId: store.tenantId });
    void s;
  },
  'micromarkets.updated.v1': async (s, store) => {
    await store.enqueue({ kind: 'micromarkets', tenantId: store.tenantId });
    void s;
  },
  'offer.confirmed.v1': (s, store, e) => patchOfferFromJourneys(s, store, e, e.data.offerId, () => undefined),
  'lifecycle.stage_changed.v1': async (s, store, e) => {
    const d = e.data;
    if (d.subjectType === 'offer') {
      await patchOfferFromJourneys(s, store, e, d.subjectId, (o) => {
        o.lifeStage = lifeStage(d.to);
        o.lifeDay = d.day;
      });
    } else {
      await patchDemand(s, store, e, d.subjectId, 'journeys', (x) => {
        x.lifeStage = lifeStage(d.to);
      });
    }
  },
  'offer.commercial_status_changed.v1': (s, store, e) =>
    patchOfferFromJourneys(s, store, e, e.data.offerId, (o) => {
      o.commercialStatus = e.data.to;
    }),
  'deal.closed.v1': async (s, store, e) => {
    await patchOfferFromJourneys(s, store, e, e.data.offerId, (o) => {
      o.commercialStatus = 'Closed';
    });
    if (await store.getDemand(e.data.demandId))
      await patchDemand(s, store, e, e.data.demandId, 'other', (d) => {
        d.status = 'Closed';
      });
  },
  'deal.cancelled.v1': (s, store, e) =>
    patchOfferFromJourneys(s, store, e, e.data.offerId, (o) => {
      // Back to Available; the ceiling may rise but the level never auto-raises.
      if (o.commercialStatus === 'Closed' || o.commercialStatus === 'In process')
        o.commercialStatus = 'Available';
    }),
  'offer.retired.v1': (s, store, e) =>
    patchOfferFromJourneys(s, store, e, e.data.offerId, (o) => {
      o.commercialStatus = 'Inactive';
      o.retiredReason = e.data.reason;
    }),
  'demand.sourcing_started.v1': sourcingStarted,
  'demand.status_changed.v1': async (s, store, e) => {
    await patchDemand(s, store, e, e.data.demandId, 'journeys', (d) => {
      d.status = e.data.to;
    });
  },
  'demand.exited.v1': async (s, store, e) => {
    await patchDemand(s, store, e, e.data.demandId, 'journeys', (d) => {
      d.exitType = e.data.exit;
    });
  },
  'match.confirmed.v1': async (s, store, e) => {
    if (!(await store.getDemand(e.data.demandId))) return;
    await patchDemand(s, store, e, e.data.demandId, 'other', (d) => {
      d.matched = true;
    });
  },
};
