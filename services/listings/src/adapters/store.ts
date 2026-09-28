// Postgres implementation of the Store port (LLD §3). Every business query goes through tenantScope (NFR-15);
// every query path is served by an index of migration 0002 (see the comments there).
import { sql, tenantScope, withTransaction } from '@11e/db';
import type { Kysely, Selectable, Transaction } from '@11e/db';
import type { SelectQueryBuilder } from 'kysely';
import { queueSend, writeEvent } from '@11e/outbox';
import type {
  ApiKeyRow,
  ChangeRow,
  MergeLogEntry,
  PrivateTermRow,
  PublicCursor,
  PublicItemRow,
  PublicListFilter,
  ScanRecord,
  Store,
  UnitOfWork,
  WorkItem,
} from '../application/ports.js';
import type { ChangeType } from '../domain/levels.js';
import type {
  DemandFacts,
  LifeStage,
  OfferFacts,
  PhotoInfo,
  PhotoStatus,
  ProjectFacts,
  Publication,
  PublicSubjectType,
  SubjectType,
} from '../domain/types.js';
import { SCHEMA, SERVICE } from '../config.js';
import type {
  ApiKeyTable,
  DemandInputTable,
  ListingsDb,
  OfferInputTable,
  PhotoTable,
  ProjectInputTable,
  PublicationTable,
  PublicItemTable,
} from './db.js';

export const WORK_QUEUE = 'q_listings_photos';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const n = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

// ---- row mappers ---------------------------------------------------------------------------------------------------

function offerOf(r: Selectable<OfferInputTable>): OfferFacts {
  return {
    id: r.id,
    code: r.code,
    propertyId: r.property_id,
    projectId: r.project_id,
    dealType: r.deal_type,
    market: r.market,
    segment: r.segment,
    propertyTypes: r.property_types,
    bhkMin: n(r.bhk_min),
    bhkMax: n(r.bhk_max),
    areaSqftMin: n(r.area_sqft_min),
    areaSqftMax: n(r.area_sqft_max),
    areaBasis: r.area_basis as OfferFacts['areaBasis'],
    landAreaSqft: n(r.land_area_sqft),
    salePriceInrMin: n(r.sale_price_inr_min),
    salePriceInrMax: n(r.sale_price_inr_max),
    rentMonthlyInrMin: n(r.rent_monthly_inr_min),
    rentMonthlyInrMax: n(r.rent_monthly_inr_max),
    locality: r.locality,
    micromarket: r.micromarket,
    city: r.city,
    outsideLaunchArea: r.outside_launch_area,
    tenancyStatus: r.tenancy_status,
    saleMode: r.sale_mode,
    possessionStatus: r.possession_status,
    furnishing: r.furnishing,
    possessionDate: r.possession_date,
    unitCount: r.unit_count,
    floorBand: r.floor_band as OfferFacts['floorBand'],
    totalFloors: r.total_floors,
    parking: r.parking,
    amenities: r.amenities,
    selectedPhotoIds: r.selected_photo_ids,
    voidedReason: r.voided_reason,
    recordStage: r.record_stage,
    hasRealPhotos: r.has_real_photos,
    commercialStatus: r.commercial_status,
    lifeStage: r.life_stage as LifeStage | null,
    lifeDay: r.life_day,
    retiredReason: r.retired_reason,
    mergedIntoId: r.merged_into_id,
    recordsVersion: r.records_version,
    journeysVersion: r.journeys_version,
  };
}

function offerRow(o: OfferFacts) {
  return {
    id: o.id,
    code: o.code,
    property_id: o.propertyId,
    project_id: o.projectId,
    deal_type: o.dealType,
    market: o.market,
    segment: o.segment,
    property_types: o.propertyTypes,
    bhk_min: o.bhkMin,
    bhk_max: o.bhkMax,
    area_sqft_min: o.areaSqftMin,
    area_sqft_max: o.areaSqftMax,
    area_basis: o.areaBasis,
    land_area_sqft: o.landAreaSqft,
    sale_price_inr_min: o.salePriceInrMin,
    sale_price_inr_max: o.salePriceInrMax,
    rent_monthly_inr_min: o.rentMonthlyInrMin,
    rent_monthly_inr_max: o.rentMonthlyInrMax,
    locality: o.locality,
    micromarket: o.micromarket,
    city: o.city,
    outside_launch_area: o.outsideLaunchArea,
    tenancy_status: o.tenancyStatus,
    sale_mode: o.saleMode,
    possession_status: o.possessionStatus,
    furnishing: o.furnishing,
    possession_date: o.possessionDate,
    unit_count: o.unitCount,
    floor_band: o.floorBand,
    total_floors: o.totalFloors,
    parking: o.parking,
    amenities: o.amenities,
    selected_photo_ids: o.selectedPhotoIds,
    voided_reason: o.voidedReason,
    record_stage: o.recordStage,
    has_real_photos: o.hasRealPhotos,
    commercial_status: o.commercialStatus,
    life_stage: o.lifeStage,
    life_day: o.lifeDay,
    retired_reason: o.retiredReason,
    merged_into_id: o.mergedIntoId,
    records_version: o.recordsVersion,
    journeys_version: o.journeysVersion,
  };
}

