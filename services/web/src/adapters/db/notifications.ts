// notification repository (web LLD §3, §4.7): list + cursor, unread count (capped), mark read, 90-day prune.
import { sql, tenantScope } from '@11e/db';
import type { Kysely, Selectable } from '@11e/db';
import type { NotificationKind, NotificationRecord, NotificationRepo } from '../../application/ports';
import type { NotificationTable, WebDb } from './schema';

const toRecord = (r: Selectable<NotificationTable>): NotificationRecord => ({
  tenantId: r.tenant_id,
  id: r.id,
  userId: r.user_id,
  kind: r.kind as NotificationKind,
  subjectType: r.subject_type as NotificationRecord['subjectType'],
  subjectId: r.subject_id,
  subjectCode: r.subject_code,
  title: r.title,
  link: r.link,
  sourceEventId: r.source_event_id,
  createdAt: r.created_at,
  readAt: r.read_at,
});

export class DbNotificationRepo implements NotificationRepo {
  constructor(private readonly db: Kysely<WebDb>) {}

  async list(
    tenantId: string,
    userId: string,
    q: { unreadOnly: boolean; limit: number; after?: { createdAt: Date; id: string } },
  ): Promise<NotificationRecord[]> {
    let query = tenantScope(this.db, tenantId).selectFrom('notification').selectAll().where('user_id', '=', userId);
    if (q.unreadOnly) query = query.where('read_at', 'is', null);
    if (q.after) query = query.where(sql<boolean>`(created_at, id) < (${q.after.createdAt}, ${q.after.id}::uuid)`);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit).execute();
    return (rows as Selectable<NotificationTable>[]).map(toRecord);
  }

  async unreadCount(tenantId: string, userId: string, cap: number): Promise<number> {
    // Bounded: counts at most `cap` rows through the partial unread index.
    const r = await sql<{ n: string }>`
      select count(*) as n from (
        select 1 from web.notification
         where tenant_id = ${tenantId} and user_id = ${userId} and read_at is null
         limit ${cap}
      ) t`.execute(this.db);
    return Number(r.rows[0]?.n ?? 0);
  }

  async markRead(tenantId: string, userId: string, sel: { ids?: string[]; upTo?: Date }, at: Date): Promise<number> {
    let q = tenantScope(this.db, tenantId)
      .updateTable('notification')
      .set({ read_at: at, updated_at: at })
      .where('user_id', '=', userId)
      .where('read_at', 'is', null);
    if (sel.ids?.length && sel.upTo) {
      const { ids, upTo } = sel;
      q = q.where((eb) => eb.or([eb('id', 'in', ids), eb('created_at', '<=', upTo)]));
    } else if (sel.ids?.length) q = q.where('id', 'in', sel.ids);
    else if (sel.upTo) q = q.where('created_at', '<=', sel.upTo);
    else return 0;
    const r = await q.executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  async prune(before: Date, limit: number): Promise<number> {
    const r = await sql<{ id: string }>`
      delete from web.notification n using (
        select tenant_id, id from web.notification where created_at < ${before} limit ${limit}
      ) d where n.tenant_id = d.tenant_id and n.id = d.id returning n.id`.execute(this.db);
    return r.rows.length;
  }
}
