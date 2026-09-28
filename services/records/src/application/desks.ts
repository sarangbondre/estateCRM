// Desks (REC-11, US-36, D-14): Business, Capital, Equipment/Archive and Watchlist items; Network = people with a
// participant role (read-only here). Managers assign, archive and annotate items.
import { RecordsError, notFound } from '../domain/errors.js';
import type { Actor, App } from './context.js';
import { agg } from './emit.js';
import { changedColumns, mergeEdited } from './fields.js';
import { findByIdOrCode } from './lookup.js';
import type { DeskItemRow } from './model.js';
import type { Dto } from './supply.js';

export type DeskLookup = { kind: 'item'; item: DeskItemRow } | { kind: 'network'; personId: string };

export async function findDeskItem(app: App, actor: Actor, idOrCode: string): Promise<DeskLookup> {
  return app.uow.run(actor, async (tx) => {
    const item = await findByIdOrCode(tx, 'desk_items', idOrCode);
    if (item && item.status === 'active') return { kind: 'item', item };
    const person = await findByIdOrCode(tx, 'persons', idOrCode);
    if (person?.participant_role) return { kind: 'network', personId: person.id };
    throw notFound('desk item');
  });
}

export async function patchDeskItem(
  app: App,
  actor: Actor,
  idOrCode: string,
  patch: { assigneeUserId?: string | null | undefined; archived?: boolean | undefined; note?: string | undefined; deadlineDate?: string | null | undefined },
  ifMatch: number | undefined,
): Promise<DeskItemRow> {
  const found = await findDeskItem(app, actor, idOrCode);
  if (found.kind === 'network') throw new RecordsError('desk-item-not-editable', 'network entries are people: edit the person');
  return app.uow.run(actor, async (tx) => {
    const item = await tx.store.get('desk_items', found.item.id, { lock: true });
    if (!item) throw notFound('desk item');
    if (ifMatch !== undefined && ifMatch !== item.version) throw new RecordsError('version-mismatch');
    const next: Partial<DeskItemRow> = {};
    if (patch.assigneeUserId !== undefined) next.assignee_user_id = patch.assigneeUserId;
    if (patch.archived !== undefined) next.archived_at = patch.archived ? (item.archived_at ?? tx.now) : null;
    if (patch.note !== undefined) next.note = patch.note.trim() || null;
    if (patch.deadlineDate !== undefined) next.deadline_date = patch.deadlineDate;
    const changed = changedColumns(item as unknown as Dto, next as Dto);
    if (!changed.length) return item;
    const version = item.version + 1;
    await tx.store.update('desk_items', item.id, { ...next, staff_edited_fields: mergeEdited(item.staff_edited_fields, changed), version });
    const archived = (next.archived_at !== undefined ? next.archived_at : item.archived_at) !== null;
    const assignee = next.assignee_user_id !== undefined ? next.assignee_user_id : item.assignee_user_id;
    await tx.events.emit('desk_item.updated.v1', agg('desk_item', item.id, version), {
      deskItemId: item.id,
      status: archived ? 'archived' : assignee ? 'assigned' : 'open',
      ...(assignee ? { assigneeUserId: assignee } : {}),
    });
    return (await tx.store.get('desk_items', item.id))!;
  });
}
