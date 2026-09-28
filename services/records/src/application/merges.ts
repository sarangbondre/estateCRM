// Merge and undo (REC-06, US-09, records LLD §4.7, HLD §7 merge saga): one transaction re-points children to the
// survivor, logs every column it changes (merge_undo_log) and marks merged records; undo replays the log in reverse
// and restores a column only when it still holds the merged value.
import { RecordsError, notFound } from '../domain/errors.js';
import { assertMergeAllowed, assertMergeSize, fillBlanks, sameValue } from '../domain/merge.js';
import type { MergeAggregate } from '../domain/merge.js';
import { emitAudit } from './audit.js';
import { raiseCandidate } from './candidates.js';
import type { Actor, App } from './context.js';
import { agg, bumpDemandsUpdated, bumpOffersUpdated, activeOfferIdsOf } from './emit.js';
import type { MergeRow, MergeUndoLogRow, Tables } from './model.js';
import type { IdTable, Tx } from './ports.js';

const TABLE_OF: Record<MergeAggregate, 'persons' | 'properties' | 'offers' | 'demands'> = {
  person: 'persons',
  property: 'properties',
  offer: 'offers',
  demand: 'demands',
};

type AnyRow = Record<string, unknown> & { id: string };

/** Change log of one merge: every write goes through it so undo can replay it. */
class MergeLog {
  readonly entries: MergeUndoLogRow[] = [];
  readonly counts: Record<string, number> = {};
  constructor(
    private readonly tx: Tx,
    private readonly mergeId: string,
  ) {}

  #push(table: string, rowId: string, column: string, oldValue: unknown, newValue: unknown, op: MergeUndoLogRow['op']) {
    this.entries.push({
      tenant_id: this.tx.tenantId,
      merge_id: this.mergeId,
      seq: this.entries.length + 1,
      table_name: table,
      row_id: rowId,
      column_name: column,
      old_value: oldValue ?? null,
      new_value: newValue ?? null,
      op,
    });
  }

  count(table: string, n = 1) {
    this.counts[table] = (this.counts[table] ?? 0) + n;
  }

  async set<T extends IdTable>(table: T, row: AnyRow, column: string, value: unknown, countIt = true): Promise<void> {
    if (sameValue(row[column], value)) return;
    await this.tx.store.update(table, row.id, { [column]: value } as Partial<Tables[T]>);
    this.#push(table, row.id, column, row[column], value, 'update');
    if (countIt) this.count(table);
  }

  async remove<T extends IdTable>(table: T, row: AnyRow): Promise<void> {
    await this.tx.store.delete(table, { id: row.id } as Partial<Tables[T]>);
    this.#push(table, row.id, '*', row, null, 'delete');
    this.count(table);
  }

  /** offer_photos has a composite key: logged by photo id with the whole row. */
  async moveOfferPhoto(row: { offer_id: string; photo_id: string; sort: number }, toOfferId: string, exists: boolean) {
    await this.tx.store.delete('offer_photos', { offer_id: row.offer_id, photo_id: row.photo_id });
    this.#push('offer_photos', row.photo_id, '*', row, null, 'delete');
    if (!exists) {
      const moved = { offer_id: toOfferId, photo_id: row.photo_id, sort: row.sort };
      await this.tx.store.insert('offer_photos', moved);
      this.#push('offer_photos', row.photo_id, '*', null, moved, 'insert');
    }
    this.count('offer_photos');
  }

  async flush() {
    await this.tx.store.insert('merge_undo_log', this.entries);
  }
}

export interface MergeCommand {
  aggregateType: MergeAggregate;
  survivorId: string;
  mergedIds: string[];
  candidateId?: string | null | undefined;
  source: MergeRow['source'];
  performedBy: string | null;
  /** User requests are limited to 5,000 moved rows (409 merge-too-large). */
  userRequest: boolean;
}

