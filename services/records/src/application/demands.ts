// Demands and touches (REC-04, US-04/US-08, A-16): first touch keeps the credit; demand dedup by person/company.
import { PROPERTY_DEAL_TYPES } from '@11e/vocabulary';
import { DEMAND_THRESHOLDS, demandDecision, scoreDemand } from '../domain/dedup.js';
import type { DemandFacts } from '../domain/dedup.js';
import { RecordsError, notFound } from '../domain/errors.js';
import { demandOutside } from '../domain/launch-area.js';
import { MANAGER_ROLES, decideDemandStage } from '../domain/record-stage.js';
import { norm, uniqueStrings } from '../domain/text.js';
import { assertRanges } from '../domain/vocabulary.js';
import { raiseCandidate } from './candidates.js';
import type { Actor, App } from './context.js';
import { micromarketIndexOf, vocabularyOf } from './context.js';
import { agg, bumpDemandsUpdated, emitDemand } from './emit.js';
import { DEMAND_FIELDS, changedColumns, mapFields, mergeEdited } from './fields.js';
import { mustFind } from './lookup.js';
import type { CaptureMode, DemandRow, SourceType, TouchRow } from './model.js';
import { createPerson, mergedError, touchPeople } from './people.js';
import type { PersonInput } from './people.js';
import type { Tx } from './ports.js';
import type { Dto } from './supply.js';

export interface TouchSource {
  sourceType: SourceType;
  captureMode: CaptureMode;
  sourceDetail?: string | null | undefined;
  occurredAt?: Date | undefined;
  referrerPersonId?: string | null | undefined;
  sourceAdId?: string | null | undefined;
  enquiryId?: string | null | undefined;
  uploadId?: string | null | undefined;
  rowId?: string | null | undefined;
}

function demandRanges(d: Dto, prefix = '') {
  assertRanges([
    [`${prefix}budgetInr`, d['budgetInrMin'] as number | null, d['budgetInrMax'] as number | null],
    [`${prefix}rentMonthlyInr`, d['rentMonthlyInrMin'] as number | null, d['rentMonthlyInrMax'] as number | null],
    [`${prefix}areaSqft`, d['areaSqftMin'] as number | null, d['areaSqftMax'] as number | null],
    [`${prefix}bhk`, d['bhkMin'] as number | null, d['bhkMax'] as number | null],
  ]);
}

function assertDemandDealTypes(dealTypes: unknown, market: unknown, prefix: string) {
  const list = (dealTypes as string[] | undefined) ?? [];
  const bad = list.findIndex((d) => !(PROPERTY_DEAL_TYPES as readonly string[]).includes(d));
  if (bad >= 0) {
    throw new RecordsError('vocabulary-value-invalid', undefined, {
      errors: [{ field: `${prefix}dealTypes/${bad}`, code: 'not-a-property-deal-type' }],
    });
  }
  if (market !== null && market !== undefined && !list.includes('Sale')) {
    throw new RecordsError('vocabulary-value-invalid', undefined, { errors: [{ field: `${prefix}market`, code: 'market-on-non-sale' }] });
  }
}

/** Micromarket ids (validated) plus stated localities that resolve in the hierarchy; the outside flag (Z-7). */
async function places(app: App, tx: Tx, micromarketIds: readonly string[], localities: readonly string[]) {
  const tree = await micromarketIndexOf(app, tx);
  const unknown = micromarketIds.findIndex((id) => !tree.byId(id));
  if (unknown >= 0) {
    throw new RecordsError('validation-failed', 'unknown micromarket', { errors: [{ field: `micromarketIds/${unknown}`, code: 'not-found' }] });
  }
  const resolved = localities.map((l) => tree.resolve(l)?.id).filter((x): x is string => !!x);
  const ids = [...new Set([...micromarketIds, ...resolved])];
  const unresolved = localities.filter((l) => !tree.resolve(l));
  const outside = demandOutside([
    ...ids.map((id) => ({ inLaunchArea: tree.byId(id)?.in_launch_area })),
    ...unresolved.map(() => ({ inLaunchArea: undefined })),
  ]);
  return { ids, outside };
}

