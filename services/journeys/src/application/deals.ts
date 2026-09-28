// Deals (C-15, US-25, US-27, US-16; LLD §4.7): open with a mandatory next action, forward-only stages, close in one
// transaction (the saga start, HLD §5.4), cancel as the compensation, lease renewal at month 10.
import { istDate } from '../domain/dates.js';
import { isLiveOffer } from '../domain/commercial.js';
import { canMoveStage, closingTermsMissing, followUpValid, isOpenStage, isOverdue, leaseRenewalPlan } from '../domain/deals.js';
import type { DealStage } from '../domain/deals.js';
import { confirmSubject, freezeCurve, unfreezeCurve } from './curve.js';
import { rederiveDemand, rederiveOffer } from './derive.js';
import { JourneyError, forbiddenErr, invalidTransition, notFoundErr, versionMismatchErr } from './errors.js';
import { demandCells } from './facts.js';
import type { DealRow, LeaseRenewalRow } from './model.js';
import { audit, notify } from './notify.js';
import type { Tx } from './ports.js';
import { closeItems, openItem, resolveAssignee } from './queue-ops.js';
import { isUuid } from './views.js';

export interface Caller {
  userId: string;
  role: string;
}

const TERM_KEYS = [
  'priceInr',
  'rentMonthlyInr',
  'depositInr',
  'leaseMonths',
  'leaseStartDate',
  'lockInMonths',
  'fitoutMonths',
  'rentFreeMonths',
  'escalationPct',
  'unitsBooked',
  'partnerSharePct',
  'otherTerms',
] as const;
type Terms = Partial<Record<(typeof TERM_KEYS)[number], unknown>>;

/** JSON Merge Patch of the agreed terms; only contract keys are kept (no contacts). */
function mergeTerms(current: Record<string, unknown>, patch: Record<string, unknown> | undefined): Terms {
  const out: Record<string, unknown> = {};
  for (const k of TERM_KEYS) if (current[k] !== undefined && current[k] !== null) out[k] = current[k];
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(TERM_KEYS as readonly string[]).includes(k)) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export async function dealView(tx: Tx, d: DealRow, renewal?: LeaseRenewalRow) {
  const history = await tx.q.dealEvents(d.id, 50);
  const lease = renewal ?? (await tx.q.leaseRenewalOfDeal(d.id));
  return {
    id: d.id,
    code: d.code,
    demandId: d.demand_id,
    offerId: d.offer_id,
    matchId: d.match_id,
    stage: d.stage,
    agreedTerms: d.agreed_terms as Record<string, never>,
    nextAction: d.next_action,
    followUpDate: d.follow_up_date,
    overdue: isOpenStage(d.stage) && isOverdue(d.follow_up_date, tx.today),
    closingPriceInr: d.closing_price_inr,
    closedAt: d.closed_at ? d.closed_at.toISOString() : null,
    cancelledAt: d.cancelled_at ? d.cancelled_at.toISOString() : null,
    cancelReasonCode: d.cancel_reason_code,
    cancelReason: d.cancel_reason,
    leaseRenewalDueOn: lease && lease.status !== 'cancelled' ? lease.due_on : null,
    stageHistory: history
      .filter((e) => e.kind === 'stage' || e.kind === 'cancel')
      .slice(-20)
      .map((e) => ({ from: e.from_stage, to: e.to_stage ?? 'Cancelled', at: e.at.toISOString(), by: e.by_user })),
    createdBy: d.created_by,
    createdAt: d.created_at.toISOString(),
    version: d.version,
  };
}

export async function dealByIdOrCode(tx: Tx, idOrCode: string, forUpdate = false): Promise<DealRow> {
  const d = isUuid(idOrCode) ? await tx.rows.get('deals', idOrCode, { forUpdate }) : await tx.rows.byCode('deals', idOrCode);
  if (!d) throw notFoundErr('deal');
  return d;
}

const followUpErr = () => new JourneyError(400, 'follow-up-required', 'nextAction and followUpDate (today or later) are required');
const followUpDue = (date: string) => new Date(`${date}T10:00:00+05:30`);

async function dealUpdated(tx: Tx, d: DealRow) {
  await tx.events.emit(
    'deal.updated.v1',
    { type: 'deal', id: d.id },
    { dealId: d.id, stage: d.stage, followUpDate: d.follow_up_date ?? istDate(d.closed_at ?? d.cancelled_at ?? tx.now), overdue: isOpenStage(d.stage) && isOverdue(d.follow_up_date, tx.today) },
  );
}

