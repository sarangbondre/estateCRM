// Consumed events (LLD §5.2, queue q_journeys). Each handler runs in the drain transaction together with the
// processed_events dedupe; projections apply only when the event's aggregateVersion is newer than what is stored.
import type { EventDataMap, EventType } from '@11e/contracts/events';
import { istDate } from '../domain/dates.js';
import { isLiveOffer } from '../domain/commercial.js';
import { teamOf, teamForRole } from '../domain/queue.js';
import type { Section } from '../domain/queue.js';
import { watchlistDueDate } from '../domain/watchlist.js';
import {
  confirmSubject,
  createCurve,
  demandBasis,
  freezeCurve,
  offerBasis,
  refreshCurve,
  applyStageActions,
} from './curve.js';
import { rederiveDemand, rederiveOffer } from './derive.js';
import { cancelOpenSourcingRequests } from './exits.js';
import { demandCells, demandFacts, isContacted, offerCell, offerFacts, sameCell, uuids } from './facts.js';
import type { GapCell } from './facts.js';
import { applyMerge, undoMerge } from './merges.js';
import type { DemandViewRow, OfferViewRow } from './model.js';
import { notify } from './notify.js';
import { SYSTEM_ACTOR } from './ports.js';
import type { Tx } from './ports.js';
import { closeItems, moveItem, mustCallDue, openItem, rankOffer, resolveAssignee } from './queue-ops.js';

/** The envelope fields handlers use. */
export interface Incoming<T extends EventType> {
  eventId: string;
  eventType: T;
  occurredAt: string;
  aggregateId: string;
  aggregateType: string;
  aggregateVersion: number;
  data: EventDataMap[T];
}
export type Handler<T extends EventType> = (tx: Tx, e: Incoming<T>) => Promise<void>;

const occurred = (e: Incoming<EventType>) => new Date(e.occurredAt);

async function linkContacts(tx: Tx, subjectType: 'offer' | 'demand', subjectId: string, personIds: readonly string[]) {
  if (personIds.length) await tx.q.linkContacts(subjectType, subjectId, personIds);
}

async function touchGap(tx: Tx, cells: readonly GapCell[], demand: number, supply: number) {
  if (cells.length) await tx.q.adjustGapCells(cells, demand, supply, tx.now);
}

const supplyCounts = (status: string, stage: string | undefined) =>
  (status === 'Upcoming' || status === 'Available') && stage !== 'Expired';

// ---------------------------------------------------------------------------------------------------------- offers

async function offerCreated(tx: Tx, e: Incoming<'offer.created.v1'>) {
  const d = e.data;
  const existing = await tx.rows.get('offer_view', d.offerId, { forUpdate: true });
  const facts = { ...offerFacts(d, occurred(e)), facts_version: e.aggregateVersion };
  let view: OfferViewRow;
  if (!existing) {
    view = await tx.rows.insert('offer_view', { id: d.offerId, ...facts, captured_on: istDate(occurred(e)) });
  } else if (existing.facts_version < e.aggregateVersion) {
    view = (await tx.rows.update('offer_view', d.offerId, facts)) ?? existing;
  } else {
    view = existing;
  }
  await linkContacts(tx, 'offer', view.id, view.contact_person_ids);
  if (await tx.rows.get('offer_journey', view.id)) return; // journey already exists (replay or out-of-order)

  const upcoming =
    view.possession_status === 'Available From' && !!view.available_from && view.available_from > tx.today;
  const status = upcoming ? 'Upcoming' : 'Available';
  await tx.rows.insert('offer_journey', { id: view.id, commercial_status: status, commercial_changed_at: tx.now });
  await tx.events.emit(
    'offer.commercial_status_changed.v1',
    { type: 'offer', id: view.id },
    { offerId: view.id, from: '', to: status, reason: 'created' },
  );
  const curve = await createCurve(tx, 'offer', view.id, await offerBasis(tx, view));
  await touchGap(tx, [offerCell(view)].filter((c): c is GapCell => !!c), 0, supplyCounts(status, curve.stage) ? 1 : 0);
  if (view.outside_launch_area || view.voided) return;

  if (view.sourced_for_demand_id) {
    const srq = await tx.q.openSourcingRequestsOfDemand(view.sourced_for_demand_id).then((l) => l[0]);
    if (srq) {
      await tx.rows.update('sourcing_requests', srq.id, {
        offer_ids: [...new Set([...srq.offer_ids, view.id])].slice(0, 100),
      });
      await notify(tx, srq.requested_by, {
        kind: 'srq_fulfilled',
        title: `${view.code} added for ${srq.code}`,
        subject: { type: 'offer', id: view.id, code: view.code },
      });
    }
    await openItem(tx, {
      section: 'must_call',
      subjectType: 'offer',
      subjectId: view.id,
      subjectCode: view.code,
      offerId: view.id,
      assignee: await resolveAssignee(tx, 'supply', view.owner_user_id),
      reason: 'sourced_for',
      reasonRef: srq?.code ?? null,
      priority: 1,
      dueAt: await mustCallDue(tx, occurred(e)),
    });
    return;
  }
  if (curve.stage !== 'Fresh') {
    await applyStageActions(tx, 'offer', view.id, curve.stage);
    return;
  }
  await openItem(tx, {
    section: 'should_call',
    subjectType: 'offer',
    subjectId: view.id,
    subjectCode: view.code,
    offerId: view.id,
    assignee: await resolveAssignee(tx, 'supply', view.owner_user_id),
    reason: 'new_capture',
    rank: await rankOffer(tx, view, 'none'),
  });
}