function projectOf(r: Selectable<ProjectInputTable>): ProjectFacts {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    developerName: r.developer_name,
    city: r.city,
    micromarket: r.micromarket,
    locality: r.locality,
    reraNumber: r.rera_number,
    possessionDate: r.possession_date,
    amenities: r.amenities,
    offerIds: r.offer_ids,
    recordsVersion: r.records_version,
  };
}

function demandOf(r: Selectable<DemandInputTable>): DemandFacts {
  return {
    id: r.id,
    code: r.code,
    dealTypes: r.deal_types,
    market: r.market,
    segment: r.segment,
    propertyTypes: r.property_types,
    micromarkets: r.micromarkets,
    areaSqftMin: n(r.area_sqft_min),
    areaSqftMax: n(r.area_sqft_max),
    areaBasis: r.area_basis as DemandFacts['areaBasis'],
    budgetInrMin: n(r.budget_inr_min),
    budgetInrMax: n(r.budget_inr_max),
    rentMonthlyInrMin: n(r.rent_monthly_inr_min),
    rentMonthlyInrMax: n(r.rent_monthly_inr_max),
    moveInBy: r.move_in_by,
    status: r.commercial_status,
    lifeStage: r.life_stage as LifeStage | null,
    exitType: r.exit_type,
    matched: r.matched,
    postRequested: r.post_requested,
    sourcingRequestId: r.sourcing_request_id,
    voidedReason: r.voided_reason,
    mergedIntoId: r.merged_into_id,
    recordsVersion: r.records_version,
    journeysVersion: r.journeys_version,
  };
}

function publicationOf(r: Selectable<PublicationTable>): Publication {
  return {
    id: r.id,
    subjectType: r.subject_type as SubjectType,
    subjectId: r.subject_id,
    level: r.level as Publication['level'],
    ceiling: r.ceiling as Publication['ceiling'],
    ceilingReasons: r.ceiling_reasons,
    lifeStage: r.life_stage,
    publicId: r.public_id,
    publicDescription: r.public_description,
    descriptionSource: r.description_source as Publication['descriptionSource'],
    lastScanId: r.last_scan_id,
    lastChangeReason: r.last_change_reason as Publication['lastChangeReason'],
    lastChangedBy: r.last_changed_by,
    publishedAt: r.published_at,
    version: r.version,
    updatedAt: r.updated_at,
  };
}

function publicationRow(p: Publication) {
  return {
    level: p.level,
    ceiling: p.ceiling,
    ceiling_reasons: p.ceilingReasons,
    life_stage: p.lifeStage,
    public_id: p.publicId,
    public_description: p.publicDescription,
    description_source: p.descriptionSource,
    last_scan_id: p.lastScanId,
    last_change_reason: p.lastChangeReason,
    last_changed_by: p.lastChangedBy,
    published_at: p.publishedAt,
    version: p.version,
    updated_at: p.updatedAt,
  };
}

function photoOf(r: Selectable<PhotoTable>): PhotoInfo {
  return {
    id: r.id,
    propertyId: r.property_id,
    isReal: r.is_real,
    status: r.status as PhotoStatus,
    hasTextDetected: r.has_text_detected,
    publicPath: r.public_path,
    publicName: r.public_name,
    width: r.width,
    height: r.height,
    sortOrder: r.sort_order,
  };
}

function itemOf(r: Selectable<PublicItemTable>): PublicItemRow {
  return {
    id: r.id,
    publicId: r.public_id,
    subjectType: r.subject_type as PublicSubjectType,
    level: r.level as PublicItemRow['level'],
    payload: r.payload,
    payloadHash: r.payload_hash,
    publishedAt: r.published_at,
    priceSortInr: n(r.price_sort_inr),
  };
}

