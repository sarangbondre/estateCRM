// Postgres implementation of the application ports (src/application/ports.ts), bound to one transaction.
// Business queries go through tenantScope (NFR-15); every query path is served by an index of migration 0002.
import { randomUUID } from 'node:crypto';
import { sql, tenantScope, withTransaction } from '@11e/db';
import type { Kysely, Transaction } from '@11e/db';
import { queueSend, writeEvent } from '@11e/outbox';
import type { EventDataMap, EventType } from '@11e/outbox';
import { Hierarchy } from '../domain/micromarket.js';
import type { MmLevel } from '../domain/micromarket.js';
import { availabilityPeriod } from '../domain/dates.js';
import { demandMatchKeys, offerMatchKeys, priceKeyOf } from '../domain/matchable.js';
import type {
  AreaBasis,
  BundleGrouping,
  CloseReason,
  IsoDate,
  MatchFlag,
  MatchStatus,
  RejectReason,
} from '../domain/types.js';
import type { WeightsBody } from '../domain/weights.js';
import { DEFAULT_WEIGHTS } from '../domain/weights.js';
import type {
  BundleRecord,
  DealRecord,
  DemandRecord,
  ExclusionRecord,
  MatchRecord,
  OfferRecord,
  OutgoingEvent,
  RunRecord,
  Store,
  UnitOfWork,
  WeightsRecord,
} from '../application/ports.js';
import type { CrmEngineDb } from './db.js';

export const SCHEMA = 'crm_engine';
export const RESCORE_QUEUE = 'q_crm_engine_rescore';
const PRODUCER = 'crm-engine';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = Kysely<CrmEngineDb> | Transaction<CrmEngineDb>;

// --- value mapping -----------------------------------------------------------------------------------------------------
const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);
const pad = (n: number) => String(n).padStart(2, '0');
export function dateStr(v: Date | string | null | undefined): IsoDate | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}
const json = (v: unknown) => JSON.stringify(v);

// Kysely's Selectable is enough for reading; typed loosely here to keep the mapper small.
type Row = Record<string, unknown>;

function toOffer(r: Row): OfferRecord {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    code: r['code'] as string,
    propertyId: r['property_id'] as string,
    projectId: (r['project_id'] as string | null) ?? null,
    buildingKey: (r['building_key'] as string | null) ?? null,
    dealType: r['deal_type'] as string,
    market: (r['market'] as string | null) ?? null,
    segment: (r['segment'] as string | null) ?? null,
    propertyTypes: (r['property_types'] as string[]) ?? [],
    bhkMin: num(r['bhk_min'] as string | null),
    bhkMax: num(r['bhk_max'] as string | null),
    areaSqftMin: num(r['area_sqft_min'] as string | null),
    areaSqftMax: num(r['area_sqft_max'] as string | null),
    areaBasis: (r['area_basis'] as AreaBasis | null) ?? null,
    landAreaSqft: num(r['land_area_sqft'] as string | null),
    salePriceInrMin: num(r['sale_price_inr_min'] as string | null),
    salePriceInrMax: num(r['sale_price_inr_max'] as string | null),
    rentMonthlyInrMin: num(r['rent_monthly_inr_min'] as string | null),
    rentMonthlyInrMax: num(r['rent_monthly_inr_max'] as string | null),
    depositInr: num(r['deposit_inr'] as string | null),
    currentRentInr: num(r['current_rent_inr'] as string | null),
    micromarket: (r['micromarket'] as string | null) ?? null,
    locality: (r['locality'] as string | null) ?? null,
    mmPath: (r['mm_path'] as string[]) ?? [],
    zone: (r['zone'] as string | null) ?? null,
    outsideLaunchArea: r['outside_launch_area'] as boolean,
    tenancyStatus: (r['tenancy_status'] as string | null) ?? null,
    saleMode: (r['sale_mode'] as string | null) ?? null,
    possessionStatus: (r['possession_status'] as string | null) ?? null,
    possessionDateRaw: (r['possession_date_raw'] as string | null) ?? null,
    tenure: (r['tenure'] as string | null) ?? null,
    agreementForm: (r['agreement_form'] as string | null) ?? null,
    isJodi: (r['is_jodi'] as boolean | null) ?? null,
    parking: (r['parking'] as number | null) ?? null,
    amenities: (r['amenities'] as string[]) ?? [],
    floorBand: (r['floor_band'] as string | null) ?? null,
    totalFloors: (r['total_floors'] as number | null) ?? null,
    priceSheetDate: dateStr(r['price_sheet_date'] as Date | null),
    lastSeenDate: dateStr(r['last_seen_date'] as Date | null),
    furnishing: (r['furnishing'] as string | null) ?? null,
    unitCount: (r['unit_count'] as number | null) ?? null,
    recordStage: (r['record_stage'] as string | null) ?? null,
    lifeStage: r['life_stage'] as string,
    commercialStatus: r['commercial_status'] as string,
    voided: r['voided'] as boolean,
    mergedInto: (r['merged_into'] as string | null) ?? null,
    factsVersion: r['facts_version'] as number,
    priceVersion: r['price_version'] as number,
    lifeVersion: r['life_version'] as number,
    commercialVersion: r['commercial_version'] as number,
  };
}