async function lineageParents(tx: Tx, type: MergeAggregate, ids: string[]): Promise<Map<string, string | null>> {
  const rows =
    type === 'property'
      ? await tx.store.findIn('ingested_records', 'property_id', ids)
      : type === 'person'
        ? []
        : await tx.store.findIn('ingested_records', 'primary_subject_id', ids);
  const out = new Map<string, string | null>(ids.map((id) => [id, null]));
  for (const r of rows) {
    const key = type === 'property' ? r.property_id : r.primary_subject_id;
    if (key && r.parent_external_ref) out.set(key, r.parent_external_ref);
  }
  return out;
}

/** Rows a merge would move (for the 5,000-row guard). */
async function plannedRows(tx: Tx, type: MergeAggregate, mergedIds: string[]): Promise<number> {
  const n = async (table: Parameters<Tx['store']['findIn']>[0], col: string) =>
    (await tx.store.findIn(table, col as never, mergedIds)).length;
  switch (type) {
    case 'person':
      return (await n('person_phones', 'person_id')) + (await n('record_parties', 'person_id')) + (await n('demands', 'person_id')) + (await n('enquiries', 'person_id'));
    case 'property':
      return (await n('offers', 'property_id')) + (await n('photos', 'property_id')) + (await n('second_sources', 'property_id')) + (await n('sightings', 'subject_id'));
    case 'offer':
      return (await n('sightings', 'subject_id')) + (await n('enquiries', 'offer_id')) + (await n('second_sources', 'offer_id'));
    case 'demand':
      return (await n('touches', 'demand_id')) + (await n('enquiries', 'demand_id'));
  }
}

/** Executes a merge in the caller's transaction. Returns the merge row. */
export async function mergeInTx(app: App, tx: Tx, cmd: MergeCommand, actor: Actor): Promise<MergeRow> {
  const table = TABLE_OF[cmd.aggregateType];
  const ids = [cmd.survivorId, ...cmd.mergedIds];
  const rows = (await Promise.all(ids.map((id) => tx.store.get(table, id, { lock: true })))) as (AnyRow & { status: string } | undefined)[];
  if (rows.some((r) => !r)) throw notFound(cmd.aggregateType);
  const parents = await lineageParents(tx, cmd.aggregateType, ids);
  const [survivor, ...merged] = rows as (AnyRow & { status: string })[];
  assertMergeAllowed(
    { id: survivor!.id, status: survivor!.status, parentExternalRef: parents.get(survivor!.id) ?? null },
    merged.map((m) => ({ id: m.id, status: m.status, parentExternalRef: parents.get(m.id) ?? null })),
  );
  assertMergeSize(await plannedRows(tx, cmd.aggregateType, cmd.mergedIds), cmd.userRequest);

  const mergeId = app.ids.next();
  // The merge row first: undo-log rows reference it.
  const mergeRow: MergeRow = {
    id: mergeId,
    tenant_id: tx.tenantId,
    aggregate_type: cmd.aggregateType,
    survivor_id: cmd.survivorId,
    merged_ids: cmd.mergedIds,
    candidate_id: cmd.candidateId ?? null,
    source: cmd.source,
    status: 'active',
    moved_counts: {},
    performed_by: cmd.performedBy,
    performed_at: tx.now,
    undone_by: null,
    undone_at: null,
    created_at: tx.now,
    updated_at: tx.now,
  };
  await tx.store.insert('merges', mergeRow);
  const log = new MergeLog(tx, mergeId);
  const touched = { offers: new Set<string>(), demands: new Set<string>(), movedTouches: [] as string[] };

  switch (cmd.aggregateType) {
    case 'person':
      await mergePeople(tx, log, survivor!, merged, touched);
      break;
    case 'property':
      await mergeProperties(app, tx, log, survivor!, merged, touched);
      break;
    case 'offer':
      await mergeOffers(tx, log, survivor!, merged, touched);
      break;
    case 'demand':
      await mergeDemands(tx, log, survivor!, merged, touched);
      break;
  }
  for (const m of merged) {
    await log.set(table, m, 'status', 'merged', false);
    await log.set(table, m, 'merged_into_id', survivor!.id, false);
    const subjects = await tx.store.find('ingested_records', { primary_subject_id: m.id }, { limit: 100 });
    for (const s of subjects) await log.set('ingested_records', s as unknown as AnyRow, 'primary_subject_id', survivor!.id);
  }
  if (cmd.candidateId) {
    const cand = await tx.store.get('merge_candidates', cmd.candidateId, { lock: true });
    if (cand) {
      await log.set('merge_candidates', cand as unknown as AnyRow, 'status', 'merged', false);
      await tx.store.update('merge_candidates', cand.id, { resolved_by: cmd.performedBy, resolved_at: tx.now });
    }
  }
  await log.flush();
  await tx.store.update('merges', mergeId, { moved_counts: log.counts });

  // Version bump of every participant (aggregateVersion of records.merged.v1 = survivor version after the change).
  const version = (survivor!['version'] as number) + 1;
  await tx.store.update(table, survivor!.id, { version } as never);
  for (const m of merged) await tx.store.update(table, m.id, { version: (m['version'] as number) + 1 } as never);
  await tx.events.emit('records.merged.v1', agg(cmd.aggregateType, survivor!.id, version), {
    mergeId,
    aggregateType: cmd.aggregateType,
    survivorId: survivor!.id,
    mergedIds: cmd.mergedIds,
  });
  await emitAudit(app, tx, {
    action: 'records_merged',
    actorUserId: actor.userId,
    subjectType: cmd.aggregateType,
    subjectId: survivor!.id,
    via: actor.via,
    details: { mergeId, mergedCount: String(cmd.mergedIds.length), source: cmd.source },
  });
  for (const touchId of touched.movedTouches) {
    const t = await tx.store.get('touches', touchId);
    if (!t) continue;
    const d = await tx.store.get('demands', t.demand_id);
    if (!d) continue;
    await tx.store.update('demands', d.id, { version: d.version + 1 });
    await tx.events.emit('demand.touch_added.v1', agg('demand', d.id, d.version + 1), {
      demandId: d.id,
      touchId: t.id,
      sourceType: t.source_type,
      captureMode: t.capture_mode,
      isFirstTouch: t.is_first_touch,
    });
  }
  await bumpOffersUpdated(tx, [...touched.offers]);
  await bumpDemandsUpdated(tx, [...touched.demands]);
  return { ...mergeRow, moved_counts: log.counts };
}

