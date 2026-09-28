// Calls and meetings (C-08, US-12 AC3, A-37; LLD §4.4): outcome effects, the 3-attempt rule, call.logged.v1.
import { applyOutcome, outcomeAllowed, rescheduleDate } from '../domain/calls.js';
import type { CallOutcome } from '../domain/calls.js';
import { confirmSubject } from './curve.js';
import { rederiveDemand, rederiveOffer } from './derive.js';
import { JourneyError, forbiddenErr, notFoundErr, outsideLaunchArea } from './errors.js';
import { reactivateDemandCore } from './demands.js';
import type { CallRow, QueueItemRow } from './model.js';
import { reactivateInactiveOffer, retireOfferCore } from './offers.js';
import type { Tx } from './ports.js';
import { closeItems, moveItem, openItem, resolveAssignee } from './queue-ops.js';
import { weights } from './settings.js';
import { lifeCurveView, primaryItem, queueRef } from './views.js';

export interface CallInput {
  subjectType: 'offer' | 'demand';
  subjectId: string;
  queueItemId?: string | null;
  personId?: string | null;
  channel?: 'call' | 'meeting';
  outcome: CallOutcome;
  availableNow?: boolean | null;
  knownPriceInr?: number | null;
  nextCallDate?: string | null;
  notes?: string | null;
}

export interface Caller {
  userId: string;
  role: string;
}

export const callView = (c: CallRow) => ({
  id: c.id,
  code: c.code,
  subjectType: c.subject_type,
  subjectId: c.subject_id,
  personId: c.person_id,
  queueItemId: c.queue_item_id,
  channel: c.channel,
  outcome: c.outcome,
  attemptNo: c.attempt_no,
  knownPriceInr: c.known_price_inr,
  nextCallDate: c.next_call_date,
  notes: c.notes,
  loggedAt: c.logged_at.toISOString(),
  loggedBy: c.logged_by,
});

async function authorise(tx: Tx, caller: Caller, input: CallInput) {
  const staff = caller.role === 'Admin' || caller.role === 'Manager';
  if (input.subjectType === 'demand') {
    if (!staff && caller.role !== 'Demand agent') throw forbiddenErr('demand calls: Admin, Manager, Demand agent');
    return;
  }
  if (staff || caller.role === 'Supply agent') return;
  // A Demand agent may call an offer sourced for a demand they own (contract x-role-rules).
  const offer = await tx.rows.get('offer_view', input.subjectId);
  const demand = offer?.sourced_for_demand_id ? await tx.rows.get('demand_view', offer.sourced_for_demand_id) : undefined;
  if (!demand || demand.owner_user_id !== caller.userId) throw forbiddenErr('offer calls: Admin, Manager, Supply agent');
}

export async function logCall(tx: Tx, caller: Caller, input: CallInput) {
  if (!outcomeAllowed(input.subjectType, input.outcome))
    throw new JourneyError(400, 'outcome-not-allowed', 'already_gone / unwilling apply to offers only; exit the demand instead');
  const view =
    input.subjectType === 'offer' ? await tx.rows.get('offer_view', input.subjectId) : await tx.rows.get('demand_view', input.subjectId);
  if (!view) throw notFoundErr(input.subjectType);
  await authorise(tx, caller, input);
  if (view.outside_launch_area) throw outsideLaunchArea();

  const open = await tx.q.openItemsOf({ subjectId: input.subjectId }, 50);
  let item: QueueItemRow | undefined;
  if (input.queueItemId) {
    item = open.find((i) => i.id === input.queueItemId);
    if (!item) {
      const any = await tx.rows.get('queue_items', input.queueItemId);
      if (!any || (any.subject_id !== input.subjectId && any.offer_id !== input.subjectId && any.demand_id !== input.subjectId))
        throw new JourneyError(400, 'validation-failed', 'queueItemId does not belong to the subject');
    }
  } else item = primaryItem(open, input.subjectId);

  const person = input.personId ? await tx.rows.get('person_state', input.personId, { forUpdate: true }) : undefined;
  const w = (await weights(tx)).value;
  const attempts = applyOutcome(
    { itemAttempts: item?.attempts ?? 0, personConsecutive: input.personId ? (person?.consecutive_no_answer ?? 0) : null },
    input.outcome,
    w.maxAttempts,
  );
  const channel = input.channel ?? 'call';
  const nextCall = input.outcome === 'no_answer' ? rescheduleDate(input.nextCallDate, tx.today) : (input.nextCallDate ?? null);
  const call = await tx.rows.insert('calls', {
    code: await tx.q.nextCode('CALL'),
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    person_id: input.personId ?? null,
    queue_item_id: item?.id ?? input.queueItemId ?? null,
    channel,
    outcome: input.outcome,
    attempt_no: attempts.attemptNo,
    known_price_inr: input.knownPriceInr ?? null,
    next_call_date: nextCall,
    notes: input.notes ?? null,
    logged_by: caller.userId,
    logged_at: tx.now,
  });

  if (input.personId) {
    const patch = {
      consecutive_no_answer: attempts.personConsecutive ?? 0,
      last_call_at: tx.now,
      ...(attempts.unreachable ? { unreachable_at: tx.now } : {}),
    };
    if (person) await tx.rows.update('person_state', input.personId, patch);
    else await tx.rows.insert('person_state', { id: input.personId, flags: [], flag_version: 0, ...patch });
  }

  const commercialStatus =
    input.subjectType === 'offer'
      ? await offerEffects(tx, caller, input, item, attempts.unreachable, nextCall, channel)
      : await demandEffects(tx, caller, input, item, attempts, nextCall, channel);

  await tx.events.emit(
    'call.logged.v1',
    { type: 'call', id: call.id },
    {
      callId: call.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      ...(input.personId ? { personId: input.personId } : {}),
      outcome: input.outcome,
      attempt: attempts.attemptNo,
      personUnreachable: attempts.unreachable,
      calledBy: caller.userId,
    },
  );

  const curve = await tx.q.curveBySubject(input.subjectType, input.subjectId);
  const next = primaryItem(await tx.q.openItemsOf({ subjectId: input.subjectId }, 50), input.subjectId);
  return {
    call: callView(call),
    lifeCurve: curve ? await lifeCurveView(tx, curve, view.code, view.last_seen_on) : null,
    commercialStatus,
    personUnreachable: attempts.unreachable,
    nextQueueItem: next ? queueRef(next) : null,
  };
}