async function moveOpenItems(tx: Tx, filter: { offerId?: string; demandId?: string }, team: 'supply' | 'demand', owner: string | null) {
  const assignee = await resolveAssignee(tx, team, owner);
  for (const item of await tx.q.openItemsOf(filter, 500)) {
    if (teamOf(item.section as Section) === team) await moveItem(tx, item, assignee);
  }
}

async function offerUpdated(tx: Tx, e: Incoming<'offer.updated.v1'>) {
  const d = e.data;
  const before = await tx.rows.get('offer_view', d.offerId, { forUpdate: true });
  if (!before) {
    // Treat as the first sighting of the offer (created event not yet seen): build everything from these facts.
    await offerCreated(tx, e as unknown as Incoming<'offer.created.v1'>);
    return;
  }
  if (before.facts_version >= e.aggregateVersion || before.voided) return;
  const view = (await tx.rows.update('offer_view', d.offerId, { ...offerFacts(d, occurred(e)), facts_version: e.aggregateVersion })) ?? before;
  await linkContacts(tx, 'offer', view.id, view.contact_person_ids);

  const oj = await tx.rows.get('offer_journey', view.id);
  const curve = await tx.q.curveBySubject('offer', view.id);
  const live = oj ? supplyCounts(oj.commercial_status, curve?.stage) : false;
  const oldCell = offerCell(before);
  const newCell = offerCell(view);
  if (!sameCell(oldCell, newCell) && live) {
    if (oldCell) await touchGap(tx, [oldCell], 0, -1);
    if (newCell) await touchGap(tx, [newCell], 0, 1);
  }
  if (curve && !curve.frozen) {
    const basis = await offerBasis(tx, view);
    if (
      basis.categoryKey !== curve.category_key ||
      basis.clockFloor !== curve.clock_floor ||
      basis.clockStartsOn !== curve.clock_starts_on
    ) {
      await refreshCurve(tx, curve, {
        category_key: basis.categoryKey,
        clock_floor: basis.clockFloor,
        clock_starts_on: basis.clockStartsOn,
      });
    }
  }
  if (oj) await rederiveOffer(tx, view.id);
  if (view.owner_user_id !== before.owner_user_id && view.owner_user_id) await moveOpenItems(tx, { offerId: view.id }, 'supply', view.owner_user_id);
  if (view.outside_launch_area && !before.outside_launch_area) await closeItems(tx, { offerId: view.id }, 'cancelled', 'outside_launch_area');
  await tx.q.markRankDirty({ offerId: view.id });
}

async function offerPriceChanged(tx: Tx, e: Incoming<'offer.price_changed.v1'>) {
  const view = await tx.rows.get('offer_view', e.data.offerId, { forUpdate: true });
  if (!view || view.facts_version >= e.aggregateVersion) return;
  const c = e.data.current;
  const patch: Partial<OfferViewRow> = { facts_version: e.aggregateVersion };
  if (c.salePriceInrMin !== undefined) patch.sale_price_inr_min = c.salePriceInrMin;
  if (c.salePriceInrMax !== undefined) patch.sale_price_inr_max = c.salePriceInrMax;
  if (c.rentMonthlyInrMin !== undefined) patch.rent_monthly_inr_min = c.rentMonthlyInrMin;
  if (c.rentMonthlyInrMax !== undefined) patch.rent_monthly_inr_max = c.rentMonthlyInrMax;
  if (c.unitCount !== undefined) patch.unit_count = c.unitCount;
  await tx.rows.update('offer_view', view.id, patch);
  await tx.q.markRankDirty({ offerId: view.id });
}

