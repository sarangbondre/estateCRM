// Site visits (C-14, US-24; LLD §4.7): scheduled against live matches; completion resets both life curves.
import { isLiveOffer } from '../domain/commercial.js';
import { confirmSubject } from './curve.js';
import { rederiveDemand, rederiveOffer } from './derive.js';
import { JourneyError, invalidTransition, notFoundErr, versionMismatchErr } from './errors.js';
import type { SiteVisitRow } from './model.js';
import { notify } from './notify.js';
import type { Tx } from './ports.js';
import { closeItems, openItem, resolveAssignee } from './queue-ops.js';
import { isUuid } from './views.js';

export interface Caller {
  userId: string;
  role: string;
}

export const visitView = (v: SiteVisitRow) => ({
  id: v.id,
  code: v.code,
  demandId: v.demand_id,
  offerIds: v.offer_ids,
  scheduledAt: v.scheduled_at.toISOString(),
  attendeeUserIds: v.attendee_user_ids,
  status: v.status,
  outcome: (v.outcome as 'Interested' | null) ?? null,
  visitedOfferIds: v.visited_offer_ids,
  preferredOfferId: v.preferred_offer_id,
  completedAt: v.completed_at ? v.completed_at.toISOString() : null,
  notes: v.notes,
  createdBy: v.created_by,
  version: v.version,
});

export async function visitByIdOrCode(tx: Tx, idOrCode: string, forUpdate = false): Promise<SiteVisitRow> {
  const v = isUuid(idOrCode) ? await tx.rows.get('site_visits', idOrCode, { forUpdate }) : await tx.rows.byCode('site_visits', idOrCode);
  if (!v) throw notFoundErr('site visit');
  return v;
}

/** Offers must be live and linked to the demand by a live (Suggested / Confirmed) match (409 offer-not-matched). */
async function validateOffers(tx: Tx, demandId: string, offerIds: readonly string[]) {
  const live = await tx.q.matchesOfDemand(demandId, ['Suggested', 'Confirmed'], 500);
  const matched = new Set(live.flatMap((m) => m.offer_ids));
  for (const id of offerIds) {
    const oj = await tx.rows.get('offer_journey', id);
    if (!oj) throw notFoundErr(`offer ${id}`);
    if (!isLiveOffer(oj.commercial_status) || !matched.has(id))
      throw new JourneyError(409, 'offer-not-matched', `offer ${id} is not in a live match with the demand`);
  }
}

async function liveDemand(tx: Tx, demandId: string) {
  const view = await tx.rows.get('demand_view', demandId);
  const dj = await tx.rows.get('demand_journey', demandId);
  if (!view || !dj) throw notFoundErr('demand');
  if (dj.exit_type || dj.commercial_status === 'Closed' || view.voided) throw invalidTransition('the demand is not live');
  return view;
}

export async function scheduleVisit(
  tx: Tx,
  caller: Caller,
  body: { demandId: string; offerIds: string[]; scheduledAt: string; attendeeUserIds?: string[]; notes?: string | null },
) {
  const demand = await liveDemand(tx, body.demandId);
  const offerIds = [...new Set(body.offerIds)];
  await validateOffers(tx, demand.id, offerIds);
  const attendees = [...new Set(body.attendeeUserIds ?? [])];
  const visit = await tx.rows.insert('site_visits', {
    code: await tx.q.nextCode('VIS'),
    demand_id: demand.id,
    offer_ids: offerIds,
    scheduled_at: new Date(body.scheduledAt),
    attendee_user_ids: attendees,
    status: 'Scheduled',
    notes: body.notes ?? null,
    created_by: caller.userId,
  });
  if (!demand.outside_launch_area) {
    await openItem(tx, {
      section: 'site_visits_this_week',
      subjectType: 'site_visit',
      subjectId: visit.id,
      subjectCode: visit.code,
      demandId: demand.id,
      assignee: await resolveAssignee(tx, 'demand', demand.owner_user_id),
      reason: 'visit',
      reasonRef: demand.code,
      dueAt: visit.scheduled_at,
    });
  }
  for (const user of attendees) {
    await notify(tx, user, {
      kind: 'visit_scheduled',
      title: `Site visit ${visit.code} for ${demand.code} on ${body.scheduledAt.slice(0, 10)}`,
      subject: { type: 'site_visit', id: visit.id, code: visit.code },
    });
  }
  await tx.events.emit(
    'site_visit.scheduled.v1',
    { type: 'site_visit', id: visit.id },
    { visitId: visit.id, demandId: demand.id, offerIds, scheduledFor: visit.scheduled_at.toISOString() },
  );
  return visitView(visit);
}

