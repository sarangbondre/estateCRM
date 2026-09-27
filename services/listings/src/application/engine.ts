// The publication engine: ceiling evaluation, level changes, the public projection and the change feed, all in the
// caller's transaction (LLD §4.2, §4.3, §4.7, §4.8). Used by the staff use cases, the event consumers and the jobs.
import { decideDowngrade } from '../domain/autoDowngrade.js';
import type { CeilingResult } from '../domain/ceiling.js';
import { computeDemandCeiling, computeOfferCeiling, computeProjectCeiling } from '../domain/ceiling.js';
import { publicIdFrom } from '../domain/ids.js';
import { demandLabel, supplyLabel } from '../domain/labels.js';
import { changeType, isVisible, rank } from '../domain/levels.js';
import {
  contentOf,
  demandClassifiable,
  micromarketPath,
  offerClassifiable,
  periodStart,
  publicDemandPost,
  publicOffer,
  publicProject,
} from '../domain/projection.js';
import type { ConfigurationOffer, PublicPhoto } from '../domain/projection.js';
import { resolvedSegment } from '../domain/labels.js';
import type {
  ChangeReason,
  DemandFacts,
  Level,
  OfferFacts,
  ProjectFacts,
  Publication,
  PublicationSettings,
  SubjectType,
} from '../domain/types.js';
import { DEFAULT_NOTE, SYSTEM_ACTOR, publicSubjectType } from '../domain/types.js';
import type { Services } from './context.js';
import type { PublicItemWrite, Store } from './ports.js';

const CASCADE_LIMIT = 200;

export type Facts =
  | { type: 'offer'; offer: OfferFacts; project: ProjectFacts | undefined }
  | { type: 'project'; project: ProjectFacts }
  | { type: 'demand_post'; demand: DemandFacts };

export async function loadFacts(store: Store, type: SubjectType, id: string): Promise<Facts | undefined> {
  if (type === 'offer') {
    const offer = await store.getOffer(id);
    if (!offer) return undefined;
    const project = offer.projectId ? await store.getProject(offer.projectId) : undefined;
    return { type, offer, project };
  }
  if (type === 'project') {
    const project = await store.getProject(id);
    return project ? { type, project } : undefined;
  }
  const demand = await store.getDemand(id);
  return demand ? { type, demand } : undefined;
}

/** Configuration offers of a project: its offerIds plus offers pointing at it (bounded). */
export async function configurationIds(store: Store, project: ProjectFacts): Promise<string[]> {
  const ids = new Set(project.offerIds.slice(0, CASCADE_LIMIT));
  for (const id of await store.offersOfProject(project.id, CASCADE_LIMIT)) ids.add(id);
  return [...ids].slice(0, CASCADE_LIMIT);
}

export async function readyRealSelected(store: Store, offer: OfferFacts): Promise<number> {
  if (!offer.selectedPhotoIds.length) return 0;
  const photos = await store.photosByIds(offer.selectedPhotoIds);
  return photos.filter((p) => p.isReal && p.status === 'ready').length;
}

export async function evaluate(
  s: Services,
  store: Store,
  pub: Publication,
  facts: Facts,
  settings: PublicationSettings | undefined,
): Promise<CeilingResult> {
  const agentNumberSet = Boolean(settings?.mahareraAgentNumber);
  switch (facts.type) {
    case 'offer':
      return computeOfferCeiling(
        {
          offer: facts.offer,
          agentNumberSet,
          projectReraNumber: facts.project?.reraNumber ?? null,
          readyRealSelectedPhotos: await readyRealSelected(store, facts.offer),
          currentLevel: pub.level,
          classifiable: offerClassifiable(facts.offer),
        },
        s.policy,
      );
    case 'project': {
      const ceilings: Level[] = [];
      for (const id of await configurationIds(store, facts.project)) {
        const p = await store.getPublication('offer', id);
        if (p) ceilings.push(p.ceiling);
      }
      return computeProjectCeiling(
        { project: facts.project, agentNumberSet, configurationCeilings: ceilings },
        s.policy,
      );
    }
    case 'demand_post': {
      const r = computeDemandCeiling({ demand: facts.demand, agentNumberSet }, s.policy);
      if (!demandClassifiable(facts.demand) && r.ceiling !== 'Private')
        return { ceiling: 'Private', reasons: [...r.reasons, 'demand_not_sourcing'] };
      return r;
    }
  }
}

/** Generated label shown on staff cards (never stored). */
export function labelOf(facts: Facts): string | null {
  switch (facts.type) {
    case 'offer':
      return supplyLabel(
        facts.offer.dealType,
        facts.offer.market,
        resolvedSegment(facts.offer.segment, facts.offer.propertyTypes),
      );
    case 'project':
      return supplyLabel('Sale', 'Primary', null);
    case 'demand_post':
      return demandLabel(facts.demand.dealTypes, facts.demand.market, facts.demand.segment);
  }
}