type Touched = { offers: Set<string>; demands: Set<string>; movedTouches: string[] };

async function mergePeople(tx: Tx, log: MergeLog, s: AnyRow, merged: AnyRow[], touched: Touched) {
  const ids = merged.map((m) => m.id);
  const [sPhones, sEmails, sParties] = await Promise.all([
    tx.store.find('person_phones', { person_id: s.id }, { limit: 100 }),
    tx.store.find('person_emails', { person_id: s.id }, { limit: 100 }),
    tx.store.find('record_parties', { person_id: s.id }, { limit: 1000 }),
  ]);
  for (const p of await tx.store.findIn('person_phones', 'person_id', ids)) {
    if (sPhones.some((x) => x.phone_hash === p.phone_hash && x.kind === p.kind)) await log.remove('person_phones', p as unknown as AnyRow);
    else await log.set('person_phones', p as unknown as AnyRow, 'person_id', s.id);
  }
  for (const e of await tx.store.findIn('person_emails', 'person_id', ids)) {
    if (sEmails.some((x) => x.email_hash === e.email_hash)) await log.remove('person_emails', e as unknown as AnyRow);
    else await log.set('person_emails', e as unknown as AnyRow, 'person_id', s.id);
  }
  for (const r of await tx.store.findIn('record_parties', 'person_id', ids)) {
    if (r.subject_type === 'offer' || r.subject_type === 'property') {
      if (r.subject_type === 'offer') touched.offers.add(r.subject_id);
      else for (const o of await activeOfferIdsOf(tx, [r.subject_id])) touched.offers.add(o);
    }
    if (r.subject_type === 'demand') touched.demands.add(r.subject_id);
    const dup = sParties.some((x) => x.subject_type === r.subject_type && x.subject_id === r.subject_id && x.role === r.role);
    if (dup) await log.remove('record_parties', r as unknown as AnyRow);
    else await log.set('record_parties', r as unknown as AnyRow, 'person_id', s.id);
  }
  for (const d of await tx.store.findIn('demands', 'person_id', ids)) {
    await log.set('demands', d as unknown as AnyRow, 'person_id', s.id);
    touched.demands.add(d.id);
  }
  for (const d of await tx.store.findIn('demands', 'introducing_broker_person_id', ids)) {
    await log.set('demands', d as unknown as AnyRow, 'introducing_broker_person_id', s.id);
  }
  for (const e of await tx.store.findIn('enquiries', 'person_id', ids)) await log.set('enquiries', e as unknown as AnyRow, 'person_id', s.id);
  for (const x of await tx.store.findIn('second_sources', 'person_id', ids)) await log.set('second_sources', x as unknown as AnyRow, 'person_id', s.id);
  for (const x of await tx.store.findIn('desk_items', 'person_id', ids)) await log.set('desk_items', x as unknown as AnyRow, 'person_id', s.id);
  for (const x of await tx.store.findIn('projects', 'developer_person_id', ids)) await log.set('projects', x as unknown as AnyRow, 'developer_person_id', s.id);
  for (const x of await tx.store.findIn('touches', 'referrer_person_id', ids)) await log.set('touches', x as unknown as AnyRow, 'referrer_person_id', s.id);
  const fill = fillBlanks(s, merged, ['name', 'name_initials', 'company_name', 'company_norm', 'party_type', 'participant_role', 'other_contact']);
  for (const [col, v] of Object.entries(fill)) await log.set('persons', s, col, v, false);
  const flags = [...new Set([...(s['flags'] as string[]), ...merged.flatMap((m) => m['flags'] as string[])])];
  await log.set('persons', s, 'flags', flags, false);
}