export function apiKeyOf(r: Selectable<ApiKeyTable>): ApiKeyRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    prefix: r.prefix,
    keyHash: r.key_hash,
    status: r.status as ApiKeyRow['status'],
    rateLimitRps: r.rate_limit_rps,
    burst: r.burst,
    allowedOrigins: r.allowed_origins,
    graceEndsAt: r.grace_ends_at,
    replacedByKeyId: r.replaced_by_key_id,
    lastUsedAt: r.last_used_at,
    createdBy: r.created_by,
    revokedAt: r.revoked_at,
    version: r.version,
    createdAt: r.created_at,
  };
}

// ---- the store -----------------------------------------------------------------------------------------------------

export function createStore(trx: Transaction<ListingsDb>, tenantId: string, correlationId: string): Store {
  const t = tenantScope(trx, tenantId);
  const now = () => new Date();

  const findId = async (table: 'offer_input' | 'project_input' | 'demand_input', idOrCode: string) => {
    const q = t.selectFrom(table).select('id');
    const row = UUID.test(idOrCode)
      ? await q.where('id', '=', idOrCode).executeTakeFirst()
      : await q.where('code', '=', idOrCode).executeTakeFirst();
    return row?.id;
  };

  const store: Store = {
    tenantId,
    correlationId,

    async getOffer(id) {
      const r = await t.selectFrom('offer_input').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? offerOf(r) : undefined;
    },
    findOfferId: (idOrCode) => findId('offer_input', idOrCode),
    async saveOffer(o) {
      const row = offerRow(o);
      await t
        .insertInto('offer_input', row)
        .onConflict((oc) => oc.columns(['tenant_id', 'id']).doUpdateSet({ ...row, updated_at: now() }))
        .execute();
    },
    async offersOfProperty(propertyId, limit) {
      const rows = await t
        .selectFrom('offer_input')
        .select('id')
        .where('property_id', '=', propertyId)
        .limit(limit)
        .execute();
      return rows.map((r) => r.id);
    },
    async offersOfProject(projectId, limit) {
      const rows = await t
        .selectFrom('offer_input')
        .select('id')
        .where('project_id', '=', projectId)
        .limit(limit)
        .execute();
      return rows.map((r) => r.id);
    },
    async markScanTermsFetched(propertyId, at) {
      await t
        .updateTable('offer_input')
        .set({ scan_terms_fetched_at: at })
        .where('property_id', '=', propertyId)
        .execute();
    },

    async getProject(id) {
      const r = await t.selectFrom('project_input').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? projectOf(r) : undefined;
    },
    findProjectId: (idOrCode) => findId('project_input', idOrCode),
    async saveProject(p) {
      const row = {
        id: p.id,
        code: p.code,
        name: p.name,
        developer_name: p.developerName,
        city: p.city,
        micromarket: p.micromarket,
        locality: p.locality,
        rera_number: p.reraNumber,
        possession_date: p.possessionDate,
        amenities: p.amenities,
        offer_ids: p.offerIds,
        records_version: p.recordsVersion,
      };
      await t
        .insertInto('project_input', row)
        .onConflict((oc) => oc.columns(['tenant_id', 'id']).doUpdateSet({ ...row, updated_at: now() }))
        .execute();
    },
    async projectsOfOffer(offerId, limit) {
      // The offer's own project_id is the indexed path; offer_ids of a project are resolved from the project side.
      const r = await t
        .selectFrom('offer_input')
        .select('project_id')
        .where('id', '=', offerId)
        .executeTakeFirst();
      return r?.project_id ? [r.project_id].slice(0, limit) : [];
    },

    async getDemand(id) {
      const r = await t.selectFrom('demand_input').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? demandOf(r) : undefined;
    },
    findDemandId: (idOrCode) => findId('demand_input', idOrCode),
    async saveDemand(d) {
      const row = {
        id: d.id,
        code: d.code,
        deal_types: d.dealTypes,
        market: d.market,
        segment: d.segment,
        property_types: d.propertyTypes,
        micromarkets: d.micromarkets,
        area_sqft_min: d.areaSqftMin,
        area_sqft_max: d.areaSqftMax,
        area_basis: d.areaBasis,
        budget_inr_min: d.budgetInrMin,
        budget_inr_max: d.budgetInrMax,
        rent_monthly_inr_min: d.rentMonthlyInrMin,
        rent_monthly_inr_max: d.rentMonthlyInrMax,
        move_in_by: d.moveInBy,
        commercial_status: d.status,
        life_stage: d.lifeStage,
        exit_type: d.exitType,
        matched: d.matched,
        post_requested: d.postRequested,
        sourcing_request_id: d.sourcingRequestId,
        voided_reason: d.voidedReason,
        merged_into_id: d.mergedIntoId,
        records_version: d.recordsVersion,
        journeys_version: d.journeysVersion,
      };
      await t
        .insertInto('demand_input', row)
        .onConflict((oc) => oc.columns(['tenant_id', 'id']).doUpdateSet({ ...row, updated_at: now() }))
        .execute();
    },

    async getPublication(type, subjectId, forUpdate) {
      let q = t
        .selectFrom('publication')
        .selectAll()
        .where('subject_type', '=', type)
        .where('subject_id', '=', subjectId);
      if (forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? publicationOf(r) : undefined;
    },
    async insertPublication(p) {
      await t
        .insertInto('publication', {
          id: p.id,
          subject_type: p.subjectType,
          subject_id: p.subjectId,
          ...publicationRow(p),
        })
        .execute();
    },
    async updatePublication(p) {
      await t.updateTable('publication').set(publicationRow(p)).where('id', '=', p.id).execute();
    },
    async publicIdTaken(publicId) {
      const r = await t
        .selectFrom('publication')
        .select('id')
        .where('public_id', '=', publicId)
        .executeTakeFirst();
      return Boolean(r);
    },
    async listPublications(filter, page) {
      let q = t.selectFrom('publication').selectAll();
      if (filter.subjectType) q = q.where('subject_type', '=', filter.subjectType);
      if (filter.level) q = q.where('level', '=', filter.level);
      if (filter.lifeStage) q = q.where('life_stage', '=', filter.lifeStage);
      if (filter.ceilingBelowLevel === true)
        q = q.where(sql<boolean>`level_rank(level) > level_rank(ceiling)`);
      if (filter.ceilingBelowLevel === false)
        q = q.where(sql<boolean>`level_rank(level) <= level_rank(ceiling)`);
      if (page.after)
        q = q.where(
          sql<boolean>`(updated_at, id) < (${new Date(page.after.t)}::timestamptz, ${page.after.id}::uuid)`,
        );
      const rows = await q.orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(page.limit).execute();
      const out = [];
      for (const r of rows) {
        const pub = publicationOf(r);
        const table =
          pub.subjectType === 'offer'
            ? 'offer_input'
            : pub.subjectType === 'project'
              ? 'project_input'
              : 'demand_input';
        const c = await t.selectFrom(table).select('code').where('id', '=', pub.subjectId).executeTakeFirst();
        const item = await t
          .selectFrom('public_item')
          .select('payload')
          .where('id', '=', pub.id)
          .executeTakeFirst();
        out.push({
          publication: pub,
          code: c?.code ?? '',
          label: typeof item?.payload['label'] === 'string' ? (item.payload['label'] as string) : null,
        });
      }
      return out;
    },

    async getSettings() {
      const r = await t.selectFrom('settings').selectAll().executeTakeFirst();
      return r
        ? {
            mahareraAgentNumber: r.maharera_agent_number,
            note: r.subject_to_confirmation_note,
            version: r.version,
            updatedAt: r.updated_at,
            updatedBy: r.updated_by,
          }
        : undefined;
    },
    async saveSettings(s, isNew) {
      const row = {
        maharera_agent_number: s.mahareraAgentNumber,
        subject_to_confirmation_note: s.note,
        version: s.version,
        updated_by: s.updatedBy,
        updated_at: s.updatedAt,
      };
      if (isNew) await t.insertInto('settings', { id: crypto.randomUUID(), ...row }).execute();
      else await t.updateTable('settings').set(row).execute();
    },

    async getPublicItem(id) {
      const r = await t.selectFrom('public_item').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? itemOf(r) : undefined;
    },
    async upsertPublicItem(item) {
      const f = item.filters;
      const row = {
        id: item.id,
        public_id: item.publicId,
        subject_type: item.subjectType,
        level: item.level,
        payload: JSON.stringify(item.payload),
        payload_hash: item.payloadHash,
        deal_type: f.dealType,
        deal_types: f.dealTypes,
        market: f.market,
        segment: f.segment,
        city: f.city,
        micromarket: f.micromarket,
        locality: f.locality,
        micromarket_path: f.micromarketPath,
        property_types: f.propertyTypes,
        bhk_min: f.bhkMin,
        bhk_max: f.bhkMax,
        area_sqft_min: f.areaSqftMin,
        area_sqft_max: f.areaSqftMax,
        sale_price_inr_min: f.salePriceInrMin,
        rent_monthly_inr_min: f.rentMonthlyInrMin,
        price_sort_inr: f.priceSortInr,
        possession_sort: f.possessionSort,
        sale_mode: f.saleMode,
        tenancy_status: f.tenancyStatus,
        furnishing: f.furnishing,
        project_public_id: f.projectPublicId,
        published_at: item.publishedAt,
        updated_at: now(),
      };
      await t
        .insertInto('public_item', row)
        .onConflict((oc) => oc.columns(['tenant_id', 'id']).doUpdateSet(row))
        .execute();
    },
    async deletePublicItem(id) {
      await t.deleteFrom('public_item').where('id', '=', id).execute();
    },
    async appendChange(e) {
      await t
        .insertInto('change_feed', {
          id: crypto.randomUUID(),
          public_id: e.publicId,
          subject_type: e.subjectType,
          change_type: e.changeType,
          level: e.level,
          occurred_at: e.occurredAt,
        })
        .execute();
    },
    async micromarketAncestors() {
      const r = await t
        .selectFrom('vocabulary_release')
        .select('micromarkets')
        .where('active', '=', true)
        .executeTakeFirst();
      return r?.micromarkets ?? {};
    },
    async saveMicromarkets(ancestors) {
      const active = await t
        .selectFrom('vocabulary_release')
        .select('id')
        .where('active', '=', true)
        .executeTakeFirst();
      if (active) {
        await t
          .updateTable('vocabulary_release')
          .set({ micromarkets: JSON.stringify(ancestors), updated_at: now() })
          .where('id', '=', active.id)
          .execute();
      } else {
        await t
          .insertInto('vocabulary_release', {
            id: crypto.randomUUID(),
            version: 'v0.6',
            checksum: '',
            values: '{}',
            micromarkets: JSON.stringify(ancestors),
            active: true,
          })
          .execute();
      }
    },
    async saveVocabularyRelease(version, checksum) {
      const active = await t
        .selectFrom('vocabulary_release')
        .select(['id', 'version', 'micromarkets'])
        .where('active', '=', true)
        .executeTakeFirst();
      if (active?.version === version) {
        await t
          .updateTable('vocabulary_release')
          .set({ checksum, updated_at: now() })
          .where('id', '=', active.id)
          .execute();
        return;
      }
      if (active)
        await t
          .updateTable('vocabulary_release')
          .set({ active: false })
          .where('id', '=', active.id)
          .execute();
      await t
        .insertInto('vocabulary_release', {
          id: crypto.randomUUID(),
          version,
          checksum,
          values: '{}',
          micromarkets: JSON.stringify(active?.micromarkets ?? {}),
          active: true,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'version']).doUpdateSet({ checksum, active: true, updated_at: now() }),
        )
        .execute();
    },
    async publicationsAfter(afterId, limit) {
      let q = t.selectFrom('publication').select(['id', 'subject_type', 'subject_id']);
      if (afterId) q = q.where('id', '>', afterId);
      const rows = await q.orderBy('id').limit(limit).execute();
      return rows.map((r) => ({
        id: r.id,
        subjectType: r.subject_type as SubjectType,
        subjectId: r.subject_id,
      }));
    },

    async getPhoto(id) {
      const r = await t.selectFrom('photo').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? photoOf(r) : undefined;
    },
    async getPhotoFull(id) {
      const r = await t.selectFrom('photo').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? { ...photoOf(r), privatePath: r.private_path } : undefined;
    },
    async photosByIds(ids) {
      if (!ids.length) return [];
      const rows = await t
        .selectFrom('photo')
        .selectAll()
        .where('id', 'in', [...ids])
        .execute();
      return rows.map(photoOf);
    },
    async photosOfProperty(propertyId, limit) {
      const rows = await t
        .selectFrom('photo')
        .selectAll()
        .where('property_id', '=', propertyId)
        .orderBy('sort_order')
        .limit(limit)
        .execute();
      return rows.map(photoOf);
    },
    async savePhotoAdded(p) {
      const next = await t
        .selectFrom('photo')
        .select(sql<number>`coalesce(max(sort_order), -1) + 1`.as('n'))
        .where('property_id', '=', p.propertyId)
        .executeTakeFirst();
      const r = await t
        .insertInto('photo', {
          id: p.id,
          property_id: p.propertyId,
          origin: p.origin,
          is_real: p.isReal,
          source_storage_path: p.sourceStoragePath,
          has_text_detected: p.hasTextDetected,
          status: 'pending',
          sort_order: Number(next?.n ?? 0),
          attempts: 0,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return Boolean(r);
    },
    async markPhotoRemoved(id) {
      await t
        .updateTable('photo')
        .set({ status: 'removed', updated_at: now() })
        .where('id', '=', id)
        .execute();
    },
    async markPhotoReady(id, privatePath, width, height) {
      await t
        .updateTable('photo')
        .set({ status: 'ready', private_path: privatePath, width, height, updated_at: now() })
        .where('id', '=', id)
        .where('status', '=', 'pending')
        .execute();
    },
    async markPhotoAttempt(id, maxAttempts) {
      const r = await t
        .updateTable('photo')
        .set({
          attempts: sql<number>`attempts + 1`,
          status: sql<string>`case when attempts + 1 >= ${maxAttempts} then 'failed' else status end`,
          updated_at: now(),
        })
        .where('id', '=', id)
        .returning('attempts')
        .executeTakeFirst();
      return r?.attempts ?? maxAttempts;
    },
    async setPhotoPublic(id, publicName, publicPath) {
      await t
        .updateTable('photo')
        .set({ public_name: publicName || null, public_path: publicPath, updated_at: now() })
        .where('id', '=', id)
        .execute();
    },
    async photoUsedByPublicOffer(photoId, propertyId) {
      const offers = await t
        .selectFrom('offer_input')
        .select('id')
        .where('property_id', '=', propertyId)
        .where(sql<boolean>`${photoId}::uuid = any(selected_photo_ids)`)
        .limit(100)
        .execute();
      if (!offers.length) return false;
      const r = await t
        .selectFrom('publication')
        .select('id')
        .where('subject_type', '=', 'offer')
        .where(
          'subject_id',
          'in',
          offers.map((o) => o.id),
        )
        .where('level', '=', 'Public')
        .limit(1)
        .executeTakeFirst();
      return Boolean(r);
    },

    async termsForProperty(propertyId) {
      const rows = await t
        .selectFrom('private_term')
        .selectAll()
        .where('property_id', '=', propertyId)
        .execute();
      return rows.map((r) => ({
        propertyId: r.property_id,
        kind: r.kind as PrivateTermRow['kind'],
        tokenHash: r.token_hash,
        ngram: r.ngram,
        saltKeyId: r.salt_key_id,
      }));
    },
    async tenantTermHashes(hashes) {
      if (!hashes.length) return [];
      const rows = await t
        .selectFrom('private_term')
        .select(['property_id', 'kind', 'token_hash', 'ngram', 'salt_key_id'])
        .where('token_hash', '=', sql<string>`any(${[...hashes]}::text[])`)
        .limit(1000)
        .execute();
      return rows.map((r) => ({
        propertyId: r.property_id,
        kind: r.kind as PrivateTermRow['kind'],
        tokenHash: r.token_hash,
        ngram: r.ngram,
        saltKeyId: r.salt_key_id,
      }));
    },
    async replaceTerms(propertyId, terms, at) {
      await t.deleteFrom('private_term').where('property_id', '=', propertyId).execute();
      if (terms.length)
        await t
          .insertInto(
            'private_term',
            terms.map((x) => ({
              id: crypto.randomUUID(),
              property_id: propertyId,
              kind: x.kind,
              token_hash: x.tokenHash,
              ngram: x.ngram,
              salt_key_id: x.saltKeyId,
              fetched_at: at,
            })),
          )
          .execute();
    },
    async saveScan(s: ScanRecord) {
      await t
        .insertInto('privacy_scan', {
          id: s.id,
          subject_type: s.subjectType,
          subject_id: s.subjectId,
          text_sha256: s.textSha256,
          rules_version: s.rulesVersion,
          result: s.result,
          findings: JSON.stringify(s.findings),
          scanned_by: s.scannedBy,
          created_at: s.createdAt,
        })
        .execute();
    },
    async getScan(id) {
      const r = await t.selectFrom('privacy_scan').selectAll().where('id', '=', id).executeTakeFirst();
      return r
        ? {
            id: r.id,
            subjectType: r.subject_type as SubjectType,
            subjectId: r.subject_id,
            textSha256: r.text_sha256,
            rulesVersion: r.rules_version,
            result: r.result as ScanRecord['result'],
            findings: r.findings as ScanRecord['findings'],
            scannedBy: r.scanned_by,
            createdAt: r.created_at,
          }
        : undefined;
    },

    async insertApiKey(k) {
      await t
        .insertInto('api_key', {
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          key_hash: k.keyHash,
          status: k.status,
          rate_limit_rps: k.rateLimitRps,
          burst: k.burst,
          allowed_origins: k.allowedOrigins,
          grace_ends_at: k.graceEndsAt,
          replaced_by_key_id: k.replacedByKeyId,
          last_used_at: k.lastUsedAt,
          created_by: k.createdBy,
          revoked_at: k.revokedAt,
          version: k.version,
          created_at: k.createdAt,
          updated_at: k.createdAt,
        })
        .execute();
    },
    async getApiKey(id, forUpdate) {
      let q = t.selectFrom('api_key').selectAll().where('id', '=', id);
      if (forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? apiKeyOf(r) : undefined;
    },
    async updateApiKey(k) {
      k.version += 1;
      await t
        .updateTable('api_key')
        .set({
          status: k.status,
          grace_ends_at: k.graceEndsAt,
          replaced_by_key_id: k.replacedByKeyId,
          revoked_at: k.revokedAt,
          version: k.version,
          updated_at: now(),
        })
        .where('id', '=', k.id)
        .execute();
    },
    async listApiKeys(status, limit, after) {
      let q = t.selectFrom('api_key').selectAll();
      if (status) q = q.where('status', '=', status);
      if (after)
        q = q.where(sql<boolean>`(created_at, id) < (${new Date(after.t)}::timestamptz, ${after.id}::uuid)`);
      const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
      return rows.map(apiKeyOf);
    },

    async listPublicItems(f, limit, after) {
      let q = t.selectFrom('public_item').selectAll().where('subject_type', '=', f.subjectType);
      q = applyFilters(q, f);
      if (f.sort === 'newest') {
        if (after)
          q = q.where(
            sql<boolean>`(published_at, id) < (${new Date(after.t)}::timestamptz, ${after.id}::uuid)`,
          );
        q = q.orderBy('published_at', 'desc').orderBy('id', 'desc');
      } else {
        const asc = f.sort === 'priceAsc';
        if (after) q = q.where(priceAfter(after, asc));
        q = asc
          ? q.orderBy(sql`price_sort_inr asc nulls last`).orderBy('id', 'asc')
          : q.orderBy(sql`price_sort_inr desc nulls last`).orderBy('id', 'desc');
      }
      const rows = await q.limit(limit).execute();
      return rows.map(itemOf);
    },
    async getPublicItemByPublicId(subjectType, publicId) {
      const r = await t
        .selectFrom('public_item')
        .selectAll()
        .where('public_id', '=', publicId)
        .where('subject_type', '=', subjectType)
        .executeTakeFirst();
      return r ? itemOf(r) : undefined;
    },
    async changesAfter(seq, limit, notAfter) {
      const rows = await t
        .selectFrom('change_feed')
        .select(['seq', 'public_id', 'subject_type', 'change_type', 'level', 'occurred_at'])
        .where(sql<boolean>`seq > ${seq}`)
        .where('occurred_at', '<=', notAfter)
        .orderBy('seq')
        .limit(limit)
        .execute();
      return rows.map((r): ChangeRow => ({
        seq: Number(r.seq),
        publicId: r.public_id,
        subjectType: r.subject_type as PublicSubjectType,
        changeType: r.change_type as ChangeType,
        level: r.level as ChangeRow['level'],
        occurredAt: r.occurred_at,
      }));
    },
    async firstChangeAtOrAfter(at) {
      const r = await t
        .selectFrom('change_feed')
        .select('seq')
        .where('occurred_at', '>=', at)
        .orderBy('occurred_at')
        .orderBy('seq')
        .limit(1)
        .executeTakeFirst();
      return r ? Number(r.seq) : undefined;
    },
    async lastChangeSeq() {
      const r = await t
        .selectFrom('change_feed')
        .select('seq')
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      return r ? Number(r.seq) : 0;
    },

    async logMerge(e: MergeLogEntry) {
      await t
        .insertInto('merge_log', {
          id: crypto.randomUUID(),
          merge_id: e.mergeId,
          subject_type: e.subjectType,
          subject_id: e.subjectId,
          prior: JSON.stringify(e.prior),
        })
        .execute();
    },
    async mergeEntries(mergeId, limit) {
      const rows = await t
        .selectFrom('merge_log')
        .selectAll()
        .where('merge_id', '=', mergeId)
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        mergeId: r.merge_id,
        subjectType: r.subject_type as SubjectType,
        subjectId: r.subject_id,
        prior: r.prior as MergeLogEntry['prior'],
      }));
    },

    async emitPublicationChanged(c) {
      await writeEvent(trx, {
        eventType: 'publication.changed.v1',
        tenantId,
        aggregateType: 'publication',
        aggregateId: c.publication.id,
        // publication.version is bumped when the row is saved in this transaction: +1 keeps versions increasing.
        aggregateVersion: c.publication.version + 1,
        correlationId,
        producer: SERVICE,
        data: {
          subjectType: c.publication.subjectType,
          subjectId: c.publication.subjectId,
          from: c.from,
          to: c.to,
          reason: c.reason,
          ...(c.publication.publicId ? { publicId: c.publication.publicId } : {}),
        },
      });
    },
    async emitAudit(a) {
      await writeEvent(trx, {
        eventType: 'audit.recorded.v1',
        tenantId,
        aggregateType: 'audit',
        aggregateId: crypto.randomUUID(),
        aggregateVersion: 1,
        correlationId,
        producer: SERVICE,
        data: {
          action: a.action,
          actorUserId: a.actorUserId,
          subjectType: a.subjectType,
          subjectId: a.subjectId,
          via: a.via,
          details: a.details,
        },
      });
    },
    async enqueue(item: WorkItem) {
      await queueSend(trx, SCHEMA, WORK_QUEUE, item);
    },
  };
  return store;
}