function toDemand(r: Row): DemandRecord {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    code: r['code'] as string,
    dealTypes: (r['deal_types'] as string[]) ?? [],
    market: (r['market'] as string | null) ?? null,
    segment: (r['segment'] as string | null) ?? null,
    propertyTypes: (r['property_types'] as string[]) ?? [],
    bhkMin: num(r['bhk_min'] as string | null),
    bhkMax: num(r['bhk_max'] as string | null),
    areaSqftMin: num(r['area_sqft_min'] as string | null),
    areaSqftMax: num(r['area_sqft_max'] as string | null),
    areaBasis: (r['area_basis'] as AreaBasis | null) ?? null,
    budgetInrMin: num(r['budget_inr_min'] as string | null),
    budgetInrMax: num(r['budget_inr_max'] as string | null),
    rentMonthlyInrMin: num(r['rent_monthly_inr_min'] as string | null),
    rentMonthlyInrMax: num(r['rent_monthly_inr_max'] as string | null),
    micromarkets: (r['micromarkets'] as string[]) ?? [],
    localities: (r['localities'] as string[]) ?? [],
    mmExpanded: (r['mm_expanded'] as string[]) ?? [],
    moveInFrom: dateStr(r['move_in_from'] as Date | null),
    moveInBy: dateStr(r['move_in_by'] as Date | null),
    statedTags: (r['stated_tags'] as Record<string, string>) ?? {},
    outsideLaunchArea: r['outside_launch_area'] as boolean,
    recordStage: (r['record_stage'] as string | null) ?? null,
    qualified: r['qualified'] as boolean,
    ownerUserId: (r['owner_user_id'] as string | null) ?? null,
    lifeStage: r['life_stage'] as string,
    commercialStatus: r['commercial_status'] as string,
    exitType: (r['exit_type'] as string | null) ?? null,
    voided: r['voided'] as boolean,
    mergedInto: (r['merged_into'] as string | null) ?? null,
    factsVersion: r['facts_version'] as number,
    lifeVersion: r['life_version'] as number,
    statusVersion: r['status_version'] as number,
  };
}

export function toMatch(r: Row): MatchRecord {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    code: r['code'] as string,
    demandId: r['demand_id'] as string,
    offerIds: r['offer_ids'] as string[],
    offerSetKey: r['offer_set_key'] as string,
    isBundle: r['is_bundle'] as boolean,
    bundleId: (r['bundle_id'] as string | null) ?? null,
    score: r['score'] as number,
    rank: (r['rank'] as number | null) ?? null,
    factors: r['factors'] as MatchRecord['factors'],
    flags: (r['flags'] as MatchFlag[]) ?? [],
    status: r['status'] as MatchStatus,
    closedReason: (r['closed_reason'] as CloseReason | null) ?? null,
    closedByDealId: (r['closed_by_deal_id'] as string | null) ?? null,
    priorStatus: (r['prior_status'] as MatchStatus | null) ?? null,
    rejectedReason: (r['rejected_reason'] as RejectReason | null) ?? null,
    rejectedScore: (r['rejected_score'] as number | null) ?? null,
    rejectedFactsVersion: (r['rejected_facts_version'] as number | null) ?? null,
    origin: r['origin'] as 'engine' | 'user',
    weightsVersion: r['weights_version'] as number,
    confirmedBy: (r['confirmed_by'] as string | null) ?? null,
    confirmedAt: (r['confirmed_at'] as Date | null) ?? null,
    openDealId: (r['open_deal_id'] as string | null) ?? null,
    proposalSentAt: (r['proposal_sent_at'] as Date | null) ?? null,
    visitedAt: (r['visited_at'] as Date | null) ?? null,
    version: r['version'] as number,
    createdAt: r['created_at'] as Date,
    updatedAt: r['updated_at'] as Date,
  };
}