async function priceSheetApplied(tx: Tx, e: Incoming<'price_sheet.applied.v1'>) {
  const d = e.data;
  const sheetDate = d.sheetDate;
  const ids = d.changedOfferIds?.length
    ? uuids(d.changedOfferIds).slice(0, 500)
    : (await tx.q.offersOfProject(d.projectId, 500)).map((o) => o.id);
  for (const id of ids) {
    const view = await tx.rows.get('offer_view', id);
    if (!view || view.voided) continue;
    if (view.price_sheet_date && view.price_sheet_date >= sheetDate) continue;
    await tx.rows.update('offer_view', id, { price_sheet_date: sheetDate });
    const oj = await tx.rows.get('offer_journey', id);
    if (!oj || !isLiveOffer(oj.commercial_status)) continue;
    // A new sheet is a confirmation for every configuration of the project (how = price_sheet).
    const curve = await tx.q.curveBySubject('offer', id);
    const floor = curve && sheetDate > curve.clock_floor ? { clock_floor: sheetDate } : {};
    // The count follows the sheet's date (BRD §4.5), not the time it was applied.
    const sheetAt = new Date(`${sheetDate}T00:00:00+05:30`);
    await confirmSubject(tx, 'offer', id, 'price_sheet', 'price_sheet', sheetAt < tx.now ? sheetAt : tx.now, floor);
  }
}

async function offerRecordStageChanged(tx: Tx, e: Incoming<'offer.record_stage_changed.v1'>) {
  const view = await tx.rows.get('offer_view', e.data.offerId, { forUpdate: true });
  if (!view || view.stage_version >= e.aggregateVersion) return;
  await tx.rows.update('offer_view', view.id, {
    record_stage: e.data.to,
    stage_version: e.aggregateVersion,
    ...(e.data.hasRealPhotos !== undefined ? { has_real_photos: e.data.hasRealPhotos } : {}),
  });
}

async function offerVoided(tx: Tx, e: Incoming<'offer.voided.v1'>) {
  const view = await tx.rows.get('offer_view', e.data.offerId, { forUpdate: true });
  if (!view || view.voided) return;
  await tx.rows.update('offer_view', view.id, { voided: true });
  await closeItems(tx, { offerId: view.id }, 'cancelled', 'voided');
  await freezeCurve(tx, 'offer', view.id);
  const oj = await tx.rows.get('offer_journey', view.id);
  const cell = offerCell(view);
  if (oj && cell && (oj.commercial_status === 'Upcoming' || oj.commercial_status === 'Available')) await touchGap(tx, [cell], 0, -1);
}

async function enquiryReceived(tx: Tx, e: Incoming<'enquiry.received.v1'>) {
  const d = e.data;
  let offer: OfferViewRow | undefined;
  if (d.offerId) offer = await tx.rows.get('offer_view', d.offerId);
  else if (d.projectId) {
    // JA-7: an enquiry on a project goes to its oldest live configuration.
    for (const o of await tx.q.offersOfProject(d.projectId, 50)) {
      const oj = await tx.rows.get('offer_journey', o.id);
      if (oj && isLiveOffer(oj.commercial_status) && !o.voided) {
        offer = o;
        break;
      }
    }
  }
  if (!offer || offer.voided) return;
  const oj = await tx.rows.get('offer_journey', offer.id);
  if (oj) await tx.rows.update('offer_journey', oj.id, { enquiry_count: oj.enquiry_count + 1 });
  if (offer.outside_launch_area || (oj && !isLiveOffer(oj.commercial_status))) return;
  const received = d.receivedAt ? new Date(d.receivedAt) : occurred(e);
  const owner = await resolveAssignee(tx, 'supply', offer.owner_user_id);
  await openItem(tx, {
    section: 'must_call',
    subjectType: 'offer',
    subjectId: offer.id,
    subjectCode: offer.code,
    offerId: offer.id,
    assignee: owner,
    reason: 'enquiry',
    reasonRef: d.code,
    priority: 0,
    dueAt: await mustCallDue(tx, received),
  });
  await notify(tx, offer.owner_user_id ?? owner, {
    kind: 'enquiry',
    title: `New enquiry ${d.code} on ${offer.code}`,
    subject: { type: 'offer', id: offer.id, code: offer.code },
  });
}

// --------------------------------------------------------------------------------------------------------- demands