export async function openDeal(
  tx: Tx,
  caller: Caller,
  body: { demandId: string; offerId: string; matchId?: string | null; agreedTerms?: Record<string, unknown>; nextAction: string; followUpDate: string },
) {
  if (!followUpValid(body.nextAction, body.followUpDate, tx.today)) throw followUpErr();
  const [demand, dj, offer, oj] = await Promise.all([
    tx.rows.get('demand_view', body.demandId),
    tx.rows.get('demand_journey', body.demandId, { forUpdate: true }),
    tx.rows.get('offer_view', body.offerId),
    tx.rows.get('offer_journey', body.offerId, { forUpdate: true }),
  ]);
  if (!demand || !dj) throw notFoundErr('demand');
  if (!offer || !oj) throw notFoundErr('offer');
  if (dj.exit_type || dj.commercial_status === 'Closed') throw invalidTransition('the demand is not live');
  if (!isLiveOffer(oj.commercial_status) || offer.voided) throw invalidTransition(`the offer is ${oj.commercial_status}`);
  if (body.matchId) {
    const m = await tx.rows.get('match_view', body.matchId);
    if (!m || m.demand_id !== demand.id || m.status !== 'Confirmed' || !m.offer_ids.includes(offer.id))
      throw new JourneyError(409, 'match-not-confirmed', 'matchId is not a Confirmed match of this demand and offer');
  }
  if (await tx.q.openDealOfDemand(demand.id)) throw new JourneyError(409, 'deal-already-open', 'the demand already has an open deal');
  const multiUnit = (offer.unit_count ?? 1) > 1;
  if (!multiUnit && (await tx.q.openDealsOfOffer(offer.id, 1)).length)
    throw new JourneyError(409, 'deal-already-open', 'the offer already has an open deal');
  const deal = await tx.rows.insert('deals', {
    code: await tx.q.nextCode('DEAL'),
    demand_id: demand.id,
    offer_id: offer.id,
    match_id: body.matchId ?? null,
    multi_unit: multiUnit,
    stage: 'Negotiation',
    agreed_terms: mergeTerms({}, body.agreedTerms) as Record<string, unknown>,
    next_action: body.nextAction,
    follow_up_date: body.followUpDate,
    owner_user_id: demand.owner_user_id,
    created_by: caller.userId,
  });
  await tx.rows.insert('deal_events', {
    deal_id: deal.id,
    kind: 'stage',
    from_stage: null,
    to_stage: 'Negotiation',
    next_action: body.nextAction,
    follow_up_date: body.followUpDate,
    at: tx.now,
    by_user: caller.userId,
  });
  if (!demand.outside_launch_area) {
    await openItem(tx, {
      section: 'deals_follow_up',
      subjectType: 'deal',
      subjectId: deal.id,
      subjectCode: deal.code,
      demandId: demand.id,
      offerId: offer.id,
      assignee: await resolveAssignee(tx, 'demand', demand.owner_user_id),
      reason: 'follow_up',
      reasonRef: deal.code,
      dueAt: followUpDue(body.followUpDate),
    });
  }
  await tx.events.emit('deal.opened.v1', { type: 'deal', id: deal.id }, { dealId: deal.id, code: deal.code, demandId: demand.id, offerId: offer.id });
  await dealUpdated(tx, deal);
  await rederiveOffer(tx, offer.id);
  await rederiveDemand(tx, demand.id);
  return dealView(tx, deal);
}

export interface DealPatch {
  stage?: 'Negotiation' | 'Documentation' | 'Stamp duty & registration' | 'Closed';
  agreedTerms?: Record<string, unknown>;
  nextAction?: string;
  followUpDate?: string;
  closingPriceInr?: number;
  closedAt?: string;
}

export async function updateDeal(tx: Tx, caller: Caller, idOrCode: string, patch: DealPatch, expectedVersion: number | undefined) {
  const deal = await dealByIdOrCode(tx, idOrCode, true);
  if (expectedVersion !== undefined && deal.version !== expectedVersion) throw versionMismatchErr();
  if (!isOpenStage(deal.stage)) throw invalidTransition(`the deal is ${deal.stage}`);
  const to: DealStage = patch.stage ?? deal.stage;
  if (!canMoveStage(deal.stage, to)) throw invalidTransition(`stages move forward only (${deal.stage} → ${to})`);
  const terms = mergeTerms(deal.agreed_terms, patch.agreedTerms);
  if (to === 'Closed') return closeDeal(tx, caller, deal, terms, patch);
  // R13: every change while open carries nextAction + followUpDate
  if (!followUpValid(patch.nextAction, patch.followUpDate, tx.today)) throw followUpErr();
  const updated =
    (await tx.rows.update('deals', deal.id, {
      stage: to,
      agreed_terms: terms as Record<string, unknown>,
      next_action: patch.nextAction as string,
      follow_up_date: patch.followUpDate as string,
    })) ?? deal;
  await tx.rows.insert('deal_events', {
    deal_id: deal.id,
    kind: to !== deal.stage ? 'stage' : patch.agreedTerms ? 'terms' : 'follow_up',
    from_stage: deal.stage,
    to_stage: to,
    next_action: patch.nextAction ?? null,
    follow_up_date: patch.followUpDate ?? null,
    at: tx.now,
    by_user: caller.userId,
  });
  for (const item of await tx.q.openItemsOf({ subjectId: deal.id }, 5))
    await tx.rows.update('queue_items', item.id, { due_at: followUpDue(patch.followUpDate as string) });
  await dealUpdated(tx, updated);
  return dealView(tx, updated);
}