type PublicQuery = SelectQueryBuilder<ListingsDb, 'public_item', Selectable<PublicItemTable>>;

function applyFilters(query: PublicQuery, f: PublicListFilter): PublicQuery {
  let q = query;
  if (f.dealType)
    q =
      f.subjectType === 'demand_post'
        ? q.where(sql<boolean>`${f.dealType} = any(deal_types)`)
        : q.where('deal_type', '=', f.dealType);
  if (f.market) q = q.where('market', '=', f.market);
  if (f.segment) q = q.where('segment', '=', f.segment);
  if (f.propertyType) q = q.where(sql<boolean>`property_types @> array[${f.propertyType}]::text[]`);
  if (f.city) q = q.where(sql<boolean>`lower(city) = lower(${f.city})`);
  if (f.micromarket) q = q.where(sql<boolean>`micromarket_path @> array[${f.micromarket}]::text[]`);
  if (f.locality) q = q.where(sql<boolean>`micromarket_path @> array[${f.locality}]::text[]`);
  if (f.bhkMin !== undefined) q = q.where(sql<boolean>`coalesce(bhk_max, bhk_min) >= ${f.bhkMin}`);
  if (f.bhkMax !== undefined) q = q.where(sql<boolean>`coalesce(bhk_min, bhk_max) <= ${f.bhkMax}`);
  if (f.areaSqftMin !== undefined)
    q = q.where(sql<boolean>`coalesce(area_sqft_max, area_sqft_min) >= ${f.areaSqftMin}`);
  if (f.areaSqftMax !== undefined)
    q = q.where(sql<boolean>`coalesce(area_sqft_min, area_sqft_max) <= ${f.areaSqftMax}`);
  if (f.salePriceInrMax !== undefined) q = q.where('sale_price_inr_min', '<=', f.salePriceInrMax as never);
  if (f.rentMonthlyInrMax !== undefined)
    q = q.where('rent_monthly_inr_min', '<=', f.rentMonthlyInrMax as never);
  if (f.priceInrMax !== undefined) q = q.where('sale_price_inr_min', '<=', f.priceInrMax as never);
  if (f.possessionBy) q = q.where(sql<boolean>`possession_sort <= ${f.possessionBy}::date`);
  if (f.saleMode) q = q.where('sale_mode', '=', f.saleMode);
  if (f.tenancyStatus) q = q.where('tenancy_status', '=', f.tenancyStatus);
  if (f.furnishing) q = q.where('furnishing', '=', f.furnishing);
  if (f.level) q = q.where('level', '=', f.level);
  if (f.projectPublicId) q = q.where('project_public_id', '=', f.projectPublicId);
  return q;
}

