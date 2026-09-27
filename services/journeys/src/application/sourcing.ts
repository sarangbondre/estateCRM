// Sourcing requests (C-11, US-22; LLD §4.5): raised by the demand team, worked by the supply team.
import { rederiveDemand } from './derive.js';
import { JourneyError, invalidTransition, notFoundErr, notOwnerErr, outsideLaunchArea, versionMismatchErr } from './errors.js';
import { SRQ_EVENT_STATUS } from './exits.js';
import type { SourcingRequestRow, SrqStatus } from './model.js';
import { notify } from './notify.js';
import type { Tx } from './ports.js';
import { closeItems, moveItem, openItem } from './queue-ops.js';
import { demandByIdOrCode, isUuid } from './views.js';

export interface Caller {
  userId: string;
  role: string;
}

export async function srqView(tx: Tx, s: SourcingRequestRow) {
  const demand = await tx.rows.get('demand_view', s.demand_id);
  return {
    id: s.id,
    code: s.code,
    demandId: s.demand_id,
    ...(demand ? { demandCode: demand.code } : {}),
    requestedBy: s.requested_by,
    assigneeUserId: s.assignee_user_id,
    dueDate: s.due_date,
    priority: s.priority,
    status: s.status,
    postAnonymously: s.post_anonymously,
    offerIds: s.offer_ids.slice(0, 100),
    notes: s.notes,
    createdAt: s.created_at.toISOString(),
    closedAt: s.closed_at ? s.closed_at.toISOString() : null,
    version: s.version,
  };
}

const dueAt = (date: string) => new Date(`${date}T18:00:00+05:30`);

export interface SrqCreate {
  demandId: string;
  assigneeUserId: string;
  dueDate: string;
  priority: 'High' | 'Normal' | 'Low';
  postAnonymously?: boolean;
  notes?: string | null;
}

export async function createSourcingRequest(tx: Tx, caller: Caller, body: SrqCreate) {
  const demand = await tx.rows.get('demand_view', body.demandId);
  if (!demand) throw notFoundErr('demand');
  const dj = await tx.rows.get('demand_journey', demand.id, { forUpdate: true });
  if (!dj) throw notFoundErr('demand journey');
  if (demand.outside_launch_area) throw outsideLaunchArea();
  if (!dj.qualified_at || dj.exit_type || dj.commercial_status === 'Closed' || demand.voided)
    throw invalidTransition('a sourcing request needs a qualified, live demand');
  if (body.dueDate < tx.today) throw new JourneyError(400, 'validation-failed', 'dueDate must not be in the past');
  const srq = await tx.rows.insert('sourcing_requests', {
    code: await tx.q.nextCode('SRQ'),
    demand_id: demand.id,
    requested_by: caller.userId,
    assignee_user_id: body.assigneeUserId,
    due_date: body.dueDate,
    priority: body.priority,
    status: 'Open',
    post_anonymously: body.postAnonymously ?? false,
    notes: body.notes ?? null,
  });
  const priority = body.priority === 'High' ? 1 : 0;
  await openItem(tx, {
    section: 'sourcing_requests',
    subjectType: 'sourcing_request',
    subjectId: srq.id,
    subjectCode: srq.code,
    demandId: demand.id,
    assignee: body.assigneeUserId,
    reason: 'srq',
    reasonRef: demand.code,
    priority,
    dueAt: dueAt(body.dueDate),
  });
  await openItem(tx, {
    section: 'sourcing_requests_open',
    subjectType: 'sourcing_request',
    subjectId: srq.id,
    subjectCode: srq.code,
    demandId: demand.id,
    assignee: caller.userId,
    reason: 'srq',
    reasonRef: demand.code,
    dueAt: dueAt(body.dueDate),
  });
  await closeItems(tx, { subjectId: demand.id, sections: ['needs_sourcing'] }, 'done', 'srq_raised');
  await notify(tx, body.assigneeUserId, {
    kind: 'srq_assigned',
    title: `Sourcing request ${srq.code} for ${demand.code} (due ${body.dueDate})`,
    subject: { type: 'sourcing_request', id: srq.id, code: srq.code },
  });
  await tx.events.emit(
    'sourcing_request.created.v1',
    { type: 'sourcing_request', id: srq.id },
    {
      sourcingRequestId: srq.id,
      code: srq.code,
      demandId: demand.id,
      assigneeUserId: srq.assignee_user_id,
      dueDate: srq.due_date,
      priority: srq.priority,
    },
  );
  await tx.events.emit(
    'demand.sourcing_started.v1',
    { type: 'demand', id: demand.id },
    { demandId: demand.id, postAnonymously: srq.post_anonymously, sourcingRequestId: srq.id },
  );
  await rederiveDemand(tx, demand.id);
  return srqView(tx, srq);
}

