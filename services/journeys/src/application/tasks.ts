// Work notifications (FR-NTF-1, R-6) and Watchlist follow-up tasks (D-14, US-36 AC2; LLD §4.8, §4.9).
import { JourneyError, invalidTransition, notFoundErr, versionMismatchErr } from './errors.js';
import type { NotificationRow, WatchlistTaskRow } from './model.js';
import { notify } from './notify.js';
import type { Tx } from './ports.js';
import { closeItems, moveItem } from './queue-ops.js';

export const notificationView = (n: NotificationRow) => ({
  id: n.id,
  kind: n.kind as 'enquiry',
  title: n.title,
  body: n.body,
  subjectType: n.subject_type,
  subjectId: n.subject_id,
  subjectCode: n.subject_code,
  createdAt: n.created_at.toISOString(),
  readAt: n.read_at ? n.read_at.toISOString() : null,
});

export async function markRead(tx: Tx, userId: string, body: { ids?: string[]; upTo?: string | null }) {
  if (!body.ids?.length && !body.upTo) throw new JourneyError(400, 'validation-failed', 'give ids or upTo');
  const marked = await tx.q.markRead(userId, body.ids?.length ? body.ids : null, body.upTo ? new Date(body.upTo) : null, tx.now);
  return { marked };
}

export const watchlistTaskView = (t: WatchlistTaskRow) => ({
  id: t.id,
  watchlistItemId: t.watchlist_item_id,
  ...(t.watchlist_code ? { watchlistCode: t.watchlist_code } : {}),
  ...(t.signal_type ? { signalType: t.signal_type } : {}),
  deadlineDate: t.deadline_date,
  assigneeUserId: t.assignee_user_id,
  dueDate: t.due_date,
  status: t.status,
  outcome: t.outcome,
  completedAt: t.completed_at ? t.completed_at.toISOString() : null,
  completedBy: t.completed_by,
  version: t.version,
});

async function taskFor(tx: Tx, id: string) {
  const t = await tx.rows.get('watchlist_tasks', id, { forUpdate: true });
  if (!t) throw notFoundErr('watchlist task');
  return t;
}

/** Managers assign, reschedule or cancel (PATCH). */
export async function updateWatchlistTask(
  tx: Tx,
  id: string,
  patch: { assigneeUserId?: string; dueDate?: string; status?: 'Cancelled' },
  expectedVersion: number | undefined,
) {
  const t = await taskFor(tx, id);
  if (expectedVersion !== undefined && t.version !== expectedVersion) throw versionMismatchErr();
  if (t.status !== 'Open') throw invalidTransition(`the task is ${t.status}`);
  const next: Partial<WatchlistTaskRow> = {};
  if (patch.assigneeUserId) next.assignee_user_id = patch.assigneeUserId;
  if (patch.dueDate) next.due_date = patch.dueDate;
  if (patch.status === 'Cancelled') {
    next.status = 'Cancelled';
    next.completed_at = tx.now;
  }
  const updated = (await tx.rows.update('watchlist_tasks', t.id, next)) ?? t;
  if (patch.status === 'Cancelled') await closeItems(tx, { subjectId: t.id }, 'cancelled', 'task_cancelled');
  else if (patch.assigneeUserId && patch.assigneeUserId !== t.assignee_user_id) {
    for (const item of await tx.q.openItemsOf({ subjectId: t.id }, 5)) await moveItem(tx, item, patch.assigneeUserId);
    await notify(tx, patch.assigneeUserId, {
      kind: 'watchlist_task',
      title: `Watchlist follow-up ${t.watchlist_code ?? ''} assigned to you`.trim(),
      subject: { type: 'watchlist_task', id: t.id, code: t.watchlist_code },
    });
  }
  return watchlistTaskView(updated);
}

/** Supply agents, Managers and Admins complete a task (watchlist_task.completed.v1). */
export async function completeWatchlistTask(tx: Tx, actor: string, id: string, body: { outcome: string; createdOfferIds?: string[] }) {
  const t = await taskFor(tx, id);
  if (t.status !== 'Open') throw invalidTransition(`the task is ${t.status}`);
  const updated =
    (await tx.rows.update('watchlist_tasks', t.id, { status: 'Done', outcome: body.outcome, completed_at: tx.now, completed_by: actor })) ?? t;
  await closeItems(tx, { subjectId: t.id }, 'done', 'task_done');
  // The outcome is free text (PII possible): it stays in journeys and is not put in the event (conventions §5).
  await tx.events.emit('watchlist_task.completed.v1', { type: 'watchlist_task', id: t.id }, { taskId: t.id, watchlistItemId: t.watchlist_item_id });
  return watchlistTaskView(updated);
}