async function demandCreated(tx: Tx, e: Incoming<'demand.created.v1'>) {
  const d = e.data;
  const existing = await tx.rows.get('demand_view', d.demandId, { forUpdate: true });
  const facts = { ...demandFacts(d, occurred(e)), facts_version: e.aggregateVersion };
  let view: DemandViewRow;
  if (!existing) view = await tx.rows.insert('demand_view', { id: d.demandId, ...facts, captured_on: istDate(occurred(e)) });
  else if (existing.facts_version < e.aggregateVersion) view = (await tx.rows.update('demand_view', d.demandId, facts)) ?? existing;
  else view = existing;
  await linkContacts(tx, 'demand', view.id, view.contact_person_ids);
  if (await tx.rows.get('demand_journey', view.id)) return;

  await tx.rows.insert('demand_journey', { id: view.id, commercial_status: 'New', commercial_changed_at: tx.now });
  await tx.events.emit('demand.status_changed.v1', { type: 'demand', id: view.id }, { demandId: view.id, from: '', to: 'New' });
  await createCurve(tx, 'demand', view.id, await demandBasis(tx, view));
  await touchGap(tx, demandCells(view), 1, 0);
  if (view.outside_launch_area) return;
  await openItem(tx, {
    section: 'to_contact',
    subjectType: 'demand',
    subjectId: view.id,
    subjectCode: view.code,
    demandId: view.id,
    assignee: await resolveAssignee(tx, 'demand', view.owner_user_id),
    reason: 'first_contact',
    dueAt: await mustCallDue(tx, occurred(e)),
  });
}

async function demandUpdated(tx: Tx, e: Incoming<'demand.updated.v1'>) {
  const d = e.data;
  const before = await tx.rows.get('demand_view', d.demandId, { forUpdate: true });
  if (!before) {
    await demandCreated(tx, e as unknown as Incoming<'demand.created.v1'>);
    return;
  }
  if (before.facts_version >= e.aggregateVersion || before.voided) return;
  const view = (await tx.rows.update('demand_view', d.demandId, { ...demandFacts(d, occurred(e)), facts_version: e.aggregateVersion })) ?? before;
  await linkContacts(tx, 'demand', view.id, view.contact_person_ids);
  const dj = await tx.rows.get('demand_journey', view.id);
  const openDemand = dj && !dj.exit_type && dj.commercial_status !== 'Closed';
  if (openDemand) {
    const oldCells = demandCells(before);
    const newCells = demandCells(view);
    const key = (c: GapCell) => `${c.segment}|${c.dealType}|${c.micromarket}`;
    const removed = oldCells.filter((c) => !newCells.some((n) => key(n) === key(c)));
    const added = newCells.filter((c) => !oldCells.some((o) => key(o) === key(c)));
    await touchGap(tx, removed, -1, 0);
    await touchGap(tx, added, 1, 0);
  }
  const curve = await tx.q.curveBySubject('demand', view.id);
  if (curve && !curve.frozen) {
    const basis = await demandBasis(tx, view);
    if (basis.categoryKey !== curve.category_key) await refreshCurve(tx, curve, { category_key: basis.categoryKey });
  }
  if (view.owner_user_id !== before.owner_user_id && view.owner_user_id) await moveOpenItems(tx, { demandId: view.id }, 'demand', view.owner_user_id);
}

async function demandVoided(tx: Tx, e: Incoming<'demand.voided.v1'>) {
  const view = await tx.rows.get('demand_view', e.data.demandId, { forUpdate: true });
  if (!view || view.voided) return;
  await tx.rows.update('demand_view', view.id, { voided: true });
  await cancelOpenSourcingRequests(tx, view.id);
  await closeItems(tx, { demandId: view.id }, 'cancelled', 'voided');
  await freezeCurve(tx, 'demand', view.id);
  const dj = await tx.rows.get('demand_journey', view.id);
  if (dj && !dj.exit_type && dj.commercial_status !== 'Closed') await touchGap(tx, demandCells(view), -1, 0);
}

async function demandTouchAdded(tx: Tx, e: Incoming<'demand.touch_added.v1'>) {
  const view = await tx.rows.get('demand_view', e.data.demandId, { forUpdate: true });
  if (!view) return;
  // A touch moves last seen only; it is not a confirmation (AC2).
  await tx.rows.update('demand_view', view.id, {
    touch_count: view.touch_count + (e.data.isFirstTouch ? 0 : 1),
    last_seen_on: tx.today,
  });
  if (!e.data.isFirstTouch) {
    await notify(tx, view.owner_user_id, {
      kind: 'enquiry',
      title: `Another touch on ${view.code} via ${e.data.sourceType}`.slice(0, 200),
      subject: { type: 'demand', id: view.id, code: view.code },
    });
  }
}