export async function newPublication(s: Services, store: Store, type: SubjectType, subjectId: string) {
  const existing = await store.getPublication(type, subjectId, true);
  if (existing) return existing;
  const now = s.clock.now();
  const pub: Publication = {
    id: s.random.uuid(),
    subjectType: type,
    subjectId,
    level: 'Private',
    ceiling: 'Private',
    ceilingReasons: [],
    lifeStage: null,
    publicId: null,
    publicDescription: null,
    descriptionSource: 'generated',
    lastScanId: null,
    lastChangeReason: null,
    lastChangedBy: null,
    publishedAt: null,
    version: 1,
    updatedAt: now,
  };
  await store.insertPublication(pub);
  return pub;
}

/** Issues `L-…` on the first publish; stable for the subject's life (LLD §4.6). */
export async function ensurePublicId(s: Services, store: Store, pub: Publication): Promise<string> {
  if (pub.publicId) return pub.publicId;
  for (let i = 0; i < 4; i++) {
    const candidate = publicIdFrom(s.random.bytes(8));
    if (!(await store.publicIdTaken(candidate))) {
      pub.publicId = candidate;
      return candidate;
    }
  }
  throw new Error('could not issue a unique public id');
}

export interface ChangeActor {
  userId: string;
  via: 'ui' | 'chat' | 'system';
}

/** Applies a new level and emits publication.changed.v1 when it changed (outbox, same transaction). */
export async function setLevel(
  s: Services,
  store: Store,
  pub: Publication,
  level: Level,
  reason: ChangeReason,
  actor: ChangeActor,
): Promise<boolean> {
  if (pub.level === level) return false;
  const from = pub.level;
  if (isVisible(level)) await ensurePublicId(s, store, pub);
  if (!isVisible(from) && isVisible(level)) pub.publishedAt = s.clock.now();
  if (!isVisible(level)) pub.publishedAt = null;
  pub.level = level;
  pub.lastChangeReason = reason;
  pub.lastChangedBy = actor.userId;
  await store.emitPublicationChanged({ publication: pub, from, to: level, reason });
  return true;
}

/** Persists the publication row with a new version. */
export async function savePublication(s: Services, store: Store, pub: Publication) {
  pub.version += 1;
  pub.updatedAt = s.clock.now();
  await store.updatePublication(pub);
}

// ---- projection ----------------------------------------------------------------------------------------------------

interface Built {
  payload: Record<string, unknown>;
  filters: PublicItemWrite['filters'];
}

async function offerPhotos(
  s: Services,
  store: Store,
  offer: OfferFacts,
  pub: Publication,
): Promise<PublicPhoto[]> {
  if (!offer.selectedPhotoIds.length) return [];
  const photos = await store.photosByIds(offer.selectedPhotoIds);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const out: PublicPhoto[] = [];
  for (const id of offer.selectedPhotoIds) {
    const p = byId.get(id);
    if (!p || p.status !== 'ready') continue;
    if (p.publicPath) {
      out.push({
        url: s.publicPhotoUrl(p.publicPath),
        ...(p.width !== null ? { width: p.width } : {}),
        ...(p.height !== null ? { height: p.height } : {}),
      });
    } else if (pub.level === 'Public') {
      await store.enqueue({ kind: 'photo-publish', tenantId: store.tenantId, photoId: p.id });
    }
  }
  return out;
}