export function demandFactsOf(d: Pick<DemandRow, 'segment' | 'deal_types' | 'property_types' | 'micromarket_ids' | 'localities' | 'budget_inr_min' | 'budget_inr_max' | 'rent_monthly_inr_min' | 'rent_monthly_inr_max' | 'area_sqft_min' | 'area_sqft_max' | 'bhk_min' | 'bhk_max'>): DemandFacts {
  return {
    segment: d.segment,
    dealTypes: d.deal_types,
    propertyTypes: d.property_types,
    places: [...d.micromarket_ids, ...d.localities.map((l) => norm(l) ?? l)],
    budgetMin: d.budget_inr_min,
    budgetMax: d.budget_inr_max,
    rentMin: d.rent_monthly_inr_min,
    rentMax: d.rent_monthly_inr_max,
    areaMin: d.area_sqft_min,
    areaMax: d.area_sqft_max,
    bhkMin: d.bhk_min,
    bhkMax: d.bhk_max,
  };
}

export function emptyDemand(app: App, tx: Tx, code: string): DemandRow {
  return {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    code,
    person_id: null,
    company_name: null,
    company_norm: null,
    deal_types: [],
    market: null,
    segment: null,
    property_types: [],
    micromarket_ids: [],
    localities: [],
    budget_inr_min: null,
    budget_inr_max: null,
    rent_monthly_inr_min: null,
    rent_monthly_inr_max: null,
    area_sqft_min: null,
    area_sqft_max: null,
    area_basis: null,
    bhk_min: null,
    bhk_max: null,
    move_in_from: null,
    move_in_by: null,
    move_in_text: null,
    stated_tags: {},
    decision_maker: null,
    introducing_broker_person_id: null,
    shared_commission_note: null,
    shared_commission_pct: null,
    record_stage: 'Captured',
    publication_level: 'Private',
    publication_version: 0,
    owner_user_id: null,
    source_type: 'Direct',
    capture_mode: 'typed_in',
    side_evidence: null,
    needs_review: false,
    review_reason: null,
    review_reason_code: null,
    first_touch_id: null,
    touch_count: 1,
    ingested_record_id: null,
    source_ad_id: null,
    outside_launch_area: false,
    closed_at: null,
    exit_state: null,
    exit_version: 0,
    last_seen_at: null,
    staff_edited_fields: [],
    status: 'active',
    void_reason: null,
    merged_into_id: null,
    created_at: tx.now,
    updated_at: tx.now,
    version: 1,
  };
}

/** Builds a demand row from API fields (validated), not inserted. */
export async function demandFromInput(app: App, tx: Tx, input: Dto, base: Partial<DemandRow>, prefix = ''): Promise<DemandRow> {
  demandRanges(input, prefix);
  const vocab = await vocabularyOf(app, tx);
  const mapped = mapFields(input, DEMAND_FIELDS, vocab, prefix);
  assertDemandDealTypes(mapped['deal_types'], mapped['market'], prefix);
  const row = { ...emptyDemand(app, tx, await tx.codes.next('DEM', 6)), ...base, ...mapped } as DemandRow;
  row.localities = uniqueStrings(row.localities);
  const where = await places(app, tx, row.micromarket_ids, row.localities);
  row.micromarket_ids = where.ids;
  row.outside_launch_area = where.outside;
  row.company_norm = norm(row.company_name);
  return row;
}

/** Inserts a demand with its first touch; emits demand.created.v1 then demand.touch_added.v1. */
export async function insertDemand(app: App, tx: Tx, demand: DemandRow, source: TouchSource): Promise<TouchRow> {
  const touch: TouchRow = {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    demand_id: demand.id,
    source_type: source.sourceType,
    capture_mode: source.captureMode,
    source_detail: source.sourceDetail ?? null,
    occurred_at: source.occurredAt ?? tx.now,
    is_first_touch: true,
    source_ad_id: source.sourceAdId ?? null,
    enquiry_id: source.enquiryId ?? null,
    referrer_person_id: source.referrerPersonId ?? null,
    upload_id: source.uploadId ?? null,
    row_id: source.rowId ?? null,
    created_at: tx.now,
  };
  await tx.store.insert('demands', { ...demand, first_touch_id: touch.id, touch_count: 1, version: 1 });
  await tx.store.insert('touches', touch);
  await emitDemand(tx, 'demand.created.v1', [demand.id]);
  await tx.store.update('demands', demand.id, { version: 2 });
  await tx.events.emit('demand.touch_added.v1', agg('demand', demand.id, 2), {
    demandId: demand.id,
    touchId: touch.id,
    sourceType: touch.source_type,
    captureMode: touch.capture_mode,
    isFirstTouch: true,
  });
  await touchPeople(tx, [demand.person_id]);
  return touch;
}