// ------------------------------------------------------------------------------------------------ people and users

const CLOSING_FLAGS = new Set(['invalid', 'unwilling']);

async function personFlagged(tx: Tx, e: Incoming<'person.flagged.v1'>) {
  const d = e.data;
  const state = await tx.rows.get('person_state', d.personId, { forUpdate: true });
  if (state && state.flag_version >= e.aggregateVersion) return;
  const flags = [...new Set([...(state?.flags ?? []), d.flag])];
  if (state) await tx.rows.update('person_state', d.personId, { flags, flag_version: e.aggregateVersion });
  else await tx.rows.insert('person_state', { id: d.personId, flags, flag_version: e.aggregateVersion });
  if (!CLOSING_FLAGS.has(d.flag)) return;
  for (const link of await tx.q.subjectsOfPerson(d.personId, 500)) {
    if (link.subject_type === 'offer') await closeItems(tx, { offerId: link.subject_id }, 'cancelled', `person_${d.flag}`);
  }
}

async function personFlagRemoved(tx: Tx, e: Incoming<'person.flag_removed.v1'>) {
  const d = e.data;
  const state = await tx.rows.get('person_state', d.personId, { forUpdate: true });
  if (!state) {
    await tx.rows.insert('person_state', { id: d.personId, flags: [], flag_version: e.aggregateVersion });
    return;
  }
  if (state.flag_version >= e.aggregateVersion) return;
  // Removal re-opens nothing automatically (the next reconfirm cycle picks the subject up).
  await tx.rows.update('person_state', d.personId, { flags: state.flags.filter((f) => f !== d.flag), flag_version: e.aggregateVersion });
}

async function userChanged(tx: Tx, e: Incoming<'user.changed.v1'>) {
  const d = e.data;
  const before = await tx.rows.get('staff_users', d.userId, { forUpdate: true });
  if (before && before.source_version >= e.aggregateVersion) return;
  const row = { role: d.role, active: d.active, display_name: d.displayName ?? null, source_version: e.aggregateVersion };
  if (before) await tx.rows.update('staff_users', d.userId, row);
  else await tx.rows.insert('staff_users', { id: d.userId, ...row });

  const team = teamForRole(d.role);
  const cap = await tx.q.capacityOf(d.userId);
  if (cap && team && cap.team !== team) await tx.rows.update('capacities', cap.id, { team, updated_by: SYSTEM_ACTOR });

  if (!d.active && (before?.active ?? true)) {
    // Deactivation: reassign open items the same way (system actor, R-7) and tell the Managers.
    const items = await tx.q.openItemsOfAssignee(d.userId, 500);
    tx.memo.delete('assignee:supply');
    tx.memo.delete('assignee:demand');
    for (const item of items) {
      const t = teamOf(item.section as Section);
      const next = await resolveAssignee(tx, t, null);
      await moveItem(tx, item, next === d.userId ? null : next);
    }
    for (const m of await tx.q.activeStaffByRole(['Manager'], 20)) {
      await notify(tx, m.id, {
        kind: 'watchlist_task',
        title: `${items.length} queue items reassigned from a deactivated user`,
        subject: null,
      });
    }
    return;
  }
  if (d.active && team) {
    // A newly active agent adopts unassigned work of the team (items created before anyone could take them).
    for (const item of await tx.q.unassignedOpenItems(team, 500)) await moveItem(tx, item, d.userId);
  }
}

async function watchlistItemCreated(tx: Tx, e: Incoming<'watchlist_item.created.v1'>) {
  const d = e.data;
  if (await tx.q.watchlistTaskOfItem(d.watchlistItemId)) return;
  const deadline = d.deadlineDate ?? null;
  const assignee = await resolveAssignee(tx, 'supply', null);
  const due = watchlistDueDate(deadline, tx.today);
  const task = await tx.rows.insert('watchlist_tasks', {
    watchlist_item_id: d.watchlistItemId,
    watchlist_code: d.code,
    signal_type: d.signalType,
    deadline_date: deadline,
    assignee_user_id: assignee,
    due_date: due,
    status: 'Open',
  });
  await openItem(tx, {
    section: 'watchlist_tasks',
    subjectType: 'watchlist_task',
    subjectId: task.id,
    subjectCode: d.code,
    assignee,
    reason: 'watchlist',
    reasonRef: d.code,
    dueAt: new Date(`${deadline ?? due}T00:00:00+05:30`),
  });
  await notify(tx, assignee, {
    kind: 'watchlist_task',
    title: `Watchlist follow-up ${d.code} (${d.signalType})`.slice(0, 200),
    subject: { type: 'watchlist_task', id: task.id, code: d.code },
  });
}