export async function srqByIdOrCode(tx: Tx, idOrCode: string, forUpdate = false): Promise<SourcingRequestRow> {
  const s = isUuid(idOrCode) ? await tx.rows.get('sourcing_requests', idOrCode, { forUpdate }) : await tx.rows.byCode('sourcing_requests', idOrCode);
  if (!s) throw notFoundErr('sourcing request');
  return s;
}

export interface SrqPatch {
  assigneeUserId?: string;
  dueDate?: string;
  priority?: 'High' | 'Normal' | 'Low';
  status?: 'In progress' | 'Fulfilled' | 'Cancelled';
  notes?: string | null;
}

const OPEN: readonly SrqStatus[] = ['Open', 'In progress'];

export async function updateSourcingRequest(tx: Tx, caller: Caller, idOrCode: string, patch: SrqPatch, expectedVersion: number | undefined) {
  const srq = await srqByIdOrCode(tx, idOrCode, true);
  if (expectedVersion !== undefined && srq.version !== expectedVersion) throw versionMismatchErr();
  const privileged = caller.role === 'Admin' || caller.role === 'Manager' || (caller.role === 'Demand agent' && caller.userId === srq.requested_by);
  if (!privileged) {
    const onlyStatus = Object.keys(patch).every((k) => k === 'status');
    if (caller.userId !== srq.assignee_user_id || !onlyStatus || patch.status === 'Cancelled')
      throw notOwnerErr('the assignee may only set the status (In progress / Fulfilled); the requester, Admin or Manager can change the rest');
  }
  if (!OPEN.includes(srq.status)) throw invalidTransition(`the sourcing request is ${srq.status}`);
  if (patch.status === 'In progress' && srq.status === 'In progress') delete patch.status;

  const next: Partial<SourcingRequestRow> = {};
  if (patch.assigneeUserId !== undefined) next.assignee_user_id = patch.assigneeUserId;
  if (patch.dueDate !== undefined) next.due_date = patch.dueDate;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.status) {
    next.status = patch.status;
    if (patch.status !== 'In progress') next.closed_at = tx.now;
  }
  const updated = (await tx.rows.update('sourcing_requests', srq.id, next)) ?? srq;

  if (patch.status === 'Fulfilled' || patch.status === 'Cancelled') {
    await closeItems(tx, { subjectId: srq.id }, patch.status === 'Fulfilled' ? 'done' : 'cancelled', `srq_${patch.status.toLowerCase()}`);
    if (patch.status === 'Fulfilled') {
      await notify(tx, srq.requested_by, {
        kind: 'srq_fulfilled',
        title: `${srq.code} fulfilled (${updated.offer_ids.length} offers)`,
        subject: { type: 'sourcing_request', id: srq.id, code: srq.code },
      });
    }
  } else {
    for (const item of await tx.q.openItemsOf({ subjectId: srq.id }, 10)) {
      if (patch.dueDate !== undefined) await tx.rows.update('queue_items', item.id, { due_at: dueAt(patch.dueDate) });
      if (patch.priority !== undefined && item.section === 'sourcing_requests')
        await tx.rows.update('queue_items', item.id, { priority: patch.priority === 'High' ? 1 : 0 });
      if (patch.assigneeUserId && item.section === 'sourcing_requests') await moveItem(tx, item, patch.assigneeUserId);
    }
    if (patch.assigneeUserId && patch.assigneeUserId !== srq.assignee_user_id) {
      await notify(tx, patch.assigneeUserId, {
        kind: 'srq_assigned',
        title: `Sourcing request ${srq.code} assigned to you`,
        subject: { type: 'sourcing_request', id: srq.id, code: srq.code },
      });
    }
  }
  if (patch.status) {
    await tx.events.emit(
      'sourcing_request.updated.v1',
      { type: 'sourcing_request', id: srq.id },
      { sourcingRequestId: srq.id, status: SRQ_EVENT_STATUS[patch.status] },
    );
    await rederiveDemand(tx, srq.demand_id);
  }
  return srqView(tx, updated);
}

export { demandByIdOrCode };