/** Another arrival of the same demand (A-16: the first touch keeps its credit). Idempotent per ingestion row. */
export async function addTouchTo(app: App, tx: Tx, demand: DemandRow, source: TouchSource): Promise<TouchRow | null> {
  const touch: TouchRow = {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    demand_id: demand.id,
    source_type: source.sourceType,
    capture_mode: source.captureMode,
    source_detail: source.sourceDetail ?? null,
    occurred_at: source.occurredAt ?? tx.now,
    is_first_touch: false,
    source_ad_id: source.sourceAdId ?? null,
    enquiry_id: source.enquiryId ?? null,
    referrer_person_id: source.referrerPersonId ?? null,
    upload_id: source.uploadId ?? null,
    row_id: source.rowId ?? null,
    created_at: tx.now,
  };
  if (!(await tx.store.insertIgnore('touches', touch))) return null;
  const current = (await tx.store.get('demands', demand.id, { lock: true })) as DemandRow;
  const version = current.version + 1;
  await tx.store.update('demands', demand.id, {
    touch_count: current.touch_count + 1,
    last_seen_at: tx.now,
    version,
  });
  await tx.events.emit('demand.touch_added.v1', agg('demand', demand.id, version), {
    demandId: demand.id,
    touchId: touch.id,
    sourceType: touch.source_type,
    captureMode: touch.capture_mode,
    isFirstTouch: false,
  });
  await touchPeople(tx, [current.person_id]);
  return touch;
}

export async function resolveClient(app: App, tx: Tx, personId: string | null | undefined, newPerson: PersonInput | null | undefined) {
  if (personId) {
    const p = await tx.store.get('persons', personId);
    if (!p) throw new RecordsError('validation-failed', 'unknown person', { errors: [{ field: 'personId', code: 'not-found' }] });
    return p.status === 'merged' && p.merged_into_id ? ((await tx.store.get('persons', p.merged_into_id)) ?? p) : p;
  }
  if (newPerson) return (await createPerson(app, tx, newPerson, { onExisting: 'reuse' })).person;
  return null;
}

export async function createDemand(app: App, actor: Actor, input: Dto): Promise<string> {
  return app.uow.run(actor, async (tx) => {
    const person = await resolveClient(app, tx, input['personId'] as string | null, input['newPerson'] as PersonInput | null);
    const owner = (input['ownerUserId'] as string | undefined) ?? (actor.role === 'Demand agent' ? actor.userId : null);
    const demand = await demandFromInput(app, tx, input, {
      person_id: person?.id ?? null,
      owner_user_id: owner,
      source_type: (input['sourceType'] as SourceType | undefined) ?? 'Direct',
      capture_mode: 'typed_in',
    });
    if (!demand.company_name && person?.company_name) {
      demand.company_name = person.company_name;
      demand.company_norm = person.company_norm;
    }
    await insertDemand(app, tx, demand, {
      sourceType: demand.source_type,
      captureMode: 'typed_in',
      sourceDetail: input['sourceDetail'] as string | undefined,
      referrerPersonId: input['referrerPersonId'] as string | null | undefined,
    });
    return demand.id;
  });
}

export async function patchDemand(app: App, actor: Actor, idOrCode: string, patch: Dto, ifMatch: number | undefined): Promise<string> {
  return app.uow.run(actor, async (tx) => {
    const demand = await mustFind(tx, 'demands', idOrCode, { lock: true });
    if (demand.status === 'merged') throw mergedError(demand.merged_into_id);
    if (ifMatch !== undefined && ifMatch !== demand.version) throw new RecordsError('version-mismatch');
    if (patch['ownerUserId'] !== undefined && !MANAGER_ROLES.includes(actor.role)) {
      throw new RecordsError('forbidden', 'changing the owner needs Admin or Manager');
    }
    const vocab = await vocabularyOf(app, tx);
    const mapped = mapFields(patch, DEMAND_FIELDS, vocab);
    const next = { ...demand, ...mapped } as DemandRow;
    demandRanges({
      budgetInrMin: next.budget_inr_min,
      budgetInrMax: next.budget_inr_max,
      rentMonthlyInrMin: next.rent_monthly_inr_min,
      rentMonthlyInrMax: next.rent_monthly_inr_max,
      areaSqftMin: next.area_sqft_min,
      areaSqftMax: next.area_sqft_max,
      bhkMin: next.bhk_min,
      bhkMax: next.bhk_max,
    });
    assertDemandDealTypes(next.deal_types, next.market, '');
    const changed = changedColumns(demand as unknown as Dto, mapped);
    if (!changed.length) return demand.id;
    if (mapped['micromarket_ids'] !== undefined || mapped['localities'] !== undefined) {
      next.localities = uniqueStrings(next.localities);
      const where = await places(app, tx, next.micromarket_ids, next.localities);
      mapped['micromarket_ids'] = where.ids;
      mapped['localities'] = next.localities;
      mapped['outside_launch_area'] = where.outside;
    }
    if (mapped['company_name'] !== undefined) mapped['company_norm'] = norm(mapped['company_name'] as string | null);
    await tx.store.update('demands', demand.id, {
      ...(mapped as Partial<DemandRow>),
      staff_edited_fields: mergeEdited(demand.staff_edited_fields, changed),
    });
    await bumpDemandsUpdated(tx, [demand.id]);
    await touchPeople(tx, [demand.person_id]);
    return demand.id;
  });
}