function priceAfter(after: PublicCursor, asc: boolean) {
  const id = after.id;
  if (after.p === null || after.p === undefined) {
    // Already in the null tail: continue by id.
    return asc
      ? sql<boolean>`(price_sort_inr is null and id > ${id}::uuid)`
      : sql<boolean>`(price_sort_inr is null and id < ${id}::uuid)`;
  }
  const p = after.p;
  return asc
    ? sql<boolean>`(price_sort_inr > ${p}::bigint or (price_sort_inr = ${p}::bigint and id > ${id}::uuid) or price_sort_inr is null)`
    : sql<boolean>`(price_sort_inr < ${p}::bigint or (price_sort_inr = ${p}::bigint and id < ${id}::uuid) or price_sort_inr is null)`;
}

/** UnitOfWork over withTransaction: one transaction per use case, bound to a tenant. */
export function createUnitOfWork(db: Kysely<ListingsDb>, statementTimeoutMs = 2000): UnitOfWork {
  return {
    run: (tenantId, correlationId, fn) =>
      withTransaction(db, (trx) => fn(createStore(trx, tenantId, correlationId)), { statementTimeoutMs }),
  };
}

/** Store bound to an existing transaction (event handlers share the drain transaction). */
export function storeIn(trx: Transaction<ListingsDb>, tenantId: string, correlationId: string): Store {
  return createStore(trx, tenantId, correlationId);
}