const PROPERTY_FILL = [
  'segment',
  'property_types',
  'property_detail',
  'land_use',
  'locality',
  'locality_norm',
  'micromarket_id',
  'city',
  'city_norm',
  'state',
  'landmark',
  'location_text',
  'building_name',
  'building_norm',
  'building_key',
  'wing',
  'unit_no',
  'floor_no',
  'floor_band',
  'parking',
  'total_floors',
  'area_sqft_min',
  'area_sqft_max',
  'area_basis',
  'land_area_value',
  'land_area_unit',
  'land_area_sqft',
  'area_text',
  'bhk_min',
  'bhk_max',
  'features',
  'amenities',
  'project_id',
];

async function mergeProperties(app: App, tx: Tx, log: MergeLog, s: AnyRow, merged: AnyRow[], touched: Touched) {
  const ids = merged.map((m) => m.id);
  const sOffers = await tx.store.find('offers', { property_id: s.id, status: 'active' }, { limit: 100 });
  for (const o of await tx.store.findIn('offers', 'property_id', ids)) {
    const clash = o.status === 'active' && o.project_id === null && sOffers.find((x) => x.deal_type === o.deal_type && x.project_id === null);
    if (clash) {
      // A second offer with the same deal type is proposed as an offer merge, never merged silently.
      await raiseCandidate(app, tx, {
        aggregateType: 'offer',
        leftId: clash.id,
        rightId: o.id,
        reason: 'property_match',
        score: 1,
        evidence: { cause: 'property_merge', dealType: o.deal_type },
      });
      continue;
    }
    await log.set('offers', o as unknown as AnyRow, 'property_id', s.id);
    if (o.status === 'active') touched.offers.add(o.id);
  }
  for (const p of await tx.store.findIn('photos', 'property_id', ids)) await log.set('photos', p as unknown as AnyRow, 'property_id', s.id);
  for (const x of await tx.store.findIn('sightings', 'subject_id', ids, { subject_type: 'property' })) {
    await log.set('sightings', x as unknown as AnyRow, 'subject_id', s.id);
  }
  const sSources = await tx.store.find('second_sources', { property_id: s.id }, { limit: 1000 });
  for (const x of await tx.store.findIn('second_sources', 'property_id', ids)) {
    if (x.source_ad_id && sSources.some((y) => y.source_ad_id === x.source_ad_id)) await log.remove('second_sources', x as unknown as AnyRow);
    else await log.set('second_sources', x as unknown as AnyRow, 'property_id', s.id);
  }
  const sParties = await tx.store.find('record_parties', { subject_type: 'property', subject_id: s.id }, { limit: 100 });
  for (const r of await tx.store.findIn('record_parties', 'subject_id', ids, { subject_type: 'property' })) {
    if (sParties.some((x) => x.person_id === r.person_id && x.role === r.role)) await log.remove('record_parties', r as unknown as AnyRow);
    else await log.set('record_parties', r as unknown as AnyRow, 'subject_id', s.id);
  }
  for (const x of await tx.store.findIn('ingested_records', 'property_id', ids)) await log.set('ingested_records', x as unknown as AnyRow, 'property_id', s.id);
  for (const x of await tx.store.findIn('desk_items', 'linked_property_id', ids)) await log.set('desk_items', x as unknown as AnyRow, 'linked_property_id', s.id);
  const fill = fillBlanks(s, merged, PROPERTY_FILL);
  for (const [col, v] of Object.entries(fill)) await log.set('properties', s, col, v, false);
  const ready = await tx.store.find('photos', { property_id: s.id, status: 'ready' }, { limit: 200 });
  await log.set('properties', s, 'photo_count', ready.length, false);
  await log.set('properties', s, 'has_real_photos', ready.some((p) => p.is_real), false);
  for (const o of await activeOfferIdsOf(tx, [s.id])) touched.offers.add(o);
}