async function noAnswer(tx: Tx, item: QueueItemRow | undefined, attempts: number, nextCall: string) {
  if (!item) return;
  await tx.rows.update('queue_items', item.id, {
    attempts,
    next_call_date: nextCall,
    // rescheduled: not overdue until the next call date
    ...(item.section !== 'should_call' ? { due_at: new Date(`${nextCall}T10:00:00+05:30`) } : {}),
  });
}

async function offerEffects(
  tx: Tx,
  caller: Caller,
  input: CallInput,
  item: QueueItemRow | undefined,
  unreachable: boolean,
  nextCall: string | null,
  channel: 'call' | 'meeting',
): Promise<string | null> {
  const id = input.subjectId;
  switch (input.outcome) {
    case 'confirmed': {
      await reactivateInactiveOffer(tx, id); // R-12
      if (input.availableNow) {
        const view = await tx.rows.get('offer_view', id);
        if (view?.available_from && view.available_from > tx.today) await tx.rows.update('offer_view', id, { available_from: tx.today });
        const curve = await tx.q.curveBySubject('offer', id);
        if (curve?.clock_starts_on) await tx.rows.update('life_curve', curve.id, { clock_starts_on: null });
      }
      await confirmSubject(tx, 'offer', id, channel, channel);
      // A call logged on the offer answers its Must call and Should call items.
      await closeItems(tx, { subjectId: id, sections: ['must_call', 'should_call'] }, 'done', 'called');
      return (await rederiveOffer(tx, id, input.availableNow ? { reason: 'available_now' } : {}))?.commercial_status ?? null;
    }
    case 'no_answer': {
      if (unreachable) {
        if (item) await closeItems(tx, { ids: [item.id] }, 'done', 'unreachable');
      } else await noAnswer(tx, item, (item?.attempts ?? 0) + 1, nextCall as string);
      return (await tx.rows.get('offer_journey', id))?.commercial_status ?? null;
    }
    case 'already_gone':
    case 'unwilling':
      return (await retireOfferCore(tx, id, input.outcome, input.knownPriceInr, caller.userId)).commercial_status;
  }
}

async function demandEffects(
  tx: Tx,
  caller: Caller,
  input: CallInput,
  item: QueueItemRow | undefined,
  attempts: { itemAttempts: number; unreachable: boolean },
  nextCall: string | null,
  channel: 'call' | 'meeting',
): Promise<string | null> {
  const id = input.subjectId;
  const dj = await tx.rows.get('demand_journey', id, { forUpdate: true });
  if (!dj) throw notFoundErr('demand journey');
  if (input.outcome === 'confirmed') {
    if (dj.exit_type === 'Dormant') {
      await reactivateDemandCore(tx, caller, id); // a confirmed call on a Dormant demand reactivates it
    } else {
      if (dj.exit_type || dj.commercial_status === 'Closed') return dj.commercial_status;
      await confirmSubject(tx, 'demand', id, channel, channel);
    }
    const fresh = await tx.rows.get('demand_journey', id);
    if (fresh && !fresh.first_contacted_at) {
      await tx.rows.update('demand_journey', id, { first_contacted_at: tx.now, unreachable: false });
      await closeItems(tx, { subjectId: id, sections: ['to_contact'] }, 'done', 'contacted');
      const view = await tx.rows.get('demand_view', id);
      if (view && !fresh.qualified_at) {
        await openItem(tx, {
          section: 'to_qualify',
          subjectType: 'demand',
          subjectId: id,
          subjectCode: view.code,
          demandId: id,
          assignee: await resolveAssignee(tx, 'demand', view.owner_user_id),
          reason: 'qualify',
          dueAt: tx.now,
        });
      }
    } else if (item && item.section === 'to_contact') {
      await closeItems(tx, { ids: [item.id] }, 'done', 'contacted');
    }
    return (await rederiveDemand(tx, id))?.commercial_status ?? null;
  }
  // no_answer: 3rd consecutive → unreachable, the item moves to to_contact (reason unreachable); no automatic exit (JA-5).
  if (attempts.unreachable) {
    await tx.rows.update('demand_journey', id, { unreachable: true });
    const view = await tx.rows.get('demand_view', id);
    if (item && item.section !== 'to_contact') await closeItems(tx, { ids: [item.id] }, 'done', 'unreachable');
    const target = await openItem(tx, {
      section: 'to_contact',
      subjectType: 'demand',
      subjectId: id,
      subjectCode: view?.code ?? null,
      demandId: id,
      assignee: item?.assignee_user_id ?? (await resolveAssignee(tx, 'demand', view?.owner_user_id)),
      reason: 'unreachable',
      dueAt: tx.now,
    });
    await tx.rows.update('queue_items', target.id, { reason: 'unreachable', attempts: attempts.itemAttempts, next_call_date: null });
    if (item && target.assignee_user_id !== item.assignee_user_id) await moveItem(tx, target, item.assignee_user_id);
  } else await noAnswer(tx, item, attempts.itemAttempts, nextCall as string);
  return dj.commercial_status;
}
