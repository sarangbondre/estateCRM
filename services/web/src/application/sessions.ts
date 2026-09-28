// Sign-in completion, per-request authentication, /v1/me and sign-out (web LLD §4.1, D-7, NFR-16).
import { WebError } from '../domain/errors';
import { permissionsOf } from '../domain/roles';
import type { RoleCode } from '../domain/roles';
import { assertCanUseApp, idleExpiresAt, isIdleExpired, shouldTouchLastSeen } from '../domain/users';
import type { User } from '../domain/users';
import type { AuthProvider, Clock, UnitOfWork, UserRepo } from './ports';

/** The authenticated staff member for one request. */
export interface StaffContext {
  tenantId: string;
  userId: string;
  role: RoleCode;
  isDataOperator: boolean;
  user: User;
}

export interface EnvironmentInfo {
  name: 'local' | 'pilot' | 'dev' | 'staging' | 'production';
  pilot: boolean;
  vocabularyVersion: string | null;
}

export interface MeView {
  userId: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: RoleCode;
  isDataOperator: boolean;
  permissions: string[];
  sessionIdleExpiresAt: string;
  environment: EnvironmentInfo;
}

export interface SessionDeps {
  auth: AuthProvider;
  users: UserRepo;
  uow: UnitOfWork;
  clock: Clock;
  /** In-memory user cache TTL (LLD §4.1 c: 60 s). */
  cacheTtlMs?: number;
}

export class Sessions {
  private readonly cache = new Map<string, { user: User; at: number }>();
  private readonly ttl: number;

  constructor(private readonly deps: SessionDeps) {
    this.ttl = deps.cacheTtlMs ?? 60_000;
  }

  /** Drops a cached user (role change, deactivation) so this instance sees it at once; others within 60 s. */
  evict(userId: string): void {
    this.cache.delete(userId);
  }

  private async load(userId: string): Promise<User | undefined> {
    const now = this.deps.clock.now().getTime();
    const hit = this.cache.get(userId);
    if (hit && now - hit.at < this.ttl) return hit.user;
    const user = await this.deps.users.findById(userId);
    if (user) this.cache.set(userId, { user, at: now });
    else this.cache.delete(userId);
    return user;
  }

  /**
   * Per request: verify the Supabase access token, load the user (cached 60 s), require an active user, enforce the
   * 12 h idle timeout and record activity at most once a minute.
   */
  async authenticate(accessToken: string | null): Promise<StaffContext> {
    if (!accessToken) throw new WebError('unauthenticated');
    const verified = await this.deps.auth.verifyAccessToken(accessToken);
    if (!verified) throw new WebError('unauthenticated');
    const user = await this.load(verified.userId);
    assertCanUseApp(user);
    const now = this.deps.clock.now();
    if (isIdleExpired(user, now)) throw new WebError('session-expired');
    if (shouldTouchLastSeen(user.lastSeenAt, now)) {
      await this.deps.users.touchLastSeen(user.tenantId, user.id, now);
      this.cache.set(user.id, { user: { ...user, lastSeenAt: now }, at: now.getTime() });
    }
    return {
      tenantId: user.tenantId,
      userId: user.id,
      role: user.role,
      isDataOperator: user.isDataOperator,
      user: { ...user, lastSeenAt: shouldTouchLastSeen(user.lastSeenAt, now) ? now : user.lastSeenAt },
    };
  }

  /**
   * After the OAuth callback / e-mail link: only invited users may continue. The first sign-in flips invited → active
   * (users + invitation + audit + user.changed.v1 in one transaction). A Google account that was never invited is
   * removed from Supabase Auth again, because Supabase sign-ups must stay closed (D-7).
   */
  async completeSignIn(accessToken: string, correlationId: string): Promise<User> {
    const verified = await this.deps.auth.verifyAccessToken(accessToken);
    if (!verified) throw new WebError('unauthenticated');
    const found = await this.deps.users.findById(verified.userId);
    if (!found) {
      await this.deps.auth.deleteUser(verified.userId).catch(() => undefined);
      throw new WebError('not-invited');
    }
    if (found.status === 'deactivated') throw new WebError('user-deactivated');
    const now = this.deps.clock.now();
    this.evict(found.id);
    if (found.status === 'active') {
      await this.deps.users.touchLastSeen(found.tenantId, found.id, now);
      return { ...found, lastSeenAt: now };
    }
    return this.deps.uow.run(async (tx) => {
      const user = await tx.users.get(found.tenantId, found.id);
      if (!user) throw new WebError('not-invited');
      if (user.status !== 'invited') return user;
      const invitation = await tx.invitations.pendingForUser(user.tenantId, user.id);
      if (!invitation || invitation.expiresAt.getTime() < now.getTime()) throw new WebError('not-invited');
      const active: User = {
        ...user,
        status: 'active',
        activatedAt: now,
        lastSeenAt: now,
        version: user.version + 1,
      };
      if (!(await tx.users.update(active, user.version)))
        throw new WebError('internal', 'concurrent activation');
      await tx.invitations.setStatus(user.tenantId, invitation.id, 'accepted', now);
      await tx.audit.append({
        tenantId: user.tenantId,
        occurredAt: now,
        producer: 'web',
        action: 'user.activated',
        actorUserId: user.id,
        subjectType: 'user',
        subjectId: user.id,
        via: 'ui',
        details: { role: user.role },
        correlationId,
      });
      await tx.outbox.userChanged({ tenantId: user.tenantId, user: active, correlationId });
      return active;
    });
  }

  me(ctx: StaffContext, environment: EnvironmentInfo): MeView {
    const now = this.deps.clock.now();
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      email: ctx.user.email,
      displayName: ctx.user.displayName,
      role: ctx.role,
      isDataOperator: ctx.isDataOperator,
      permissions: permissionsOf(ctx.role, ctx.isDataOperator),
      sessionIdleExpiresAt: idleExpiresAt(ctx.user, now).toISOString(),
      environment,
    };
  }

  /** Audit entry for a sign-out; the adapter revokes the Supabase session and clears cookies. */
  async recordSignOut(ctx: StaffContext, correlationId: string): Promise<void> {
    this.evict(ctx.userId);
    await this.deps.uow.run((tx) =>
      tx.audit
        .append({
          tenantId: ctx.tenantId,
          occurredAt: this.deps.clock.now(),
          producer: 'web',
          action: 'session.signed_out',
          actorUserId: ctx.userId,
          subjectType: 'user',
          subjectId: ctx.userId,
          via: 'ui',
          correlationId,
        })
        .then(() => undefined),
    );
  }
}