/** Close (LLD §4.7): one transaction — deal, offer (single-unit), demand, items, lease renewal, events. */
async function closeDeal(tx: Tx, caller: Caller, deal: DealRow, terms: Terms, patch: DealPatch) {
  const offer = await tx.rows.get('offer_view', deal.offer_id);
  const dealType = offer?.deal_type ?? 'Sale';
  const leaseMonths = typeof terms.leaseMonths === 'number' ? terms.leaseMonths : null;
  if (closingTermsMissing(dealType, patch.closingPriceInr, leaseMonths))
    throw new JourneyError(400, 'closing-terms-required', dealType === 'Lease' ? 'closingPriceInr and agreedTerms.leaseMonths are required' : 'closingPriceInr is required');
  const closedAt = patch.closedAt ? new Date(patch.closedAt) : tx.now;
  const closed =
    (await tx.rows.update('deals', deal.id, {
      stage: 'Closed',
      agreed_terms: terms as Record<string, unknown>,
      closing_price_inr: patch.closingPriceInr as number,
      closed_at: closedAt,
      next_action: patch.nextAction ?? deal.next_action,
      follow_up_date: patch.followUpDate ?? deal.follow_up_date,
    })) ?? deal;
  await tx.rows.insert('deal_events', { deal_id: deal.id, kind: 'stage', from_stage: deal.stage, to_stage: 'Closed', at: tx.now, by_user: caller.userId });

  // offer: Closed for a single unit; a multi-unit project configuration stays live (records reduces the units)
  if (deal.multi_unit) await rederiveOffer(tx, deal.offer_id);
  else {
    await rederiveOffer(tx, deal.offer_id, { set: 'Closed', reason: 'deal_closed' });
    await freezeCurve(tx, 'offer', deal.offer_id);
    await closeItems(tx, { offerId: deal.offer_id }, 'done', 'offer_closed');
  }
  await rederiveDemand(tx, deal.demand_id, { set: 'Closed' });
  await freezeCurve(tx, 'demand', deal.demand_id);
  await closeItems(tx, { demandId: deal.demand_id }, 'done', 'deal_closed');
  const demand = await tx.rows.get('demand_view', deal.demand_id);
  if (demand) await tx.q.adjustGapCells(demandCells(demand), -1, 0, tx.now);

  let renewal: LeaseRenewalRow | undefined;
  const plan = offer ? leaseRenewalPlan(dealType, leaseMonths, typeof terms.leaseStartDate === 'string' ? terms.leaseStartDate : null, istDate(closedAt)) : null;
  if (plan && offer) {
    renewal = await tx.rows.insert('lease_renewals', {
      deal_id: deal.id,
      offer_id: offer.id,
      property_id: offer.property_id,
      lease_start_date: plan.leaseStartDate,
      lease_months: plan.leaseMonths,
      due_on: plan.dueOn,
      available_from: plan.availableFrom,
      status: 'scheduled',
    });
  }
  await notify(tx, offer?.owner_user_id, {
    kind: 'offer_closed',
    title: `${deal.code} closed on ${offer?.code ?? 'the offer'}`,
    subject: { type: 'offer', id: deal.offer_id, code: offer?.code ?? null },
  });
  const unitsBooked = deal.multi_unit ? (typeof terms.unitsBooked === 'number' ? terms.unitsBooked : 1) : undefined;
  await tx.events.emit(
    'deal.closed.v1',
    { type: 'deal', id: deal.id },
    {
      dealId: deal.id,
      demandId: deal.demand_id,
      offerId: deal.offer_id,
      closedAt: closedAt.toISOString(),
      closingPriceInr: patch.closingPriceInr as number,
      dealType,
      ...(leaseMonths ? { leaseMonths } : {}),
      ...(unitsBooked !== undefined ? { unitsBooked } : {}),
    },
  );
  await dealUpdated(tx, closed);
  await audit(tx, 'deal.closed', caller.userId, { type: 'deal', id: deal.id }, { code: deal.code, dealType });
  return dealView(tx, closed, renewal);
}