async function mergeOffers(tx: Tx, log: MergeLog, s: AnyRow, merged: AnyRow[], touched: Touched) {
  const ids = merged.map((m) => m.id);
  for (const x of await tx.store.findIn('sightings', 'subject_id', ids, { subject_type: 'offer' })) await log.set('sightings', x as unknown as AnyRow, 'subject_id', s.id);
  for (const x of await tx.store.findIn('enquiries', 'offer_id', ids)) await log.set('enquiries', x as unknown as AnyRow, 'offer_id', s.id);
  for (const x of await tx.store.findIn('second_sources', 'offer_id', ids)) await log.set('second_sources', x as unknown as AnyRow, 'offer_id', s.id);
  const sPhotos = await tx.store.find('offer_photos', { offer_id: s.id }, { limit: 100 });
  for (const x of await tx.store.findIn('offer_photos', 'offer_id', ids)) {
    await log.moveOfferPhoto(x, s.id, sPhotos.some((y) => y.photo_id === x.photo_id));
  }
  const sParties = await tx.store.find('record_parties', { subject_type: 'offer', subject_id: s.id }, { limit: 100 });
  for (const r of await tx.store.findIn('record_parties', 'subject_id', ids, { subject_type: 'offer' })) {
    if (sParties.some((x) => x.person_id === r.person_id && x.role === r.role)) await log.remove('record_parties', r as unknown as AnyRow);
    else await log.set('record_parties', r as unknown as AnyRow, 'subject_id', s.id);
  }
  // Counters recomputed from the moved children.
  const [sightings, enquiries, sources] = await Promise.all([
    tx.store.count('sightings', { subject_type: 'offer', subject_id: s.id }),
    tx.store.count('enquiries', { offer_id: s.id }),
    tx.store.find('second_sources', { offer_id: s.id }, { limit: 1000 }),
  ]);
  await log.set('offers', s, 'sighting_count', sightings, false);
  await log.set('offers', s, 'enquiry_count', enquiries, false);
  await log.set('offers', s, 'second_source_count', sources.length, false);
  await log.set('offers', s, 'has_price_gap', sources.some((x) => x.price_gap && x.status === 'open'), false);
  await log.set('offers', s, 'times_seen', (s['times_seen'] as number) + merged.reduce((n, m) => n + (m['times_seen'] as number), 0), false);
  touched.offers.add(s.id);
}

