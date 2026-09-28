// One database transaction per use-case step: users, invitations, the audit chain, notifications and the outbox
// (user.changed.v1) commit together (CLAUDE.md §3.4).
import { tenantScope, withTransaction } from '@11e/db';
import type { Kysely, Transaction } from '@11e/db';
import { writeEvent } from '@11e/outbox';
import { eventTrace } from '@11e/observability';
import type {
  Invitation,
  NotificationRecord,
  Tx,
  UnitOfWork,
  UserChangedEvent,
} from '../../application/ports';
import type { User } from '../../domain/users';
import { appendAudit } from './audit';
import type { WebDb } from './schema';
import { countActiveAdmins, getUser, pendingInvitation, toInvitation, updateUser, userRow } from './users';

export async function insertNotification(
  trx: Kysely<WebDb> | Transaction<WebDb>,
  n: NotificationRecord,
): Promise<boolean> {
  const r = await trx
    .insertInto('notification')
    .values({
      tenant_id: n.tenantId,
      id: n.id,
      user_id: n.userId,
      kind: n.kind,
      subject_type: n.subjectType,
      subject_id: n.subjectId,
      subject_code: n.subjectCode,
      title: n.title,
      link: n.link,
      source_event_id: n.sourceEventId,
      created_at: n.createdAt,
      read_at: n.readAt,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'source_event_id']).where('source_event_id', 'is not', null).doNothing(),
    )
    .executeTakeFirst();
  return Number(r.numInsertedOrUpdatedRows ?? 0) === 1;
}

export async function writeUserChanged(trx: Transaction<WebDb>, e: UserChangedEvent): Promise<void> {
  await writeEvent(trx, {
    eventType: 'user.changed.v1',
    tenantId: e.tenantId,
    aggregateType: 'user',
    aggregateId: e.user.id,
    aggregateVersion: e.user.version,
    data: {
      userId: e.user.id,
      role: e.user.role,
      active: e.user.status === 'active',
      displayName: e.user.displayName,
    },
    correlationId: e.correlationId,
    producer: 'web',
    ...eventTrace(),
  });
}

export function txRepos(trx: Transaction<WebDb>): Tx {
  return {
    users: {
      insert: async (u: User & { emailHash: string }) => {
        await tenantScope(trx, u.tenantId)
          .insertInto('users', userRow(u, Buffer.from(u.emailHash, 'hex')))
          .execute();
      },
      update: (u, expected) => updateUser(trx, u, expected),
      get: (tenantId, id) => getUser(trx, tenantId, id),
      countActiveAdmins: (tenantId) => countActiveAdmins(trx, tenantId),
    },
    invitations: {
      insert: async (inv: Invitation) => {
        await tenantScope(trx, inv.tenantId)
          .insertInto('invitation', {
            id: inv.id,
            user_id: inv.userId,
            email_hash: Buffer.from(inv.emailHash, 'hex'),
            role: inv.role,
            is_data_operator: inv.isDataOperator,
            status: inv.status,
            invited_by: inv.invitedBy,
            expires_at: inv.expiresAt,
            accepted_at: inv.acceptedAt,
          })
          .execute();
      },
      pendingForUser: (tenantId, userId) => pendingInvitation(trx, tenantId, userId),
      setStatus: async (tenantId, id, status, at) => {
        await tenantScope(trx, tenantId)
          .updateTable('invitation')
          .set({ status, updated_at: at, ...(status === 'accepted' ? { accepted_at: at } : {}) })
          .where('id', '=', id)
          .execute();
      },
      listExpired: async (now, limit) => {
        const rows = await trx
          .selectFrom('invitation')
          .selectAll()
          .where('status', '=', 'pending')
          .where('expires_at', '<', now)
          .orderBy('expires_at')
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .execute();
        return rows.map(toInvitation);
      },
    },
    audit: { append: (e) => appendAudit(trx, e) },
    outbox: { userChanged: (e) => writeUserChanged(trx, e) },
    notifications: { insert: (n) => insertNotification(trx, n) },
  };
}

export class DbUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Kysely<WebDb>) {}
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction(this.db, (trx) => fn(txRepos(trx)));
  }
}