/** Cancel (compensation, US-25 AC1): the deal is kept; offer and demand re-derived (a closed one is reopened). */
export async function cancelDeal(tx: Tx, caller: Caller, idOrCode: string, body: { reasonCode: string; reason?: string | null }) {
  const deal = await dealByIdOrCode(tx, idOrCode, true);
  if (deal.stage === 'Cancelled') throw invalidTransition('the deal is already cancelled');
  const wasClosed = deal.stage === 'Closed';
  if (wasClosed && caller.role !== 'Admin' && caller.role !== 'Manager')
    throw forbiddenErr('cancelling a Closed deal (token refunded after close) needs Admin or Manager (JA-10)');
  const cancelled =
    (await tx.rows.update('deals', deal.id, {
      stage: 'Cancelled',
      cancelled_at: tx.now,
      cancel_reason_code: body.reasonCode,
      cancel_reason: body.reason ?? null,
    })) ?? deal;
  await tx.rows.insert('deal_events', { deal_id: deal.id, kind: 'cancel', from_stage: deal.stage, to_stage: 'Cancelled', note: null, at: tx.now, by_user: caller.userId });
  await closeItems(tx, { subjectId: deal.id }, 'cancelled', 'deal_cancelled');
  const renewal = await tx.q.leaseRenewalOfDeal(deal.id);
  if (renewal && renewal.status === 'scheduled') await tx.rows.update('lease_renewals', renewal.id, { status: 'cancelled' });
  await tx.events.emit(
    'deal.cancelled.v1',
    { type: 'deal', id: deal.id },
    { dealId: deal.id, demandId: deal.demand_id, offerId: deal.offer_id, reason: body.reasonCode },
  );
  if (wasClosed) {
    const offer = await tx.rows.get('offer_journey', deal.offer_id);
    if (offer?.commercial_status === 'Closed') {
      await unfreezeCurve(tx, 'offer', deal.offer_id);
      await rederiveOffer(tx, deal.offer_id, { reopen: true, reason: 'deal_cancelled' });
    } else await rederiveOffer(tx, deal.offer_id, { reason: 'deal_cancelled' });
    await unfreezeCurve(tx, 'demand', deal.demand_id);
    await rederiveDemand(tx, deal.demand_id, { reopen: true });
    const demand = await tx.rows.get('demand_view', deal.demand_id);
    if (demand) await tx.q.adjustGapCells(demandCells(demand), 1, 0, tx.now);
  } else {
    await rederiveOffer(tx, deal.offer_id, { reason: 'deal_cancelled' });
    await rederiveDemand(tx, deal.demand_id);
  }
  await dealUpdated(tx, cancelled);
  await audit(tx, 'deal.cancelled', caller.userId, { type: 'deal', id: deal.id }, { code: deal.code, reasonCode: body.reasonCode, from: deal.stage });
  return dealView(tx, cancelled);
}

/** Follow-up: logged, the next one set, both life curves confirmed ("follow ups every 2 days reset the life curve"). */
export async function logFollowUp(
  tx: Tx,
  caller: Caller,
  idOrCode: string,
  body: { channel?: 'call' | 'meeting'; note?: string | null; nextAction: string; followUpDate: string },
) {
  const deal = await dealByIdOrCode(tx, idOrCode, true);
  if (!isOpenStage(deal.stage)) throw invalidTransition(`the deal is ${deal.stage}`);
  if (!followUpValid(body.nextAction, body.followUpDate, tx.today)) throw followUpErr();
  const channel = body.channel ?? 'call';
  const updated = (await tx.rows.update('deals', deal.id, { next_action: body.nextAction, follow_up_date: body.followUpDate })) ?? deal;
  await tx.rows.insert('deal_events', {
    deal_id: deal.id,
    kind: 'follow_up',
    note: body.note ?? null,
    next_action: body.nextAction,
    follow_up_date: body.followUpDate,
    at: tx.now,
    by_user: caller.userId,
  });
  for (const item of await tx.q.openItemsOf({ subjectId: deal.id }, 5)) await tx.rows.update('queue_items', item.id, { due_at: followUpDue(body.followUpDate) });
  await confirmSubject(tx, 'demand', deal.demand_id, 'deal_follow_up', 'deal_follow_up');
  await confirmSubject(tx, 'offer', deal.offer_id, 'deal_follow_up', channel);
  await dealUpdated(tx, updated);
  return dealView(tx, updated);
}

export const leaseRenewalView = (r: LeaseRenewalRow) => ({
  id: r.id,
  dealId: r.deal_id,
  offerId: r.offer_id,
  propertyId: r.property_id,
  leaseStartDate: r.lease_start_date,
  leaseMonths: r.lease_months,
  dueOn: r.due_on,
  availableFrom: r.available_from,
  status: r.status,
  emittedAt: r.emitted_at ? r.emitted_at.toISOString() : null,
});