async function publicationChanged(tx: Tx, e: Incoming<'publication.changed.v1'>) {
  const d = e.data;
  if (d.subjectType !== 'offer') return;
  const view = await tx.rows.get('offer_view', d.subjectId, { forUpdate: true });
  if (!view || view.publication_version >= e.aggregateVersion) return;
  await tx.rows.update('offer_view', view.id, { publication_level: d.to, publication_version: e.aggregateVersion });
  const curve = await tx.q.curveBySubject('offer', view.id);
  if (curve?.stage === 'Stale' && d.to === 'Public') await applyStageActions(tx, 'offer', view.id, 'Stale');
  await tx.q.markRankDirty({ offerId: view.id });
}

// --------------------------------------------------------------------------------------------------------- matches

async function upsertMatch(
  tx: Tx,
  e: Incoming<EventType>,
  m: { matchId: string; demandId: string; offerIds?: string[]; code?: string; score?: number; isBundle?: boolean; flags?: string[] },
  status: 'Suggested' | 'Confirmed' | 'Rejected' | 'Closed' | null,
  closedReason?: string,
) {
  const existing = await tx.rows.get('match_view', m.matchId, { forUpdate: true });
  if (existing && existing.source_version >= e.aggregateVersion) return { match: existing, applied: false };
  const offerIds = m.offerIds ? uuids(m.offerIds) : (existing?.offer_ids ?? []);
  let match;
  if (!existing) {
    match = await tx.rows.insert('match_view', {
      id: m.matchId,
      code: m.code ?? m.matchId.slice(0, 8),
      demand_id: m.demandId,
      offer_ids: offerIds,
      is_bundle: m.isBundle ?? offerIds.length > 1,
      score: Math.trunc(m.score ?? 0),
      status: status ?? 'Suggested',
      flags: m.flags ?? [],
      closed_reason: closedReason ?? null,
      source_version: e.aggregateVersion,
    });
  } else {
    // A Confirmed match keeps its status on a new suggestion (only score / flags change).
    const nextStatus = status === 'Suggested' && existing.status === 'Confirmed' ? 'Confirmed' : (status ?? existing.status);
    match =
      (await tx.rows.update('match_view', m.matchId, {
        ...(m.code ? { code: m.code } : {}),
        offer_ids: offerIds,
        ...(m.score !== undefined ? { score: Math.trunc(m.score) } : {}),
        ...(m.flags ? { flags: m.flags } : {}),
        ...(m.isBundle !== undefined ? { is_bundle: m.isBundle } : {}),
        status: nextStatus,
        closed_reason: closedReason ?? (nextStatus === 'Closed' ? existing.closed_reason : null),
        source_version: e.aggregateVersion,
      })) ?? existing;
  }
  if (offerIds.length) await tx.q.linkMatchOffers(match.id, m.demandId, offerIds);
  return { match, applied: true };
}

async function refreshOpenMatchesItem(tx: Tx, demandId: string) {
  const dj = await tx.rows.get('demand_journey', demandId);
  const view = await tx.rows.get('demand_view', demandId);
  if (!dj || !view) return;
  const suggested = await tx.q.countMatchesOfDemand(demandId, ['Suggested']);
  if (suggested > 0 && dj.qualified_at && !dj.exit_type && dj.commercial_status !== 'Closed' && !view.outside_launch_area) {
    await openItem(tx, {
      section: 'open_matches',
      subjectType: 'demand',
      subjectId: demandId,
      subjectCode: view.code,
      demandId,
      assignee: await resolveAssignee(tx, 'demand', view.owner_user_id),
      reason: 'open_matches',
    });
  } else {
    await closeItems(tx, { subjectId: demandId, sections: ['open_matches'] }, 'done', 'no_suggested_matches');
  }
}