export async function updateVisit(
  tx: Tx,
  idOrCode: string,
  patch: { scheduledAt?: string; offerIds?: string[]; attendeeUserIds?: string[]; status?: 'Cancelled'; notes?: string | null },
  expectedVersion: number | undefined,
) {
  const v = await visitByIdOrCode(tx, idOrCode, true);
  if (expectedVersion !== undefined && v.version !== expectedVersion) throw versionMismatchErr();
  if (v.status !== 'Scheduled') throw invalidTransition(`the visit is ${v.status}`);
  const next: Partial<SiteVisitRow> = {};
  if (patch.offerIds) {
    const ids = [...new Set(patch.offerIds)];
    await validateOffers(tx, v.demand_id, ids);
    next.offer_ids = ids;
  }
  if (patch.scheduledAt) next.scheduled_at = new Date(patch.scheduledAt);
  if (patch.attendeeUserIds) next.attendee_user_ids = [...new Set(patch.attendeeUserIds)];
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.status === 'Cancelled') next.status = 'Cancelled';
  const updated = (await tx.rows.update('site_visits', v.id, next)) ?? v;
  if (patch.status === 'Cancelled') await closeItems(tx, { subjectId: v.id }, 'cancelled', 'visit_cancelled');
  else if (patch.scheduledAt) for (const item of await tx.q.openItemsOf({ subjectId: v.id }, 5)) await tx.rows.update('queue_items', item.id, { due_at: updated.scheduled_at });
  return visitView(updated);
}

export async function completeVisit(
  tx: Tx,
  idOrCode: string,
  body: {
    outcome: 'Interested' | 'Shortlisted' | 'Not interested' | 'Client no-show' | 'Owner no-show';
    visitedOfferIds?: string[];
    preferredOfferId?: string | null;
    completedAt?: string | null;
    notes?: string | null;
  },
) {
  const v = await visitByIdOrCode(tx, idOrCode, true);
  if (v.status !== 'Scheduled') throw invalidTransition(`the visit is ${v.status}`);
  const visited = body.visitedOfferIds?.length ? [...new Set(body.visitedOfferIds)] : v.offer_ids;
  if (visited.some((id) => !v.offer_ids.includes(id)))
    throw new JourneyError(400, 'validation-failed', 'visitedOfferIds must be offers of the visit');
  if (body.preferredOfferId && !visited.includes(body.preferredOfferId))
    throw new JourneyError(400, 'validation-failed', 'preferredOfferId must be a visited offer');
  const at = body.completedAt ? new Date(body.completedAt) : tx.now;
  const updated =
    (await tx.rows.update('site_visits', v.id, {
      status: 'Completed',
      outcome: body.outcome,
      visited_offer_ids: visited,
      preferred_offer_id: body.preferredOfferId ?? null,
      completed_at: at,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    })) ?? v;
  await closeItems(tx, { subjectId: v.id }, 'done', 'visit_completed');
  // A visit is a confirmation for both sides, except the side that did not show up (US-24).
  if (body.outcome !== 'Client no-show') await confirmSubject(tx, 'demand', v.demand_id, 'visit', 'visit', at);
  for (const offerId of visited) {
    if (body.outcome !== 'Owner no-show') await confirmSubject(tx, 'offer', offerId, 'visit', 'visit', at);
    await rederiveOffer(tx, offerId);
  }
  await rederiveDemand(tx, v.demand_id);
  await tx.events.emit(
    'site_visit.completed.v1',
    { type: 'site_visit', id: v.id },
    { visitId: v.id, demandId: v.demand_id, offerIds: visited, ...(body.preferredOfferId ? { preferredOfferId: body.preferredOfferId } : {}) },
  );
  return visitView(updated);
}