export async function changeDemandStage(app: App, actor: Actor, idOrCode: string, to: string, ifMatch: number | undefined) {
  return app.uow.run(actor, async (tx) => {
    const demand = await mustFind(tx, 'demands', idOrCode, { lock: true });
    if (demand.status === 'merged') throw mergedError(demand.merged_into_id);
    if (ifMatch !== undefined && ifMatch !== demand.version) throw new RecordsError('version-mismatch');
    const d = decideDemandStage(demand.record_stage, to, actor.role);
    if (d.kind === 'noop') return demand.id;
    await tx.store.update('demands', demand.id, { record_stage: to });
    await bumpDemandsUpdated(tx, [demand.id]);
    return demand.id;
  });
}

export async function addTouch(
  app: App,
  actor: Actor,
  idOrCode: string,
  input: { sourceType: SourceType; sourceDetail?: string | undefined; occurredAt?: string | undefined; referrerPersonId?: string | null | undefined },
): Promise<TouchRow> {
  return app.uow.run(actor, async (tx) => {
    const demand = await mustFind(tx, 'demands', idOrCode, { lock: true });
    if (demand.status === 'merged') throw mergedError(demand.merged_into_id);
    const touch = await addTouchTo(app, tx, demand, {
      sourceType: input.sourceType,
      captureMode: 'typed_in',
      sourceDetail: input.sourceDetail,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
      referrerPersonId: input.referrerPersonId,
    });
    if (!touch) throw notFound('touch');
    return touch;
  });
}

export interface DemandMatch {
  decision: 'touch' | 'new_with_candidate' | 'new';
  best?: DemandRow | undefined;
  similar: { demand: DemandRow; score: number; evidence: 'phone' | 'company' }[];
}

/**
 * Demand dedup (LLD §4.5): open demands of the person (365 days) or with the same company; phone match ≥ 0.80 →
 * touch; 0.50–0.80 (or company-only ≥ 0.80) → new demand + demand_similarity candidates.
 */
export async function matchDemand(tx: Tx, input: DemandRow): Promise<DemandMatch> {
  const since = new Date(tx.now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const candidates = await tx.q.demandCandidates({
    personId: input.person_id,
    companyNorm: input.company_norm,
    since,
    excludeId: input.id,
  });
  const facts = demandFactsOf(input);
  let best: DemandMatch = { decision: 'new', similar: [] };
  let bestScore = -1;
  for (const d of candidates) {
    const score = scoreDemand(facts, demandFactsOf(d));
    if (score === null) continue;
    const evidence = input.person_id && d.person_id === input.person_id ? 'phone' : 'company';
    const decision = demandDecision(score, evidence);
    if (decision !== 'new') best.similar.push({ demand: d, score, evidence });
    if (decision === 'touch' && score > bestScore) {
      bestScore = score;
      best = { ...best, decision: 'touch', best: d };
    }
  }
  if (best.decision !== 'touch' && best.similar.length) best = { ...best, decision: 'new_with_candidate' };
  return best;
}

/** Raises demand_similarity candidates between a new demand and its similar open demands. */
export async function raiseDemandCandidates(
  app: App,
  tx: Tx,
  demandId: string,
  similar: DemandMatch['similar'],
  uploadId?: string | null,
): Promise<string[]> {
  const ids: string[] = [];
  for (const s of similar.filter((x) => x.score >= DEMAND_THRESHOLDS.uncertain)) {
    const id = await raiseCandidate(app, tx, {
      aggregateType: 'demand',
      leftId: demandId,
      rightId: s.demand.id,
      reason: 'demand_similarity',
      score: s.score,
      evidence: { score: s.score, evidence: s.evidence },
      uploadId: uploadId ?? null,
    });
    if (id) ids.push(id);
  }
  return ids;
}
