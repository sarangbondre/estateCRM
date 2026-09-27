// Commercial axis re-derivation (LLD §4.2.1): recomputed in the same transaction after any engagement change; an
// event is written only when the value changes.
import { deriveDemandStatus, deriveOfferStatus } from '../domain/commercial.js';
import type { DemandStatus, OfferStatus } from '../domain/commercial.js';
import type { DemandJourneyRow, OfferJourneyRow } from './model.js';
import type { Tx } from './ports.js';
import { closeItems, openItem, resolveAssignee } from './queue-ops.js';

export interface DeriveOptions {
  /** Force a terminal status (Closed / Inactive) or leave one (compensation, R-12 reactivation). */
  set?: OfferStatus;
  /** Leave Closed / Inactive and derive from engagements (deal cancel, R-12 reactivation). */
  reopen?: boolean;
  reason?: string;
  inactiveReason?: string | null;
}

export async function setOfferStatus(
  tx: Tx,
  oj: OfferJourneyRow,
  next: OfferStatus,
  reason?: string,
  extra: Partial<OfferJourneyRow> = {},
): Promise<OfferJourneyRow> {
  if (oj.commercial_status === next && !Object.keys(extra).length) return oj;
  const changed = oj.commercial_status !== next;
  const updated =
    (await tx.rows.update('offer_journey', oj.id, {
      ...extra,
      ...(changed ? { commercial_status: next, commercial_changed_at: tx.now } : {}),
    })) ?? oj;
  if (changed) {
    await tx.events.emit(
      'offer.commercial_status_changed.v1',
      { type: 'offer', id: oj.id },
      { offerId: oj.id, from: oj.commercial_status, to: next, ...(reason ? { reason } : {}) },
    );
  }
  return updated;
}

/** Re-derives an offer's Commercial status from its live engagements. */
export async function rederiveOffer(tx: Tx, offerId: string, opts: DeriveOptions = {}): Promise<OfferJourneyRow | undefined> {
  const oj = await tx.rows.get('offer_journey', offerId);
  if (!oj) return undefined;
  const view = await tx.rows.get('offer_view', offerId);
  if (view?.voided) return oj;
  const e = await tx.q.offerEngagements(offerId, tx.today);
  const upcoming =
    view?.possession_status === 'Available From' && !!view.available_from && view.available_from > tx.today;
  const current = opts.set === undefined && !opts.reopen ? oj.commercial_status : null;
  const next = opts.set ?? deriveOfferStatus(current, { ...e, isUpcoming: upcoming });
  return setOfferStatus(tx, oj, next, opts.reason, {
    ...(opts.inactiveReason !== undefined ? { inactive_reason: opts.inactiveReason } : {}),
    open_match_count: e.openMatchCount,
    confirmed_match_count: e.confirmedMatchCount,
  });
}

export async function setDemandStatus(tx: Tx, dj: DemandJourneyRow, next: DemandStatus, extra: Partial<DemandJourneyRow> = {}) {
  const changed = dj.commercial_status !== next;
  if (!changed && !Object.keys(extra).length) return dj;
  const updated =
    (await tx.rows.update('demand_journey', dj.id, {
      ...extra,
      ...(changed ? { commercial_status: next, commercial_changed_at: tx.now } : {}),
    })) ?? dj;
  if (changed) {
    await tx.events.emit(
      'demand.status_changed.v1',
      { type: 'demand', id: dj.id },
      { demandId: dj.id, from: dj.commercial_status, to: next },
    );
    await syncInSourcing(tx, dj.id, next);
  }
  return updated;
}

/** in_sourcing (LLD §4.3.1): open while the demand is Sourcing (due = the earliest open SRQ due date). */
async function syncInSourcing(tx: Tx, demandId: string, status: DemandStatus) {
  if (status !== 'Sourcing') {
    await closeItems(tx, { subjectId: demandId, sections: ['in_sourcing'] }, 'done', `status_${status}`);
    return;
  }
  const view = await tx.rows.get('demand_view', demandId);
  if (!view || view.outside_launch_area) return;
  const srqs = await tx.q.openSourcingRequestsOfDemand(demandId);
  const due = srqs.map((s) => s.due_date).sort()[0];
  await openItem(tx, {
    section: 'in_sourcing',
    subjectType: 'demand',
    subjectId: demandId,
    subjectCode: view.code,
    demandId,
    assignee: await resolveAssignee(tx, 'demand', view.owner_user_id),
    reason: 'srq',
    reasonRef: srqs[0]?.code ?? null,
    dueAt: due ? new Date(`${due}T18:00:00+05:30`) : tx.now,
  });
}

/** Re-derives a demand's Commercial status; `set` forces Closed, `reopen` leaves Closed (deal cancel compensation). */
export async function rederiveDemand(
  tx: Tx,
  demandId: string,
  opts: { set?: DemandStatus; reopen?: boolean } = {},
): Promise<DemandJourneyRow | undefined> {
  const dj = await tx.rows.get('demand_journey', demandId);
  if (!dj) return undefined;
  if (opts.set) return setDemandStatus(tx, dj, opts.set);
  const e = await tx.q.demandEngagements(demandId);
  const current = opts.reopen ? null : dj.commercial_status;
  const next = deriveDemandStatus(current, {
    ...e,
    qualified: !!dj.qualified_at,
    contacted: !!dj.first_contacted_at,
  });
  return setDemandStatus(tx, dj, next);
}