async function mergeDemands(tx: Tx, log: MergeLog, s: AnyRow, merged: AnyRow[], touched: Touched) {
  const ids = merged.map((m) => m.id);
  const moved = await tx.store.findIn('touches', 'demand_id', ids);
  const own = await tx.store.find('touches', { demand_id: s.id }, { limit: 1000 });
  const all = [...own, ...moved].sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || a.id.localeCompare(b.id));
  const first = all[0];
  // First touch = the earliest arrival (A-16): clear the flags first (partial unique index), then set it.
  for (const t of all) if (t.is_first_touch && t.id !== first?.id) await log.set('touches', t as unknown as AnyRow, 'is_first_touch', false, false);
  for (const t of moved) {
    await log.set('touches', t as unknown as AnyRow, 'demand_id', s.id);
    touched.movedTouches.push(t.id);
  }
  if (first && !first.is_first_touch) await log.set('touches', first as unknown as AnyRow, 'is_first_touch', true, false);
  for (const x of await tx.store.findIn('enquiries', 'demand_id', ids)) await log.set('enquiries', x as unknown as AnyRow, 'demand_id', s.id);
  const sParties = await tx.store.find('record_parties', { subject_type: 'demand', subject_id: s.id }, { limit: 100 });
  for (const r of await tx.store.findIn('record_parties', 'subject_id', ids, { subject_type: 'demand' })) {
    if (sParties.some((x) => x.person_id === r.person_id && x.role === r.role)) await log.remove('record_parties', r as unknown as AnyRow);
    else await log.set('record_parties', r as unknown as AnyRow, 'subject_id', s.id);
  }
  for (const o of await tx.store.findIn('offers', 'sourced_for_demand_id', ids)) {
    await log.set('offers', o as unknown as AnyRow, 'sourced_for_demand_id', s.id);
    if (o.status === 'active') touched.offers.add(o.id);
  }
  await log.set('demands', s, 'touch_count', all.length, false);
  if (first) await log.set('demands', s, 'first_touch_id', first.id, false);
  touched.demands.add(s.id);
}

// --- use cases -----------------------------------------------------------------------------------------------

export async function mergeRecords(app: App, actor: Actor, cmd: Omit<MergeCommand, 'source' | 'performedBy' | 'userRequest'>): Promise<MergeRow> {
  return app.uow.run(
    actor,
    async (tx) => {
      if (cmd.candidateId) {
        const cand = await tx.store.get('merge_candidates', cmd.candidateId);
        if (!cand) throw notFound('merge candidate');
        if (cand.status !== 'open') throw new RecordsError('candidate-closed');
        if (cand.aggregate_type !== cmd.aggregateType) throw new RecordsError('merge-not-allowed', 'candidate of another type');
      }
      return mergeInTx(app, tx, { ...cmd, source: 'user', performedBy: actor.userId, userRequest: true }, actor);
    },
    { timeoutMs: 10_000 },
  );
}