async function build(
  s: Services,
  store: Store,
  pub: Publication,
  facts: Facts,
  settings: PublicationSettings | undefined,
  publishedAt: Date,
  updatedAt: Date,
): Promise<Built> {
  const common = {
    publicId: pub.publicId as string,
    agentReraNumber: settings?.mahareraAgentNumber ?? null,
    note: settings?.note ?? DEFAULT_NOTE,
    publishedAt,
    updatedAt,
  };
  const ancestors = await store.micromarketAncestors();
  if (facts.type === 'offer') {
    const o = facts.offer;
    const projectPub = facts.project ? await store.getPublication('project', facts.project.id) : undefined;
    const projectPublicId = projectPub && isVisible(projectPub.level) ? projectPub.publicId : null;
    const photos = pub.level === 'Public' ? await offerPhotos(s, store, o, pub) : [];
    const payload = publicOffer({
      ...common,
      offer: o,
      level: pub.level === 'Public' ? 'Public' : 'Anonymous',
      projectPublicId,
      projectReraNumber: facts.project?.reraNumber ?? null,
      photos,
      staffDescription: pub.descriptionSource === 'staff' ? pub.publicDescription : null,
    });
    const sale = o.dealType !== 'Lease';
    return {
      payload,
      filters: {
        dealType: o.dealType,
        dealTypes: null,
        market: o.market,
        segment: (payload['segment'] as string | null) ?? null,
        city: o.city,
        micromarket: o.micromarket,
        locality: o.locality,
        micromarketPath: micromarketPath([o.locality, o.micromarket], ancestors),
        propertyTypes: o.propertyTypes,
        bhkMin: o.bhkMin,
        bhkMax: o.bhkMax,
        areaSqftMin: o.areaSqftMin,
        areaSqftMax: o.areaSqftMax,
        salePriceInrMin: sale ? o.salePriceInrMin : null,
        rentMonthlyInrMin: sale ? null : o.rentMonthlyInrMin,
        priceSortInr: sale ? o.salePriceInrMin : o.rentMonthlyInrMin,
        possessionSort: periodStart(o.possessionDate),
        saleMode: o.saleMode,
        tenancyStatus: o.tenancyStatus,
        furnishing: o.furnishing,
        projectPublicId,
      },
    };
  }
  if (facts.type === 'project') {
    const p = facts.project;
    const configurations: ConfigurationOffer[] = [];
    for (const id of await configurationIds(store, p)) {
      const offer = await store.getOffer(id);
      const opub = await store.getPublication('offer', id);
      if (offer && opub && rank(opub.level) >= rank('Anonymous'))
        configurations.push({ offer, publicId: opub.publicId, level: opub.level });
    }
    const payload = publicProject({ ...common, project: p, configurations, photos: [] });
    const prices = configurations.map((c) => c.offer.salePriceInrMin).filter((x): x is number => x !== null);
    const bhks = configurations
      .flatMap((c) => [c.offer.bhkMin, c.offer.bhkMax])
      .filter((x): x is number => x !== null);
    const areas = configurations
      .flatMap((c) => [c.offer.areaSqftMin, c.offer.areaSqftMax])
      .filter((x): x is number => x !== null);
    const types = [...new Set(configurations.flatMap((c) => c.offer.propertyTypes))];
    return {
      payload,
      filters: {
        dealType: 'Sale',
        dealTypes: null,
        market: 'Primary',
        segment: null,
        city: p.city,
        micromarket: p.micromarket,
        locality: p.locality,
        micromarketPath: micromarketPath([p.locality, p.micromarket], ancestors),
        propertyTypes: types,
        bhkMin: bhks.length ? Math.min(...bhks) : null,
        bhkMax: bhks.length ? Math.max(...bhks) : null,
        areaSqftMin: areas.length ? Math.min(...areas) : null,
        areaSqftMax: areas.length ? Math.max(...areas) : null,
        salePriceInrMin: prices.length ? Math.min(...prices) : null,
        rentMonthlyInrMin: null,
        priceSortInr: prices.length ? Math.min(...prices) : null,
        possessionSort: periodStart(p.possessionDate),
        saleMode: null,
        tenancyStatus: null,
        furnishing: null,
        projectPublicId: null,
      },
    };
  }
  const d = facts.demand;
  const payload = publicDemandPost({ ...common, demand: d });
  return {
    payload,
    filters: {
      dealType: d.dealTypes[0] ?? null,
      dealTypes: d.dealTypes,
      market: d.market,
      segment: d.segment,
      city: null,
      micromarket: d.micromarkets[0] ?? null,
      locality: null,
      micromarketPath: micromarketPath(d.micromarkets, ancestors),
      propertyTypes: d.propertyTypes,
      bhkMin: null,
      bhkMax: null,
      areaSqftMin: d.areaSqftMin,
      areaSqftMax: d.areaSqftMax,
      salePriceInrMin: null,
      rentMonthlyInrMin: null,
      priceSortInr: null,
      possessionSort: null,
      saleMode: null,
      tenancyStatus: null,
      furnishing: null,
      projectPublicId: null,
    },
  };
}

/**
 * Brings public_item in line with the publication: upsert while Anonymous/Public, delete when Private, and append
 * the change-feed row for the visible transition (published / updated / upgraded / downgraded / withdrawn).
 */