export function toBundle(r: Row): BundleRecord {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    code: r['code'] as string,
    demandId: r['demand_id'] as string,
    offerIds: r['offer_ids'] as string[],
    grouping: r['grouping'] as BundleGrouping,
    combinedAreaSqft: Number(r['combined_area_sqft']),
    combinedPriceInr: num(r['combined_price_inr'] as string | null),
    combinedRentMonthlyInr: num(r['combined_rent_monthly_inr'] as string | null),
    origin: r['origin'] as 'engine' | 'user',
    createdBy: (r['created_by'] as string | null) ?? null,
    matchId: (r['match_id'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
  };
}

function toRun(r: Row): RunRecord {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    scope: r['scope'] as RunRecord['scope'],
    subjectId: (r['subject_id'] as string | null) ?? null,
    trigger: r['trigger'] as string,
    status: r['status'] as RunRecord['status'],
    candidates: (r['candidates'] as number | null) ?? null,
    suggested: (r['suggested'] as number | null) ?? null,
    closed: (r['closed'] as number | null) ?? null,
    excluded: (r['excluded'] as number | null) ?? null,
    error: (r['error'] as string | null) ?? null,
    requestedBy: (r['requested_by'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
    startedAt: (r['started_at'] as Date | null) ?? null,
    finishedAt: (r['finished_at'] as Date | null) ?? null,
  };
}

function toDeal(r: Row): DealRecord {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    demandId: r['demand_id'] as string,
    offerId: r['offer_id'] as string,
    status: r['status'] as DealRecord['status'],
    unitsBooked: (r['units_booked'] as number | null) ?? null,
    closedAt: (r['closed_at'] as Date | null) ?? null,
  };
}

function toWeights(r: Row): WeightsRecord {
  const body = r['body'] as Partial<WeightsBody>;
  return {
    version: r['version'] as number,
    factors: { ...DEFAULT_WEIGHTS.factors, ...(body.factors ?? {}) },
    tuning: {
      ...DEFAULT_WEIGHTS.tuning,
      ...(body.tuning ?? {}),
      proximity: { ...DEFAULT_WEIGHTS.tuning.proximity, ...(body.tuning?.proximity ?? {}) },
    },
    createdBy: (r['created_by'] as string | null) ?? null,
    createdAt: r['created_at'] as Date,
  };
}

// --- in-memory hierarchy cache (per process, keyed by reference_state.mm_version) ---------------------------------------
const hierarchyCache = new Map<string, { version: number; h: Hierarchy }>();
export const MAX_MM_NODES = 50_000;

/** Test hook: forget cached hierarchies. */
export function clearHierarchyCache(): void {
  hierarchyCache.clear();
}

export interface StoreContext {
  correlationId: string;
  now: () => Date;
}

export function createStore(db: Db, ctx: StoreContext): Store {
  const scope = (tenantId: string) => tenantScope(db, tenantId);

  const offerRowValues = (o: OfferRecord) => {
    const period = availabilityPeriod(o.possessionDateRaw, o.possessionStatus);
    return {
      id: o.id,
      code: o.code,
      property_id: o.propertyId,
      project_id: o.projectId,
      building_key: o.buildingKey,
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
      deposit_inr: o.depositInr,
      current_rent_inr: o.currentRentInr,
      price_key: priceKeyOf(o),
      micromarket: o.micromarket,
      locality: o.locality,
      mm_path: o.mmPath,
      zone: o.zone,
      outside_launch_area: o.outsideLaunchArea,
      tenancy_status: o.tenancyStatus,
      sale_mode: o.saleMode,
      possession_status: o.possessionStatus,
      possession_date_raw: o.possessionDateRaw,
      tenure: o.tenure,
      agreement_form: o.agreementForm,
      is_jodi: o.isJodi,
      parking: o.parking,
      amenities: o.amenities,
      floor_band: o.floorBand,
      total_floors: o.totalFloors,
      price_sheet_date: o.priceSheetDate,
      last_seen_date: o.lastSeenDate,
      available_from: period?.from ?? null,
      available_to: period?.to ?? null,
      furnishing: o.furnishing,
      unit_count: o.unitCount,
      record_stage: o.recordStage,
      life_stage: o.lifeStage,
      commercial_status: o.commercialStatus,
      voided: o.voided,
      merged_into: o.mergedInto,
      match_keys: offerMatchKeys(o),
      facts_version: o.factsVersion,
      price_version: o.priceVersion,
      life_version: o.lifeVersion,
      commercial_version: o.commercialVersion,
      updated_at: ctx.now(),
    };
  };

  const demandRowValues = (d: DemandRecord) => ({
    id: d.id,
    code: d.code,
    deal_types: d.dealTypes,
    market: d.market,
    segment: d.segment,
    property_types: d.propertyTypes,
    bhk_min: d.bhkMin,
    bhk_max: d.bhkMax,
    area_sqft_min: d.areaSqftMin,
    area_sqft_max: d.areaSqftMax,
    area_basis: d.areaBasis,
    budget_inr_min: d.budgetInrMin,
    budget_inr_max: d.budgetInrMax,
    rent_monthly_inr_min: d.rentMonthlyInrMin,
    rent_monthly_inr_max: d.rentMonthlyInrMax,
    micromarkets: d.micromarkets,
    localities: d.localities,
    mm_expanded: d.mmExpanded,
    move_in_from: d.moveInFrom,
    move_in_by: d.moveInBy,
    stated_tags: json(d.statedTags),
    outside_launch_area: d.outsideLaunchArea,
    record_stage: d.recordStage,
    qualified: d.qualified,
    owner_user_id: d.ownerUserId,
    life_stage: d.lifeStage,
    commercial_status: d.commercialStatus,
    exit_type: d.exitType,
    voided: d.voided,
    merged_into: d.mergedInto,
    match_keys: demandMatchKeys(d),
    facts_version: d.factsVersion,
    life_version: d.lifeVersion,
    status_version: d.statusVersion,
    updated_at: ctx.now(),
  });

  const byIdOrCode = (idOrCode: string) =>
    UUID.test(idOrCode)
      ? { col: 'id' as const, v: idOrCode.toLowerCase() }
      : { col: 'code' as const, v: idOrCode };

  const matchValues = (m: MatchRecord) => ({
    code: m.code,
    demand_id: m.demandId,
    offer_ids: [...m.offerIds].sort(),
    offer_set_key: m.offerSetKey,
    is_bundle: m.isBundle,
    bundle_id: m.bundleId,
    score: m.score,
    rank: m.rank,
    factors: json(m.factors),
    flags: m.flags,
    status: m.status,
    closed_reason: m.closedReason,
    closed_by_deal_id: m.closedByDealId,
    prior_status: m.priorStatus,
    rejected_reason: m.rejectedReason,
    rejected_score: m.rejectedScore,
    rejected_facts_version: m.rejectedFactsVersion,
    origin: m.origin,
    weights_version: m.weightsVersion,
    confirmed_by: m.confirmedBy,
    confirmed_at: m.confirmedAt,
    open_deal_id: m.openDealId,
    proposal_sent_at: m.proposalSentAt,
    visited_at: m.visitedAt,
  });

  const store: Store = {
    mx: {
      async getOffer(t, id) {
        if (!UUID.test(id)) return null;
        const r = await scope(t).selectFrom('offer_mx').selectAll().where('id', '=', id).executeTakeFirst();
        return r ? toOffer(r as Row) : null;
      },
      async getOffers(t, ids) {
        const valid = ids.filter((i) => UUID.test(i));
        if (!valid.length) return [];
        const rows = await scope(t).selectFrom('offer_mx').selectAll().where('id', 'in', valid).execute();
        return rows.map((r) => toOffer(r as Row));
      },
      async getDemand(t, id) {
        if (!UUID.test(id)) return null;
        const r = await scope(t).selectFrom('demand_mx').selectAll().where('id', '=', id).executeTakeFirst();
        return r ? toDemand(r as Row) : null;
      },
      async getDemands(t, ids) {
        const valid = ids.filter((i) => UUID.test(i));
        if (!valid.length) return [];
        const rows = await scope(t).selectFrom('demand_mx').selectAll().where('id', 'in', valid).execute();
        return rows.map((r) => toDemand(r as Row));
      },
      async saveOffer(o) {
        const v = offerRowValues(o);
        await scope(o.tenantId)
          .insertInto('offer_mx', v)
          .onConflict((oc) =>
            oc.column('id').doUpdateSet(({ ref }) =>
              Object.fromEntries(
                Object.keys(v)
                  .filter((k) => k !== 'id')
                  .map((k) => [k, ref(`excluded.${k}` as 'excluded.code')]),
              ),
            ),
          )
          .execute();
      },
      async saveDemand(d) {
        const v = demandRowValues(d);
        await scope(d.tenantId)
          .insertInto('demand_mx', v)
          .onConflict((oc) =>
            oc.column('id').doUpdateSet(({ ref }) =>
              Object.fromEntries(
                Object.keys(v)
                  .filter((k) => k !== 'id')
                  .map((k) => [k, ref(`excluded.${k}` as 'excluded.code')]),
              ),
            ),
          )
          .execute();
      },
      async resolveOffer(t, idOrCode) {
        const k = byIdOrCode(idOrCode);
        const r = await scope(t)
          .selectFrom('offer_mx')
          .select(['id', 'code'])
          .where(k.col, '=', k.v)
          .executeTakeFirst();
        return r ? { id: r.id, code: r.code } : null;
      },
      async resolveDemand(t, idOrCode) {
        const k = byIdOrCode(idOrCode);
        const r = await scope(t)
          .selectFrom('demand_mx')
          .select(['id', 'code'])
          .where(k.col, '=', k.v)
          .executeTakeFirst();
        return r ? { id: r.id, code: r.code } : null;
      },
      async codesOf(t, offerIds, demandIds) {
        const out = new Map<string, string>();
        if (offerIds.length)
          for (const r of await scope(t)
            .selectFrom('offer_mx')
            .select(['id', 'code'])
            .where('id', 'in', [...new Set(offerIds)])
            .execute())
            out.set(r.id, r.code);
        if (demandIds.length)
          for (const r of await scope(t)
            .selectFrom('demand_mx')
            .select(['id', 'code'])
            .where('id', 'in', [...new Set(demandIds)])
            .execute())
            out.set(r.id, r.code);
        return out;
      },
      async offerCandidates(t, keys, limit, priceCap) {
        if (!keys.length) return [];
        let q = scope(t)
          .selectFrom('offer_mx')
          .selectAll()
          .where('is_matchable', '=', true)
          .where(sql<boolean>`match_keys && ${sql.val([...keys])}::text[]`);
        if (priceCap !== undefined)
          q = q.where((eb) => eb.or([eb('price_key', 'is', null), eb('price_key', '<=', priceCap)]));
        const rows = await q.limit(limit).execute();
        return rows.map((r) => toOffer(r as Row));
      },
      async unliveOfferCandidates(t, keys, limit) {
        if (!keys.length) return [];
        const rows = await scope(t)
          .selectFrom('offer_mx')
          .selectAll()
          .where('is_matchable', '=', false)
          .where('voided', '=', false)
          .where('merged_into', 'is', null)
          .where('outside_launch_area', '=', false)
          .where(sql<boolean>`match_keys && ${sql.val([...keys])}::text[]`)
          .limit(limit)
          .execute();
        return rows.map((r) => toOffer(r as Row));
      },
      async demandCandidates(t, keys, limit) {
        if (!keys.length) return [];
        const rows = await scope(t)
          .selectFrom('demand_mx')
          .selectAll()
          .where('is_matchable', '=', true)
          .where(sql<boolean>`match_keys && ${sql.val([...keys])}::text[]`)
          .limit(limit)
          .execute();
        return rows.map((r) => toDemand(r as Row));
      },
      async demandIdsAfter(t, after, limit, liveOnly) {
        let q = scope(t).selectFrom('demand_mx').select('id');
        if (liveOnly) q = q.where('is_matchable', '=', true);
        if (after) q = q.where('id', '>', after);
        return (await q.orderBy('id').limit(limit).execute()).map((r) => r.id);
      },
      async offerIdsAfter(t, after, limit) {
        let q = scope(t).selectFrom('offer_mx').select('id');
        if (after) q = q.where('id', '>', after);
        return (await q.orderBy('id').limit(limit).execute()).map((r) => r.id);
      },
      async timeSensitiveDemandIds(t, byDate, after, limit) {
        let q = scope(t)
          .selectFrom('demand_mx')
          .select('id')
          .where('is_matchable', '=', true)
          .where('move_in_by', 'is not', null)
          .where('move_in_by', '<=', byDate);
        if (after) q = q.where('id', '>', after);
        return (await q.orderBy('id').limit(limit).execute()).map((r) => r.id);
      },
      async tenants() {
        const r = await sql<{ tenant_id: string }>`select tenant_id from (
            select distinct tenant_id from ${sql.table('demand_mx')}
            union select distinct tenant_id from ${sql.table('offer_mx')}
            union select tenant_id from ${sql.table('reference_state')}) t limit 1000`.execute(db);
        return r.rows.map((x) => x.tenant_id);
      },
    },

    matches: {
      async get(t, idOrCode) {
        const k = byIdOrCode(idOrCode);
        const r = await scope(t).selectFrom('matches').selectAll().where(k.col, '=', k.v).executeTakeFirst();
        return r ? toMatch(r as Row) : null;
      },
      async getMany(t, ids) {
        const valid = ids.filter((i) => UUID.test(i));
        if (!valid.length) return [];
        return (await scope(t).selectFrom('matches').selectAll().where('id', 'in', valid).execute()).map(
          (r) => toMatch(r as Row),
        );
      },
      async byPair(t, demandId, offerSetKey) {
        const r = await scope(t)
          .selectFrom('matches')
          .selectAll()
          .where('demand_id', '=', demandId)
          .where('offer_set_key', '=', offerSetKey)
          .executeTakeFirst();
        return r ? toMatch(r as Row) : null;
      },
      async listForDemand(t, demandId, limit) {
        const rows = await scope(t)
          .selectFrom('matches')
          .selectAll()
          .where('demand_id', '=', demandId)
          .orderBy('status')
          .orderBy('score', 'desc')
          .orderBy('id')
          .limit(limit)
          .execute();
        return rows.map((r) => toMatch(r as Row));
      },
      async listForOffer(t, offerId, statuses, limit) {
        let q = tenantScope(db, t)
          .selectFrom('match_offers')
          .innerJoin('matches', 'matches.id', 'match_offers.match_id')
          .selectAll('matches')
          .where('match_offers.offer_id', '=', offerId);
        if (statuses) q = q.where('match_offers.status', 'in', [...statuses]);
        const rows = await q.limit(limit).execute();
        return rows.map((r) => toMatch(r as Row));
      },
      async listClosedByDeal(t, dealId, limit) {
        const rows = await scope(t)
          .selectFrom('matches')
          .selectAll()
          .where('closed_by_deal_id', '=', dealId)
          .limit(limit)
          .execute();
        return rows.map((r) => toMatch(r as Row));
      },
      async insert(m) {
        await scope(m.tenantId)
          .insertInto('matches', {
            id: m.id,
            ...matchValues(m),
            version: m.version,
            created_at: m.createdAt,
            updated_at: m.updatedAt,
          })
          .execute();
        await scope(m.tenantId)
          .insertInto(
            'match_offers',
            m.offerIds.map((offerId) => ({
              id: randomUUID(),
              match_id: m.id,
              offer_id: offerId,
              demand_id: m.demandId,
              status: m.status,
              score: m.score,
            })),
          )
          .execute();
      },
      async update(m) {
        const now = ctx.now();
        const r = await scope(m.tenantId)
          .updateTable('matches')
          .set({ ...matchValues(m), version: sql<number>`version + 1`, updated_at: now })
          .where('id', '=', m.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const current = toMatch(r as Row);
        const existing = await scope(m.tenantId)
          .selectFrom('match_offers')
          .select(['offer_id'])
          .where('match_id', '=', m.id)
          .execute();
        const have = new Set(existing.map((e) => e.offer_id));
        const want = new Set(current.offerIds);
        const stale = [...have].filter((x) => !want.has(x));
        if (stale.length)
          await scope(m.tenantId)
            .deleteFrom('match_offers')
            .where('match_id', '=', m.id)
            .where('offer_id', 'in', stale)
            .execute();
        const missing = [...want].filter((x) => !have.has(x));
        if (missing.length)
          await scope(m.tenantId)
            .insertInto(
              'match_offers',
              missing.map((offerId) => ({
                id: randomUUID(),
                match_id: m.id,
                offer_id: offerId,
                demand_id: current.demandId,
                status: current.status,
                score: current.score,
              })),
            )
            .execute();
        await scope(m.tenantId)
          .updateTable('match_offers')
          .set({ status: current.status, score: current.score, demand_id: current.demandId })
          .where('match_id', '=', m.id)
          .execute();
        return current;
      },
      async nextCode(t, prefix) {
        const r = await sql<{
          v: string;
        }>`insert into ${sql.table('code_sequences')} (tenant_id, prefix, next_value)
            values (${t}, ${prefix}, 2)
            on conflict (tenant_id, prefix) do update set next_value = code_sequences.next_value + 1
            returning (next_value - 1)::text as v`.execute(db);
        const v = Number(r.rows[0]?.v ?? 1);
        return `${prefix}-${String(v).padStart(4, '0')}`;
      },
    },

    bundles: {
      async get(t, idOrCode) {
        const k = byIdOrCode(idOrCode);
        const r = await scope(t).selectFrom('bundles').selectAll().where(k.col, '=', k.v).executeTakeFirst();
        return r ? toBundle(r as Row) : null;
      },
      async getMany(t, ids) {
        const valid = ids.filter((i) => UUID.test(i));
        if (!valid.length) return [];
        return (await scope(t).selectFrom('bundles').selectAll().where('id', 'in', valid).execute()).map(
          (r) => toBundle(r as Row),
        );
      },
      async insert(b) {
        await scope(b.tenantId)
          .insertInto('bundles', {
            id: b.id,
            code: b.code,
            demand_id: b.demandId,
            offer_ids: [...b.offerIds].sort(),
            grouping: b.grouping,
            combined_area_sqft: b.combinedAreaSqft,
            combined_price_inr: b.combinedPriceInr,
            combined_rent_monthly_inr: b.combinedRentMonthlyInr,
            origin: b.origin,
            created_by: b.createdBy,
            match_id: b.matchId,
            created_at: b.createdAt,
            updated_at: b.createdAt,
          })
          .execute();
      },
      async setMatch(t, bundleId, matchId) {
        await scope(t)
          .updateTable('bundles')
          .set({ match_id: matchId, updated_at: ctx.now() })
          .where('id', '=', bundleId)
          .execute();
      },
    },

    exclusions: {
      async replaceForDemand(t, demandId, rows) {
        await scope(t).deleteFrom('exclusions').where('demand_id', '=', demandId).execute();
        if (rows.length)
          await scope(t)
            .insertInto(
              'exclusions',
              rows.map((r) => exclusionValues(r)),
            )
            .onConflict((oc) => oc.columns(['tenant_id', 'demand_id', 'offer_id']).doNothing())
            .execute();
      },
      async upsertPair(t, row) {
        await scope(t)
          .insertInto('exclusions', exclusionValues(row))
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'demand_id', 'offer_id']).doUpdateSet({
              reason: row.reason,
              available_from: row.availableFrom,
              move_in_by: row.moveInBy,
              computed_at: row.computedAt,
            }),
          )
          .execute();
      },
      async deletePair(t, demandId, offerId) {
        await scope(t)
          .deleteFrom('exclusions')
          .where('demand_id', '=', demandId)
          .where('offer_id', '=', offerId)
          .execute();
      },
    },

    runs: {
      async create(r) {
        await scope(r.tenantId)
          .insertInto('matching_runs', {
            id: r.id,
            scope: r.scope,
            subject_id: r.subjectId,
            trigger: r.trigger,
            status: r.status,
            candidates: r.candidates,
            suggested: r.suggested,
            closed: r.closed,
            excluded: r.excluded,
            error: r.error,
            requested_by: r.requestedBy,
            created_at: r.createdAt,
            started_at: r.startedAt,
            finished_at: r.finishedAt,
          })
          .execute();
      },
      async get(t, id) {
        if (!UUID.test(id)) return null;
        const r = await scope(t)
          .selectFrom('matching_runs')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        return r ? toRun(r as Row) : null;
      },
      async activeForSubject(t, subjectId) {
        const r = await scope(t)
          .selectFrom('matching_runs')
          .selectAll()
          .where('subject_id', '=', subjectId)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (!r) return null;
        const run = toRun(r as Row);
        return run.status === 'queued' || run.status === 'running' ? run : null;
      },
      async update(t, id, patch) {
        const set: Record<string, unknown> = {};
        const map: Record<string, string> = {
          status: 'status',
          candidates: 'candidates',
          suggested: 'suggested',
          closed: 'closed',
          excluded: 'excluded',
          error: 'error',
          startedAt: 'started_at',
          finishedAt: 'finished_at',
        };
        for (const [k, v] of Object.entries(patch)) if (map[k]) set[map[k]] = v;
        if (!Object.keys(set).length) return;
        await scope(t).updateTable('matching_runs').set(set).where('id', '=', id).execute();
      },
    },

    deals: {
      async upsert(d) {
        await scope(d.tenantId)
          .insertInto('deals', {
            id: d.id,
            demand_id: d.demandId,
            offer_id: d.offerId,
            status: d.status,
            units_booked: d.unitsBooked,
            closed_at: d.closedAt,
            updated_at: ctx.now(),
          })
          .onConflict((oc) =>
            oc
              .column('id')
              .doUpdateSet({
                status: d.status,
                units_booked: d.unitsBooked,
                closed_at: d.closedAt,
                updated_at: ctx.now(),
              }),
          )
          .execute();
      },
      async get(t, id) {
        const r = await scope(t).selectFrom('deals').selectAll().where('id', '=', id).executeTakeFirst();
        return r ? toDeal(r as Row) : null;
      },
      async latestClosedForOffer(t, offerId) {
        const r = await scope(t)
          .selectFrom('deals')
          .selectAll()
          .where('offer_id', '=', offerId)
          .where('status', '=', 'closed')
          .orderBy('closed_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        return r ? toDeal(r as Row) : null;
      },
      async latestClosedForDemand(t, demandId) {
        const r = await scope(t)
          .selectFrom('deals')
          .selectAll()
          .where('demand_id', '=', demandId)
          .where('status', '=', 'closed')
          .orderBy('closed_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        return r ? toDeal(r as Row) : null;
      },
    },

    feedback: {
      async insert(t, f) {
        await scope(t)
          .insertInto('feedback', {
            id: randomUUID(),
            match_id: f.matchId,
            demand_id: f.demandId,
            action: f.action,
            source: f.source,
            reason_code: f.reasonCode,
            score: f.score,
            factors: json(f.factors),
            weights_version: f.weightsVersion,
            by_user: f.byUser,
            at: f.at,
          })
          .execute();
      },
    },

    weights: {
      async active(t) {
        const r = await scope(t)
          .selectFrom('weights')
          .selectAll()
          .where('active', '=', true)
          .executeTakeFirst();
        return r ? toWeights(r as Row) : null;
      },
      async version(t, version) {
        const r = await scope(t)
          .selectFrom('weights')
          .selectAll()
          .where('version', '=', version)
          .executeTakeFirst();
        return r ? toWeights(r as Row) : null;
      },
      async create(t, body, createdBy) {
        const cur = await sql<{
          v: number | null;
        }>`select max(version) as v from ${sql.table('weights')} where tenant_id = ${t}`.execute(db);
        const version = (cur.rows[0]?.v ?? 0) + 1;
        await scope(t).updateTable('weights').set({ active: false }).where('active', '=', true).execute();
        const now = ctx.now();
        await scope(t)
          .insertInto('weights', {
            id: randomUUID(),
            version,
            body: json(body),
            active: true,
            created_by: createdBy,
            created_at: now,
          })
          .execute();
        return { version, factors: body.factors, tuning: body.tuning, createdBy, createdAt: now };
      },
    },

    hierarchy: {
      async version(t) {
        const r = await scope(t).selectFrom('reference_state').select('mm_version').executeTakeFirst();
        return r?.mm_version ?? 0;
      },
      async load(t) {
        const version = await store.hierarchy.version(t);
        const cached = hierarchyCache.get(t);
        if (cached && cached.version === version) return cached.h;
        const rows = await scope(t)
          .selectFrom('micromarket_nodes')
          .select(['node_key', 'level', 'name', 'name_keys', 'parent_key', 'adjacent_keys', 'in_launch_area'])
          .limit(MAX_MM_NODES)
          .execute();
        const h = new Hierarchy(
          rows.map((r) => ({
            key: r.node_key,
            level: r.level as MmLevel,
            name: r.name,
            nameKeys: r.name_keys,
            parentKey: r.parent_key,
            adjacentKeys: r.adjacent_keys,
            inLaunchArea: r.in_launch_area,
          })),
        );
        hierarchyCache.set(t, { version, h });
        return h;
      },
      async replace(t, nodes, version) {
        const h = Hierarchy.fromSource(nodes);
        const now = ctx.now();
        const keep = new Set(nodes.map((n) => n.id));
        const existing = await scope(t)
          .selectFrom('micromarket_nodes')
          .select('node_key')
          .limit(MAX_MM_NODES)
          .execute();
        const gone = existing.map((e) => e.node_key).filter((k) => !keep.has(k));
        for (let i = 0; i < gone.length; i += 1000)
          await scope(t)
            .deleteFrom('micromarket_nodes')
            .where('node_key', 'in', gone.slice(i, i + 1000))
            .execute();
        const rows = nodes.map((n) => {
          const node = h.node(n.id);
          return {
            id: randomUUID(),
            node_key: n.id,
            level: n.level,
            name: n.name,
            name_keys: node?.nameKeys ?? [],
            parent_key: n.parentId,
            path: h.ancestry(n.id).map((a) => a.key),
            adjacent_keys: n.adjacentIds,
            in_launch_area: n.inLaunchArea,
            release_version: version,
            updated_at: now,
          };
        });
        for (let i = 0; i < rows.length; i += 500)
          await scope(t)
            .insertInto('micromarket_nodes', rows.slice(i, i + 500))
            .onConflict((oc) =>
              oc.columns(['tenant_id', 'node_key']).doUpdateSet(({ ref }) => ({
                level: ref('excluded.level'),
                name: ref('excluded.name'),
                name_keys: ref('excluded.name_keys'),
                parent_key: ref('excluded.parent_key'),
                path: ref('excluded.path'),
                adjacent_keys: ref('excluded.adjacent_keys'),
                in_launch_area: ref('excluded.in_launch_area'),
                release_version: ref('excluded.release_version'),
                updated_at: ref('excluded.updated_at'),
              })),
            )
            .execute();
        const next = Math.max(version, (await store.hierarchy.version(t)) + 1);
        await scope(t)
          .insertInto('reference_state', {
            mm_version: next,
            mm_loaded_at: now,
            mm_requested_version: null,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc
              .column('tenant_id')
              .doUpdateSet({
                mm_version: next,
                mm_loaded_at: now,
                mm_requested_version: null,
                updated_at: now,
              }),
          )
          .execute();
      },
      async requestRefresh(t, version) {
        const now = ctx.now();
        await scope(t)
          .insertInto('reference_state', {
            mm_version: 0,
            mm_requested_version: version ?? 0,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc.column('tenant_id').doUpdateSet({ mm_requested_version: version ?? 0, updated_at: now }),
          )
          .execute();
      },
      async cacheVocabulary(t, version, checksum, body) {
        await scope(t)
          .updateTable('vocabulary_cache')
          .set({ active: false })
          .where('active', '=', true)
          .where('version', '<>', version)
          .execute();
        await scope(t)
          .insertInto('vocabulary_cache', {
            id: randomUUID(),
            version,
            checksum,
            body: json(body ?? {}),
            active: true,
          })
          .onConflict((oc) =>
            oc
              .columns(['tenant_id', 'version'])
              .doUpdateSet({ checksum, body: json(body ?? {}), active: true }),
          )
          .execute();
        await scope(t)
          .insertInto('reference_state', {
            mm_version: 0,
            vocabulary_version: version,
            updated_at: ctx.now(),
          })
          .onConflict((oc) =>
            oc.column('tenant_id').doUpdateSet({ vocabulary_version: version, updated_at: ctx.now() }),
          )
          .execute();
      },
    },

    mergeLog: {
      async record(t, mergeId, table, rowId, before) {
        await scope(t)
          .insertInto('merge_log', {
            id: randomUUID(),
            merge_id: mergeId,
            table_name: table,
            row_id: rowId,
            before: json(before),
          })
          .execute();
      },
      async entries(t, mergeId, limit) {
        const rows = await scope(t)
          .selectFrom('merge_log')
          .select(['table_name', 'row_id', 'before'])
          .where('merge_id', '=', mergeId)
          .where('undone_at', 'is', null)
          .limit(limit)
          .execute();
        return rows.map((r) => ({ table: r.table_name, rowId: r.row_id, before: r.before }));
      },
      async markUndone(t, mergeId) {
        await scope(t)
          .updateTable('merge_log')
          .set({ undone_at: ctx.now() })
          .where('merge_id', '=', mergeId)
          .where('undone_at', 'is', null)
          .execute();
      },
    },

    events: {
      async publish(e) {
        const { tenantId, aggregateType, aggregateId, eventType, data } = eventOf(e);
        const r = await sql<{
          version: number;
        }>`insert into ${sql.table('aggregate_versions')} (id, tenant_id, aggregate_type, version)
            values (${aggregateId}, ${tenantId}, ${aggregateType}, 1)
            on conflict (id) do update set version = aggregate_versions.version + 1
            returning version`.execute(db);
        await writeEvent(db, {
          eventType,
          tenantId,
          aggregateType,
          aggregateId,
          aggregateVersion: r.rows[0]?.version ?? 1,
          data,
          correlationId: ctx.correlationId,
          producer: PRODUCER,
        } as Parameters<typeof writeEvent>[1]);
      },
    },

    rescore: {
      async markDirty(t, type, id, reason, runId = null) {
        const r = await sql<{ inserted: boolean }>`insert into ${sql.table('rescore_pending')}
              (id, tenant_id, subject_type, subject_id, reasons, run_id, enqueued_at)
            values (${randomUUID()}, ${t}, ${type}, ${id}, ${sql.val([reason])}::text[], ${runId}, ${ctx.now()})
            on conflict (tenant_id, subject_type, subject_id) do update
              set reasons = case when array_length(rescore_pending.reasons, 1) >= 20 then rescore_pending.reasons
                                 else array_append(rescore_pending.reasons, ${reason}) end,
                  run_id = coalesce(excluded.run_id, rescore_pending.run_id)
            returning (xmax = 0) as inserted`.execute(db);
        const inserted = r.rows[0]?.inserted ?? false;
        if (inserted)
          await queueSend(db, SCHEMA, RESCORE_QUEUE, {
            kind: 'subject',
            tenantId: t,
            subjectType: type,
            subjectId: id,
            correlationId: ctx.correlationId,
          });
        return inserted;
      },
      async claim(t, type, id) {
        const r = await scope(t)
          .deleteFrom('rescore_pending')
          .where('subject_type', '=', type)
          .where('subject_id', '=', id)
          .returning(['reasons', 'run_id'])
          .executeTakeFirst();
        return r ? { reasons: r.reasons, runId: r.run_id } : null;
      },
      async enqueueJob(job, tenantId) {
        await queueSend(db, SCHEMA, RESCORE_QUEUE, {
          kind: 'job',
          job,
          tenantId,
          correlationId: ctx.correlationId,
        });
      },
    },

    jobs: {
      async get(job, runDate, tenantId) {
        const r = await sql<{
          cursor: string | null;
          processed: number;
          done: boolean;
        }>`select cursor, processed, done
            from ${sql.table('job_runs')}
            where job = ${job} and run_date = ${runDate}
              and coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${tenantId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`.execute(
          db,
        );
        return r.rows[0] ?? null;
      },
      async save(job, runDate, tenantId, s) {
        const now = ctx.now();
        await sql`insert into ${sql.table('job_runs')} (id, tenant_id, job, run_date, cursor, processed, done, started_at, finished_at)
            values (${randomUUID()}, ${tenantId}, ${job}, ${runDate}, ${s.cursor}, ${s.processed}, ${s.done}, ${now}, ${s.done ? now : null})
            on conflict (job, run_date, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
            do update set cursor = excluded.cursor, processed = excluded.processed, done = excluded.done,
              finished_at = excluded.finished_at`.execute(db);
      },
    },
  };
  return store;
}

function exclusionValues(r: ExclusionRecord) {
  return {
    id: randomUUID(),
    demand_id: r.demandId,
    offer_id: r.offerId,
    reason: r.reason,
    available_from: r.availableFrom,
    move_in_by: r.moveInBy,
    computed_at: r.computedAt,
  };
}

interface EventParts<T extends EventType> {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: T;
  data: EventDataMap[T];
}

function eventOf(e: OutgoingEvent): EventParts<EventType> {
  switch (e.type) {
    case 'match.suggested.v1':
      return {
        tenantId: e.match.tenantId,
        aggregateType: 'match',
        aggregateId: e.match.id,
        eventType: e.type,
        data: {
          matchId: e.match.id,
          code: e.match.code,
          demandId: e.match.demandId,
          offerIds: [...e.match.offerIds],
          isBundle: e.match.isBundle,
          score: e.match.score,
          flags: [...e.match.flags],
        },
      };
    case 'match.confirmed.v1':
      return {
        tenantId: e.match.tenantId,
        aggregateType: 'match',
        aggregateId: e.match.id,
        eventType: e.type,
        data: {
          matchId: e.match.id,
          demandId: e.match.demandId,
          offerIds: [...e.match.offerIds],
          confirmedBy: e.confirmedBy,
        },
      };
    case 'match.rejected.v1':
      return {
        tenantId: e.match.tenantId,
        aggregateType: 'match',
        aggregateId: e.match.id,
        eventType: e.type,
        data: { matchId: e.match.id, demandId: e.match.demandId, reason: e.reason },
      };
    case 'match.closed.v1':
      return {
        tenantId: e.match.tenantId,
        aggregateType: 'match',
        aggregateId: e.match.id,
        eventType: e.type,
        data: { matchId: e.match.id, demandId: e.match.demandId, reason: e.reason },
      };
    case 'match.flagged.v1':
      return {
        tenantId: e.match.tenantId,
        aggregateType: 'match',
        aggregateId: e.match.id,
        eventType: e.type,
        data: { matchId: e.match.id, flag: e.flag, cleared: e.cleared },
      };
    case 'match.reopened.v1':
      return {
        tenantId: e.match.tenantId,
        aggregateType: 'match',
        aggregateId: e.match.id,
        eventType: e.type,
        data: { matchId: e.match.id, demandId: e.match.demandId, reason: e.reason },
      };
    case 'demand.matching_completed.v1':
      return {
        tenantId: e.tenantId,
        aggregateType: 'demand',
        aggregateId: e.demandId,
        eventType: e.type,
        data: { demandId: e.demandId, runId: e.runId, matchCount: e.matchCount, bundleCount: e.bundleCount },
      };
    case 'audit.recorded.v1':
      return {
        tenantId: e.tenantId,
        aggregateType: 'weights',
        aggregateId: e.subjectId,
        eventType: e.type,
        data: {
          action: e.action,
          actorUserId: e.actorUserId,
          subjectType: 'weights',
          subjectId: e.subjectId,
          via: 'ui',
          details: e.details,
        },
      };
  }
}

/** Unit of work over the pool: one transaction per call, repositories bound to it. */
export function pgUnitOfWork(db: Kysely<CrmEngineDb>, now: () => Date): UnitOfWork {
  return {
    run(correlationId, fn, options) {
      return withTransaction(db, (trx) => fn(createStore(trx, { correlationId, now })), {
        statementTimeoutMs: options?.statementTimeoutMs ?? 2000,
      });
    },
  };
}
