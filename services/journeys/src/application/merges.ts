// Merges (LLD §4.11): records.merged.v1 re-points journeys rows from each merged id to the survivor, keeping
// before-images in merge_log; records.merge_undone.v1 restores them (only where the row still holds the merged value).
import type { EventDataMap } from '@11e/contracts/events';
import { refreshCurve } from './curve.js';
import { rederiveDemand, rederiveOffer } from './derive.js';
import { uuids } from './facts.js';
import type { Tx } from './ports.js';
import { closeItems } from './queue-ops.js';
import type { RepointTarget } from './queries.js';

const OFFER_TARGETS: RepointTarget[] = [
  { table: 'calls', column: 'subject_id', kind: 'scalar' },
  { table: 'match_offers', column: 'offer_id', kind: 'scalar' },
  { table: 'deals', column: 'offer_id', kind: 'scalar' },
  { table: 'lease_renewals', column: 'offer_id', kind: 'scalar' },
  { table: 'site_visits', column: 'offer_ids', kind: 'array' },
  { table: 'proposal_options', column: 'offer_ids', kind: 'array' },
  { table: 'sourcing_requests', column: 'offer_ids', kind: 'array' },
  { table: 'subject_contacts', column: 'subject_id', kind: 'scalar' },
];
const DEMAND_TARGETS: RepointTarget[] = [
  { table: 'calls', column: 'subject_id', kind: 'scalar' },
  { table: 'sourcing_requests', column: 'demand_id', kind: 'scalar' },
  { table: 'proposals', column: 'demand_id', kind: 'scalar' },
  { table: 'site_visits', column: 'demand_id', kind: 'scalar' },
  { table: 'deals', column: 'demand_id', kind: 'scalar' },
  { table: 'match_view', column: 'demand_id', kind: 'scalar' },
  { table: 'subject_contacts', column: 'subject_id', kind: 'scalar' },
];
const PERSON_TARGETS: RepointTarget[] = [
  { table: 'calls', column: 'person_id', kind: 'scalar' },
  { table: 'subject_contacts', column: 'person_id', kind: 'scalar' },
];

async function mergeQueueItems(tx: Tx, mergeId: string, subjectType: 'offer' | 'demand', from: string, to: string) {
  // Duplicate open items collapse into the survivor's; the rest move over.
  const survivorSections = new Set((await tx.q.openItemsOf(subjectType === 'offer' ? { offerId: to } : { demandId: to }, 500)).map((i) => `${i.section}|${i.subject_type}`));
  for (const item of await tx.q.openItemsOf(subjectType === 'offer' ? { offerId: from } : { demandId: from }, 500)) {
    const key = `${item.section}|${item.subject_type === subjectType ? subjectType : item.subject_type}`;
    if (item.subject_id === from && survivorSections.has(key)) {
      await tx.q.logBefore(mergeId, 'queue_items', item.id, { status: item.status, closed_reason: item.closed_reason });
      await closeItems(tx, { ids: [item.id] }, 'cancelled', 'merged');
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (item.subject_id === from) patch['subject_id'] = to;
    if (item.offer_id === from) patch['offer_id'] = to;
    if (item.demand_id === from) patch['demand_id'] = to;
    await tx.q.logBefore(mergeId, 'queue_items', item.id, {
      subject_id: item.subject_id,
      offer_id: item.offer_id,
      demand_id: item.demand_id,
    });
    await tx.rows.update('queue_items', item.id, patch);
  }
}

async function mergeCurves(tx: Tx, mergeId: string, subjectType: 'offer' | 'demand', from: string, to: string) {
  const [a, b] = await Promise.all([tx.q.curveBySubject(subjectType, from), tx.q.curveBySubject(subjectType, to)]);
  if (a) {
    await tx.q.logBefore(mergeId, 'life_curve', a.id, { frozen: a.frozen, next_change_on: a.next_change_on });
    await tx.rows.update('life_curve', a.id, { frozen: true, next_change_on: null });
  }
  // The survivor keeps the latest confirmation.
  if (a?.last_confirmed_at && b && !b.frozen && (!b.last_confirmed_at || a.last_confirmed_at > b.last_confirmed_at)) {
    await tx.q.logBefore(mergeId, 'life_curve', b.id, { last_confirmed_at: b.last_confirmed_at, last_confirmed_how: b.last_confirmed_how });
    await refreshCurve(tx, b, { last_confirmed_at: a.last_confirmed_at, last_confirmed_how: a.last_confirmed_how });
  }
}

export async function applyMerge(tx: Tx, d: EventDataMap['records.merged.v1']): Promise<void> {
  const to = d.survivorId;
  const mergedIds = uuids(d.mergedIds).filter((id) => id !== to);
  if (d.aggregateType === 'property') return;
  if (d.aggregateType === 'person') {
    const survivor = await tx.rows.get('person_state', to);
    for (const from of mergedIds) {
      const merged = await tx.rows.get('person_state', from);
      for (const t of PERSON_TARGETS) await tx.q.repoint(d.mergeId, t, from, to, 1000);
      if (merged) {
        const flags = [...new Set([...(survivor?.flags ?? []), ...merged.flags])];
        if (survivor) {
          await tx.q.logBefore(d.mergeId, 'person_state', to, { flags: survivor.flags });
          await tx.rows.update('person_state', to, { flags });
        } else await tx.rows.insert('person_state', { id: to, flags, flag_version: merged.flag_version });
      }
    }
    return;
  }
  const subjectType = d.aggregateType;
  const targets = subjectType === 'offer' ? OFFER_TARGETS : DEMAND_TARGETS;
  for (const from of mergedIds) {
    for (const t of targets) await tx.q.repoint(d.mergeId, t, from, to, 1000);
    await mergeQueueItems(tx, d.mergeId, subjectType, from, to);
    await mergeCurves(tx, d.mergeId, subjectType, from, to);
    const view = subjectType === 'offer' ? await tx.rows.get('offer_view', from) : await tx.rows.get('demand_view', from);
    if (view) {
      await tx.q.logBefore(d.mergeId, `${subjectType}_view`, from, { merged_into: view.merged_into });
      if (subjectType === 'offer') await tx.rows.update('offer_view', from, { merged_into: to });
      else await tx.rows.update('demand_view', from, { merged_into: to });
    }
    if (subjectType === 'offer') {
      const [mj, sj] = await Promise.all([tx.rows.get('offer_journey', from), tx.rows.get('offer_journey', to)]);
      if (mj && sj && mj.enquiry_count) {
        await tx.q.logBefore(d.mergeId, 'offer_journey', to, { enquiry_count: sj.enquiry_count });
        await tx.rows.update('offer_journey', to, { enquiry_count: sj.enquiry_count + mj.enquiry_count });
      }
    }
  }
  if (subjectType === 'offer') await rederiveOffer(tx, to);
  else await rederiveDemand(tx, to);
}

export async function undoMerge(tx: Tx, d: EventDataMap['records.merge_undone.v1']): Promise<void> {
  // Returns the survivor ids the merge had re-pointed to; each subject is re-derived (unknown ids are no-ops).
  const survivors = await tx.q.restoreMerge(d.mergeId, 2000);
  for (const id of new Set([...uuids(d.restoredIds), ...survivors])) {
    await rederiveOffer(tx, id);
    await rederiveDemand(tx, id);
  }
}
