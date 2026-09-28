// users + invitation repositories (web LLD §3). Every business query is tenant-scoped (tenantScope); the sign-in
// lookup by id uses the documented UNIQUE (id) exception.
import { sql, tenantScope } from '@11e/db';
import type { Kysely, Selectable, Transaction } from '@11e/db';
import type { Invitation, UserListQuery, UserRepo } from '../../application/ports';
import type { RoleCode } from '../../domain/roles';
import type { User, UserStatus } from '../../domain/users';
import type { InvitationTable, UsersTable, WebDb } from './schema';

type Db = Kysely<WebDb> | Transaction<WebDb>;

export function toUser(r: Selectable<UsersTable>): User {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role as RoleCode,
    isDataOperator: r.is_data_operator,
    status: r.status as UserStatus,
    invitedBy: r.invited_by,
    invitedAt: r.invited_at,
    activatedAt: r.activated_at,
    deactivatedAt: r.deactivated_at,
    lastSeenAt: r.last_seen_at,
    version: r.version,
  };
}

export function toInvitation(r: Selectable<InvitationTable>): Invitation {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    userId: r.user_id,
    emailHash: r.email_hash.toString('hex'),
    role: r.role as RoleCode,
    isDataOperator: r.is_data_operator,
    status: r.status as Invitation['status'],
    invitedBy: r.invited_by,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
  };
}

export class DbUserRepo implements UserRepo {
  constructor(private readonly db: Kysely<WebDb>) {}

  async findById(id: string): Promise<User | undefined> {
    const r = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toUser(r) : undefined;
  }

  get(tenantId: string, id: string) {
    return getUser(this.db, tenantId, id);
  }

  async findByEmailHash(tenantId: string, emailHash: string): Promise<User | undefined> {
    const r = await tenantScope(this.db, tenantId)
      .selectFrom('users')
      .selectAll()
      .where('email_hash', '=', Buffer.from(emailHash, 'hex'))
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return r ? toUser(r as Selectable<UsersTable>) : undefined;
  }

  async list(tenantId: string, q: UserListQuery): Promise<User[]> {
    let query = tenantScope(this.db, tenantId).selectFrom('users').selectAll();
    if (q.role) query = query.where('role', '=', q.role);
    if (q.status) query = query.where('status', '=', q.status);
    if (q.after) {
      const { displayName, id } = q.after;
      query = query.where(sql<boolean>`(display_name, id) > (${displayName}, ${id}::uuid)`);
    }
    const rows = await query.orderBy('display_name').orderBy('id').limit(q.limit).execute();
    return (rows as Selectable<UsersTable>[]).map(toUser);
  }

  countActiveAdmins(tenantId: string) {
    return countActiveAdmins(this.db, tenantId);
  }

  async touchLastSeen(tenantId: string, id: string, at: Date): Promise<void> {
    await tenantScope(this.db, tenantId)
      .updateTable('users')
      .set({ last_seen_at: at })
      .where('id', '=', id)
      .execute();
  }

  async getMany(tenantId: string, ids: string[]): Promise<User[]> {
    if (!ids.length) return [];
    const rows = await tenantScope(this.db, tenantId)
      .selectFrom('users')
      .selectAll()
      .where('id', 'in', ids.slice(0, 100))
      .execute();
    return (rows as Selectable<UsersTable>[]).map(toUser);
  }

  async listIdle(before: Date, limit: number): Promise<User[]> {
    const rows = await this.db
      .selectFrom('users')
      .selectAll()
      .where('status', '=', 'active')
      .where('last_seen_at', '<', before)
      .orderBy('last_seen_at')
      .limit(limit)
      .execute();
    return rows.map(toUser);
  }
}

export async function getUser(db: Db, tenantId: string, id: string): Promise<User | undefined> {
  const r = await tenantScope(db, tenantId)
    .selectFrom('users')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return r ? toUser(r as Selectable<UsersTable>) : undefined;
}

export async function countActiveAdmins(db: Db, tenantId: string): Promise<number> {
  const r = await tenantScope(db, tenantId)
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('role', '=', 'Admin')
    .where('status', '=', 'active')
    .executeTakeFirst();
  return Number((r as { n?: string } | undefined)?.n ?? 0);
}

export function userRow(u: User, emailHash: Buffer) {
  return {
    id: u.id,
    email: u.email,
    email_hash: emailHash,
    display_name: u.displayName,
    role: u.role,
    is_data_operator: u.isDataOperator,
    status: u.status,
    invited_by: u.invitedBy,
    invited_at: u.invitedAt,
    activated_at: u.activatedAt,
    deactivated_at: u.deactivatedAt,
    last_seen_at: u.lastSeenAt,
    version: u.version,
  };
}

export async function updateUser(db: Db, u: User, expectedVersion: number): Promise<boolean> {
  const r = await tenantScope(db, u.tenantId)
    .updateTable('users')
    .set({
      display_name: u.displayName,
      role: u.role,
      is_data_operator: u.isDataOperator,
      status: u.status,
      activated_at: u.activatedAt,
      deactivated_at: u.deactivatedAt,
      last_seen_at: u.lastSeenAt,
      version: u.version,
      updated_at: new Date(),
    })
    .where('id', '=', u.id)
    .where('version', '=', expectedVersion)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

export async function pendingInvitation(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<Invitation | undefined> {
  const r = await tenantScope(db, tenantId)
    .selectFrom('invitation')
    .selectAll()
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return r ? toInvitation(r as Selectable<InvitationTable>) : undefined;
}
