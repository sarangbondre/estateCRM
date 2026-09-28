// Users, roles and invitations (US-34, web LLD §4.8): invite (Supabase invite + users/invitation/audit/outbox in one
// transaction, compensation on failure), revoke, role/status changes with the web-own rules, and the directory.

import { WebError } from '../domain/errors';
import { REACTIVATED_TITLE, PROFILE_LINK, roleChangedTitle } from '../domain/notifications';
import type { RoleCode } from '../domain/roles';
import {
  AUDIT_ACTION,
  INVITATION_TTL_MS,
  applyUserPatch,
  assertValidEmail,
  defaultDisplayName,
  normalizeEmail,
} from '../domain/users';
import type { User, UserPatch, UserStatus } from '../domain/users';
import type { AuthProvider, Clock, EmailHasher, UnitOfWork, UserRepo } from './ports';
import type { StaffContext } from './sessions';

export interface UserView {
  userId: string;
  displayName: string;
  email?: string | null;
  role: RoleCode;
  isDataOperator?: boolean;
  status: UserStatus;
  invitedAt?: string | null;
  invitedBy?: string | null;
  invitationExpiresAt?: string | null;
  activatedAt?: string | null;
  deactivatedAt?: string | null;
  lastSeenAt?: string | null;
  version?: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Admins see e-mail and audit fields; everyone else gets the directory view for pickers. */
export function userView(u: User, admin: boolean, invitationExpiresAt: Date | null = null): UserView {
  if (!admin) return { userId: u.id, displayName: u.displayName, role: u.role, status: u.status };
  return {
    userId: u.id,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    isDataOperator: u.isDataOperator,
    status: u.status,
    invitedAt: iso(u.invitedAt),
    invitedBy: u.invitedBy,
    invitationExpiresAt: iso(invitationExpiresAt),
    activatedAt: iso(u.activatedAt),
    deactivatedAt: iso(u.deactivatedAt),
    lastSeenAt: iso(u.lastSeenAt),
    version: u.version,
  };
}

export interface UserDeps {
  users: UserRepo;
  uow: UnitOfWork;
  auth: AuthProvider;
  clock: Clock;
  hasher: EmailHasher;
  /** Called after a change commits: drop cached users and service tokens on this instance. */
  onUserChanged: (userId: string) => void;
}

export interface InviteInput {
  email: string;
  displayName?: string;
  role: RoleCode;
  isDataOperator?: boolean;
}

export class Users {
  constructor(private readonly d: UserDeps) {}

  async list(ctx: StaffContext, q: { role?: RoleCode; status?: UserStatus; limit: number; after?: { displayName: string; id: string } }) {
    const rows = await this.d.users.list(ctx.tenantId, q);
    return rows;
  }

  async invite(ctx: StaffContext, input: InviteInput, correlationId: string, redirectTo: string): Promise<User> {
    const email = normalizeEmail(input.email);
    assertValidEmail(email);
    const emailHash = this.d.hasher.hash(email);
    const existing = await this.d.users.findByEmailHash(ctx.tenantId, emailHash);
    if (existing && existing.status !== 'deactivated') {
      throw new WebError(existing.status === 'invited' ? 'email-already-invited' : 'user-exists');
    }
    if (existing && existing.activatedAt) throw new WebError('user-exists', 'reactivate the user instead');

    const { userId } = await this.d.auth.inviteUserByEmail(email, redirectTo);
    const now = this.d.clock.now();
    const user: User = {
      tenantId: ctx.tenantId,
      id: userId,
      email,
      displayName: input.displayName?.trim() || defaultDisplayName(email),
      role: input.role,
      isDataOperator: input.isDataOperator ?? false,
      status: 'invited',
      invitedBy: ctx.userId,
      invitedAt: now,
      activatedAt: null,
      deactivatedAt: null,
      lastSeenAt: null,
      version: 1,
    };
    try {
      await this.d.uow.run(async (tx) => {
        await tx.users.insert({ ...user, emailHash });
        await tx.invitations.insert({
          tenantId: ctx.tenantId,
          id: crypto.randomUUID(),
          userId,
          emailHash,
          role: user.role,
          isDataOperator: user.isDataOperator,
          status: 'pending',
          invitedBy: ctx.userId,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
          acceptedAt: null,
        });
        await tx.audit.append({
          tenantId: ctx.tenantId,
          occurredAt: now,
          producer: 'web',
          action: 'user.invited',
          actorUserId: ctx.userId,
          subjectType: 'user',
          subjectId: userId,
          via: 'ui',
          details: { role: user.role, isDataOperator: String(user.isDataOperator) },
          correlationId,
        });
        await tx.outbox.userChanged({ tenantId: ctx.tenantId, user, correlationId });
      });
    } catch (err) {
      // Compensation (LLD §4.8 step 5): nothing stored, so the Supabase user must go too.
      await this.d.auth.deleteUser(userId).catch(() => undefined);
      throw err;
    }
    return user;
  }