export async function syncProjection(
  s: Services,
  store: Store,
  pub: Publication,
  facts: Facts,
  settings: PublicationSettings | undefined,
  options: { rewrite?: boolean } = {},
): Promise<void> {
  const existing = await store.getPublicItem(pub.id);
  const now = s.clock.now();
  const subjectType = publicSubjectType(pub.subjectType);
  if (!isVisible(pub.level)) {
    if (existing) {
      await store.deletePublicItem(pub.id);
      await store.appendChange({
        publicId: existing.publicId,
        subjectType,
        changeType: 'withdrawn',
        level: null,
        occurredAt: now,
      });
    }
    await unpublishPhotos(store, facts);
    return;
  }
  await ensurePublicId(s, store, pub);
  const publishedAt = pub.publishedAt ?? existing?.publishedAt ?? now;
  const first = await build(s, store, pub, facts, settings, publishedAt, now);
  const hash = s.sha256(contentOf(first.payload));
  if (pub.level !== 'Public') await unpublishPhotos(store, facts);
  const kind = changeType(existing?.level ?? 'Private', pub.level, hash !== existing?.payloadHash);
  if (!kind && !options.rewrite) return;
  if (!kind && existing) {
    // Filter columns only (e.g. micromarket paths): keep the served payload and its timestamps.
    first.payload['updatedAt'] =
      (existing.payload['updatedAt'] as string | undefined) ?? first.payload['updatedAt'];
  }
  await store.upsertPublicItem({
    id: pub.id,
    publicId: pub.publicId as string,
    subjectType,
    level: pub.level,
    payload: first.payload,
    payloadHash: hash,
    publishedAt,
    filters: first.filters,
  });
  if (!kind) return;
  await store.appendChange({
    publicId: pub.publicId as string,
    subjectType,
    changeType: kind,
    level: pub.level,
    occurredAt: now,
  });
}

/** Public photo copies are deleted when the offer is no longer Public (the worker keeps shared ones). */
async function unpublishPhotos(store: Store, facts: Facts) {
  if (facts.type !== 'offer' || !facts.offer.selectedPhotoIds.length) return;
  for (const p of await store.photosByIds(facts.offer.selectedPhotoIds))
    if (p.publicPath)
      await store.enqueue({ kind: 'photo-unpublish', tenantId: store.tenantId, photoId: p.id });
}

// ---- reconcile -----------------------------------------------------------------------------------------------------

export interface ReconcileOptions {
  /** Cascade offer ↔ project (default true). */
  cascade?: boolean;
  /** Force a projection rebuild (settings or vocabulary change). */
  refresh?: boolean;
}

/**
 * Recomputes the ceiling after an input change, auto-downgrades if the level is now above it (never raises),
 * refreshes the projection, and cascades to the project / configuration offers.
 */
export async function reconcile(
  s: Services,
  store: Store,
  type: SubjectType,
  subjectId: string,
  options: ReconcileOptions = {},
): Promise<Publication | undefined> {
  const facts = await loadFacts(store, type, subjectId);
  if (!facts) return undefined;
  const pub = await newPublication(s, store, type, subjectId);
  const settings = await store.getSettings();
  const before = {
    level: pub.level,
    ceiling: pub.ceiling,
    reasons: pub.ceilingReasons.join(','),
    life: pub.lifeStage,
  };
  const result = await evaluate(s, store, pub, facts, settings);
  pub.ceiling = result.ceiling;
  pub.ceilingReasons = result.reasons;
  pub.lifeStage = lifeStageOf(facts);
  const down = decideDowngrade(type, pub.level, result.ceiling, result.reasons);
  if (down) {
    const from = pub.level;
    await setLevel(s, store, pub, down.level, down.reason, { userId: SYSTEM_ACTOR, via: 'system' });
    await store.emitAudit({
      action: 'publication.auto_changed',
      actorUserId: SYSTEM_ACTOR,
      subjectType: type,
      subjectId,
      via: 'system',
      details: { from, to: down.level, reason: down.reason },
    });
  }
  const changed =
    before.level !== pub.level ||
    before.ceiling !== pub.ceiling ||
    before.reasons !== pub.ceilingReasons.join(',') ||
    before.life !== pub.lifeStage;
  if (changed) await savePublication(s, store, pub);
  if (changed || options.refresh || isVisible(pub.level) || before.level !== pub.level)
    await syncProjection(s, store, pub, facts, settings, { rewrite: options.refresh === true });
  if (options.cascade !== false) await cascade(s, store, facts, options);
  return pub;
}

async function cascade(s: Services, store: Store, facts: Facts, options: ReconcileOptions) {
  const next = { ...options, cascade: false };
  if (facts.type === 'offer') {
    const projects = new Set(await store.projectsOfOffer(facts.offer.id, 20));
    if (facts.offer.projectId) projects.add(facts.offer.projectId);
    for (const id of projects) await reconcile(s, store, 'project', id, next);
  } else if (facts.type === 'project') {
    for (const id of await configurationIds(store, facts.project))
      await reconcile(s, store, 'offer', id, next);
  }
}

function lifeStageOf(facts: Facts): string | null {
  if (facts.type === 'offer') return facts.offer.lifeStage;
  if (facts.type === 'demand_post') return facts.demand.lifeStage;
  return null;
}