async function matchSuggested(tx: Tx, e: Incoming<'match.suggested.v1'>) {
  const d = e.data;
  const { match, applied } = await upsertMatch(tx, e, d, 'Suggested');
  if (!applied) return;
  const demand = await tx.rows.get('demand_view', d.demandId);
  for (const offerId of match.offer_ids) {
    const offer = await tx.rows.get('offer_view', offerId);
    await rederiveOffer(tx, offerId);
    // JA-3: a Suggested match creates a Must call only while the offer is not yet Contacted.
    if (offer && !offer.voided && !offer.outside_launch_area && !isContacted(offer.record_stage) && match.status === 'Suggested') {
      const oj = await tx.rows.get('offer_journey', offerId);
      if (oj && isLiveOffer(oj.commercial_status)) {
        await openItem(tx, {
          section: 'must_call',
          subjectType: 'offer',
          subjectId: offerId,
          subjectCode: offer.code,
          offerId,
          assignee: await resolveAssignee(tx, 'supply', offer.owner_user_id),
          reason: 'match',
          reasonRef: match.code,
          dueAt: await mustCallDue(tx, occurred(e)),
        });
      }
    }
  }
  await closeItems(tx, { subjectId: d.demandId, sections: ['needs_sourcing'] }, 'done', 'match_arrived');
  await refreshOpenMatchesItem(tx, d.demandId);
  if (demand) {
    await notify(tx, demand.owner_user_id, {
      kind: 'match_suggested',
      title: `New match for ${demand.code}`,
      groupedTitle: (n) => `${n} new matches for ${demand.code}`,
      subject: { type: 'demand', id: demand.id, code: demand.code },
      dedupeKey: `match_suggested:${demand.id}`,
    });
  }
}

async function matchConfirmed(tx: Tx, e: Incoming<'match.confirmed.v1'>) {
  const d = e.data;
  const { match, applied } = await upsertMatch(tx, e, d, 'Confirmed');
  if (!applied) return;
  for (const offerId of match.offer_ids) {
    await rederiveOffer(tx, offerId);
    const offer = await tx.rows.get('offer_view', offerId);
    const oj = await tx.rows.get('offer_journey', offerId);
    if (!offer || offer.voided || offer.outside_launch_area || !oj || !isLiveOffer(oj.commercial_status)) continue;
    // JA-3: any newly Confirmed match is a Must call.
    await openItem(tx, {
      section: 'must_call',
      subjectType: 'offer',
      subjectId: offerId,
      subjectCode: offer.code,
      offerId,
      assignee: await resolveAssignee(tx, 'supply', offer.owner_user_id),
      reason: 'match',
      reasonRef: match.code,
      dueAt: await mustCallDue(tx, occurred(e)),
    });
    await notify(tx, offer.owner_user_id, {
      kind: 'match_confirmed',
      title: `${match.code} confirmed on ${offer.code}`,
      subject: { type: 'offer', id: offerId, code: offer.code },
    });
  }
  await rederiveDemand(tx, d.demandId);
  await closeItems(tx, { subjectId: d.demandId, sections: ['needs_sourcing'] }, 'done', 'match_arrived');
  await refreshOpenMatchesItem(tx, d.demandId);
}

async function matchRejected(tx: Tx, e: Incoming<'match.rejected.v1'>) {
  const { match, applied } = await upsertMatch(tx, e, e.data, 'Rejected');
  if (!applied) return;
  for (const offerId of match.offer_ids) await rederiveOffer(tx, offerId);
  await rederiveDemand(tx, e.data.demandId);
  await refreshOpenMatchesItem(tx, e.data.demandId);
}

async function matchClosed(tx: Tx, e: Incoming<'match.closed.v1'>) {
  const d = e.data;
  const { match, applied } = await upsertMatch(tx, e, d, 'Closed', d.reason);
  if (!applied) return;
  for (const offerId of match.offer_ids) await rederiveOffer(tx, offerId);
  await rederiveDemand(tx, d.demandId);
  await refreshOpenMatchesItem(tx, d.demandId);
  if (d.reason === 'leased_to_another_client' || d.reason === 'sold_to_another_client') {
    const demand = await tx.rows.get('demand_view', d.demandId);
    if (demand) {
      await notify(tx, demand.owner_user_id, {
        kind: 'match_closed',
        title: `${match.code} on ${demand.code} closed: ${d.reason === 'leased_to_another_client' ? 'leased' : 'sold'} to another client`,
        subject: { type: 'demand', id: demand.id, code: demand.code },
      });
    }
  }
}