  async revokeInvitation(ctx: StaffContext, userId: string, correlationId: string): Promise<void> {
    const now = this.d.clock.now();
    const revoked = await this.d.uow.run(async (tx) => {
      const user = await tx.users.get(ctx.tenantId, userId);
      if (!user) throw new WebError('not-found');
      if (user.status === 'active' || user.activatedAt) throw new WebError('invitation-already-accepted');
      const inv = await tx.invitations.pendingForUser(ctx.tenantId, userId);
      if (!inv && user.status === 'deactivated') return false; // already revoked or expired: idempotent
      if (inv) await tx.invitations.setStatus(ctx.tenantId, inv.id, 'revoked', now);
      const next: User = { ...user, status: 'deactivated', deactivatedAt: now, version: user.version + 1 };
      if (!(await tx.users.update(next, user.version))) throw new WebError('version-mismatch');
      await tx.audit.append({
        tenantId: ctx.tenantId,
        occurredAt: now,
        producer: 'web',
        action: 'user.invitation_revoked',
        actorUserId: ctx.userId,
        subjectType: 'user',
        subjectId: userId,
        via: 'ui',
        correlationId,
      });
      await tx.outbox.userChanged({ tenantId: ctx.tenantId, user: next, correlationId });
      return true;
    });
    if (revoked) {
      this.d.onUserChanged(userId);
      await this.d.auth.deleteUser(userId).catch(() => undefined); // the invite link stops working
    }
  }

  async update(
    ctx: StaffContext,
    userId: string,
    patch: UserPatch,
    ifMatch: number | undefined,
    correlationId: string,
  ): Promise<User> {
    const now = this.d.clock.now();
    const result = await this.d.uow.run(async (tx) => {
      const user = await tx.users.get(ctx.tenantId, userId);
      if (!user) throw new WebError('not-found');
      if (ifMatch !== undefined && ifMatch !== user.version) throw new WebError('version-mismatch');
      const admins = await tx.users.countActiveAdmins(ctx.tenantId);
      const { user: next, changes } = applyUserPatch(ctx.userId, user, patch, admins, now);
      if (!changes.length) return { user, changes };
      if (!(await tx.users.update(next, user.version))) throw new WebError('version-mismatch');
      for (const change of changes) {
        const details: Record<string, string> = {};
        if (change === 'role_changed') Object.assign(details, { from: user.role, to: next.role });
        if (change === 'updated') details['fields'] = Object.keys(patch).sort().join(',');
        await tx.audit.append({
          tenantId: ctx.tenantId,
          occurredAt: now,
          producer: 'web',
          action: AUDIT_ACTION[change],
          actorUserId: ctx.userId,
          subjectType: 'user',
          subjectId: userId,
          via: 'ui',
          details,
          correlationId,
        });
      }
      await tx.outbox.userChanged({ tenantId: ctx.tenantId, user: next, correlationId });
      const notify = changes.includes('reactivated')
        ? { kind: 'account_reactivated' as const, title: REACTIVATED_TITLE }
        : changes.includes('role_changed')
          ? { kind: 'role_changed' as const, title: roleChangedTitle(next.role) }
          : null;
      if (notify)
        await tx.notifications.insert({
          tenantId: ctx.tenantId,
          id: crypto.randomUUID(),
          userId,
          kind: notify.kind,
          subjectType: 'user',
          subjectId: userId,
          subjectCode: null,
          title: notify.title,
          link: PROFILE_LINK,
          sourceEventId: null,
          createdAt: now,
          readAt: null,
        });
      return { user: next, changes };
    });
    if (result.changes.length) {
      this.d.onUserChanged(userId);
      if (result.changes.includes('deactivated')) await this.d.auth.setBlocked(userId, true);
      if (result.changes.includes('reactivated')) await this.d.auth.setBlocked(userId, false);
    }
    return result.user;
  }

  /** invitation-expire (hourly): pending invitations older than 7 days → expired; the user row is deactivated. */
  async expireInvitations(limit = 200): Promise<{ processed: number; remaining: number }> {
    const now = this.d.clock.now();
    const expired = await this.d.uow.run(async (tx) => {
      const list = await tx.invitations.listExpired(now, limit);
      for (const inv of list) {
        await tx.invitations.setStatus(inv.tenantId, inv.id, 'expired', now);
        const user = await tx.users.get(inv.tenantId, inv.userId);
        if (user && user.status === 'invited') {
          const next: User = { ...user, status: 'deactivated', deactivatedAt: now, version: user.version + 1 };
          await tx.users.update(next, user.version);
          await tx.outbox.userChanged({ tenantId: inv.tenantId, user: next, correlationId: crypto.randomUUID() });
        }
      }
      return list;
    });
    for (const inv of expired) await this.d.auth.deleteUser(inv.userId).catch(() => undefined);
    return { processed: expired.length, remaining: expired.length === limit ? 1 : 0 };
  }
}