export async function undoMerge(app: App, actor: Actor, mergeId: string): Promise<{ merge: MergeRow; conflicts: number }> {
  return app.uow.run(
    actor,
    async (tx) => {
      const merge = await tx.store.get('merges', mergeId, { lock: true });
      if (!merge) throw notFound('merge');
      if (merge.status === 'undone') throw new RecordsError('merge-already-undone');
      const participants = [merge.survivor_id, ...merge.merged_ids];
      const later = (await tx.q.activeMergesTouching(participants)).filter(
        (m) => m.id !== merge.id && m.performed_at >= merge.performed_at,
      );
      if (later.length) throw new RecordsError('merge-undo-blocked', 'undo the later merge first');

      const entries = (await tx.store.find('merge_undo_log', { merge_id: mergeId }, { limit: 1000, orderBy: [{ column: 'seq', direction: 'desc' }] }));
      let conflicts = 0;
      const affectedOffers = new Set<string>();
      const affectedDemands = new Set<string>();
      for (const e of entries) {
        if (e.op === 'update') {
          const row = (await tx.store.get(e.table_name as IdTable, e.row_id)) as AnyRow | undefined;
          if (!row || !sameValue(row[e.column_name], e.new_value)) {
            conflicts++;
            continue;
          }
          await tx.store.update(e.table_name as IdTable, e.row_id, { [e.column_name]: restoreValue(e.old_value) } as never);
          if (e.table_name === 'offers') affectedOffers.add(e.row_id);
          if (e.table_name === 'demands') affectedDemands.add(e.row_id);
          if (e.table_name === 'touches' && typeof e.old_value === 'string' && e.column_name === 'demand_id') affectedDemands.add(e.old_value);
        } else if (e.op === 'delete') {
          const row = e.old_value as Record<string, unknown>;
          if (e.table_name === 'offer_photos') await tx.store.insertIgnore('offer_photos', row as never);
          else await tx.store.insertIgnore(e.table_name as IdTable, withoutTenant(row) as never);
        } else if (e.op === 'insert' && e.table_name === 'offer_photos') {
          const row = e.new_value as { offer_id: string; photo_id: string };
          await tx.store.delete('offer_photos', { offer_id: row.offer_id, photo_id: row.photo_id });
        }
      }
      await tx.store.update('merges', mergeId, { status: 'undone', undone_by: actor.userId, undone_at: tx.now });
      const table = TABLE_OF[merge.aggregate_type];
      const survivor = (await tx.store.get(table, merge.survivor_id)) as AnyRow | undefined;
      const version = ((survivor?.['version'] as number | undefined) ?? 0) + 1;
      await tx.store.update(table, merge.survivor_id, { version } as never);
      for (const id of merge.merged_ids) {
        const m = (await tx.store.get(table, id)) as AnyRow | undefined;
        if (m) await tx.store.update(table, id, { version: (m['version'] as number) + 1 } as never);
      }
      await tx.events.emit('records.merge_undone.v1', agg(merge.aggregate_type, merge.survivor_id, version), {
        mergeId,
        aggregateType: merge.aggregate_type,
        restoredIds: merge.merged_ids,
      });
      await emitAudit(app, tx, {
        action: 'merge_undone',
        actorUserId: actor.userId,
        subjectType: merge.aggregate_type,
        subjectId: merge.survivor_id,
        via: actor.via,
        details: { mergeId, restoredCount: String(merge.merged_ids.length), conflicts: String(conflicts) },
      });
      if (merge.aggregate_type === 'offer') for (const id of participants) affectedOffers.add(id);
      if (merge.aggregate_type === 'demand') for (const id of participants) affectedDemands.add(id);
      if (merge.aggregate_type === 'property') for (const o of await activeOfferIdsOf(tx, participants)) affectedOffers.add(o);
      const liveOffers = (await tx.store.getMany('offers', [...affectedOffers])).filter((o) => o.status === 'active').map((o) => o.id);
      const liveDemands = (await tx.store.getMany('demands', [...affectedDemands])).filter((d) => d.status === 'active').map((d) => d.id);
      await bumpOffersUpdated(tx, liveOffers);
      await bumpDemandsUpdated(tx, liveDemands);
      const row = (await tx.store.get('merges', mergeId)) as MergeRow;
      return { merge: row, conflicts };
    },
    { timeoutMs: 10_000 },
  );
}

/** JSON-logged values come back as JSON; timestamps stay ISO strings (valid input for timestamptz). */
const restoreValue = (v: unknown) => v;
const withoutTenant = (row: Record<string, unknown>) => {
  const { tenant_id: _t, ...rest } = row;
  void _t;
  return rest;
};

export async function dismissCandidate(app: App, actor: Actor, id: string, decision: 'different' | 'skipped', note?: string) {
  return app.uow.run(actor, async (tx) => {
    const c = await tx.store.get('merge_candidates', id, { lock: true });
    if (!c) throw notFound('merge candidate');
    if (c.status !== 'open' && c.status !== 'pending_target') throw new RecordsError('candidate-closed');
    await tx.store.update('merge_candidates', id, { status: decision, resolved_by: actor.userId, resolved_at: tx.now, note: note ?? null });
    return (await tx.store.get('merge_candidates', id))!;
  });
}