async function matchReopened(tx: Tx, e: Incoming<'match.reopened.v1'>) {
  const d = e.data;
  // The event carries no status: the cancelled deal's own match returns Confirmed, any other match Suggested.
  const ownDeal = d.reason === 'deal_cancelled' && (await tx.q.dealOfMatch(d.matchId));
  const { match, applied } = await upsertMatch(tx, e, d, ownDeal ? 'Confirmed' : 'Suggested');
  if (!applied) return;
  for (const offerId of match.offer_ids) await rederiveOffer(tx, offerId);
  await rederiveDemand(tx, d.demandId);
  await refreshOpenMatchesItem(tx, d.demandId);
  const demand = await tx.rows.get('demand_view', d.demandId);
  if (demand) {
    await notify(tx, demand.owner_user_id, {
      kind: 'match_suggested',
      title: `${match.code} reopened for ${demand.code}`,
      subject: { type: 'demand', id: demand.id, code: demand.code },
    });
  }
}

async function matchFlagged(tx: Tx, e: Incoming<'match.flagged.v1'>) {
  const d = e.data;
  const match = await tx.rows.get('match_view', d.matchId, { forUpdate: true });
  if (!match) return;
  const had = match.flags.includes(d.flag);
  const flags = d.cleared ? match.flags.filter((f) => f !== d.flag) : [...new Set([...match.flags, d.flag])];
  await tx.rows.update('match_view', match.id, { flags });
  if (!d.cleared && !had && d.flag === 'price_above_budget') {
    const demand = await tx.rows.get('demand_view', match.demand_id);
    if (demand) {
      await notify(tx, demand.owner_user_id, {
        kind: 'match_flagged',
        title: `${match.code}: price above budget for ${demand.code}`,
        subject: { type: 'demand', id: demand.id, code: demand.code },
      });
    }
  }
}

async function demandMatchingCompleted(tx: Tx, e: Incoming<'demand.matching_completed.v1'>) {
  const d = e.data;
  const dj = await tx.rows.get('demand_journey', d.demandId);
  const view = await tx.rows.get('demand_view', d.demandId);
  if (!dj || !view) return;
  const none = d.matchCount + (d.bundleCount ?? 0) === 0;
  if (none && dj.qualified_at && !dj.exit_type && dj.commercial_status !== 'Closed' && !view.outside_launch_area) {
    const hasSrq = (await tx.q.openSourcingRequestsOfDemand(d.demandId)).length > 0;
    if (hasSrq) return;
    await openItem(tx, {
      section: 'needs_sourcing',
      subjectType: 'demand',
      subjectId: d.demandId,
      subjectCode: view.code,
      demandId: d.demandId,
      assignee: await resolveAssignee(tx, 'demand', view.owner_user_id),
      reason: 'no_matches',
    });
    await notify(tx, view.owner_user_id, {
      kind: 'match_suggested',
      title: `No inventory for ${view.code}: raise a sourcing request`,
      subject: { type: 'demand', id: view.id, code: view.code },
    });
  } else if (!none) {
    await closeItems(tx, { subjectId: d.demandId, sections: ['needs_sourcing'] }, 'done', 'match_arrived');
  }
}

// ---------------------------------------------------------------------------------------------------------- merges

async function recordsMerged(tx: Tx, e: Incoming<'records.merged.v1'>) {
  await applyMerge(tx, e.data);
}
async function recordsMergeUndone(tx: Tx, e: Incoming<'records.merge_undone.v1'>) {
  await undoMerge(tx, e.data);
}

type HandlerMap = { [T in EventType]?: Handler<T> };

/** Every event routed to q_journeys (event-topology.json). */
export const handlers: HandlerMap = {
  'offer.created.v1': offerCreated,
  'offer.updated.v1': offerUpdated,
  'offer.price_changed.v1': offerPriceChanged,
  'offer.record_stage_changed.v1': offerRecordStageChanged,
  'offer.voided.v1': offerVoided,
  'price_sheet.applied.v1': priceSheetApplied,
  'enquiry.received.v1': enquiryReceived,
  'demand.created.v1': demandCreated,
  'demand.updated.v1': demandUpdated,
  'demand.voided.v1': demandVoided,
  'demand.touch_added.v1': demandTouchAdded,
  'records.merged.v1': recordsMerged,
  'records.merge_undone.v1': recordsMergeUndone,
  'person.flagged.v1': personFlagged,
  'person.flag_removed.v1': personFlagRemoved,
  'watchlist_item.created.v1': watchlistItemCreated,
  'publication.changed.v1': publicationChanged,
  'user.changed.v1': userChanged,
  'match.suggested.v1': matchSuggested,
  'match.confirmed.v1': matchConfirmed,
  'match.rejected.v1': matchRejected,
  'match.closed.v1': matchClosed,
  'match.reopened.v1': matchReopened,
  'match.flagged.v1': matchFlagged,
  'demand.matching_completed.v1': demandMatchingCompleted,
};
