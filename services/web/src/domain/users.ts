// Web-own user rules (web LLD §4.1, §4.8, US-34): status transitions, the 12 h idle timeout, the last active Admin,
// own-role changes, invitation expiry. Pure.
import { WebError } from './errors';
import type { RoleCode } from './roles';

export type UserStatus = 'invited' | 'active' | 'deactivated';

export interface User {
  tenantId: string;
  id: string;
  email: string;
  displayName: string;
  role: RoleCode;
  isDataOperator: boolean;
  status: UserStatus;
  invitedBy: string | null;
  invitedAt: Date | null;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  lastSeenAt: Date | null;
  version: number;
}

export const IDLE_TIMEOUT_MS = 12 * 3600_000;
export const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
export const INVITATION_TTL_MS = 7 * 24 * 3600_000;
/** R-7: automatic actions (jobs, event-driven notifications). */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

/** Who may use the app right now. Invited users become active on their first sign-in (callback), never here. */
export function assertCanUseApp(user: User | undefined): asserts user is User {
  if (!user || user.status === 'invited') throw new WebError('not-invited');
  if (user.status === 'deactivated') throw new WebError('user-deactivated');
}

/** 12 h idle timeout (NFR-16): measured from the last request we saw. */
export function isIdleExpired(user: Pick<User, 'lastSeenAt' | 'activatedAt'>, now: Date): boolean {
  const last = user.lastSeenAt ?? user.activatedAt;
  return last !== null && now.getTime() - last.getTime() > IDLE_TIMEOUT_MS;
}

export function idleExpiresAt(user: Pick<User, 'lastSeenAt' | 'activatedAt'>, now: Date): Date {
  const last = user.lastSeenAt ?? user.activatedAt ?? now;
  return new Date(Math.max(last.getTime(), now.getTime()) + IDLE_TIMEOUT_MS);
}

/** `last_seen_at` is written at most once a minute. */
export function shouldTouchLastSeen(lastSeenAt: Date | null, now: Date): boolean {
  return !lastSeenAt || now.getTime() - lastSeenAt.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function assertValidEmail(email: string): void {
  if (email.length > 254 || !EMAIL.test(email)) throw new WebError('validation-failed', 'email is not valid');
}

/** A display name from the e-mail's local part when the Admin gives none ("priya.shah" → "Priya Shah"). */
export function defaultDisplayName(email: string): string {
  const local = email.split('@')[0] ?? email;
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join(' ')
      .slice(0, 80) || 'New user'
  );
}

export interface UserPatch {
  role?: RoleCode;
  isDataOperator?: boolean;
  displayName?: string;
  status?: 'active' | 'deactivated';
}

export type UserChangeKind = 'role_changed' | 'deactivated' | 'reactivated' | 'updated';

/**
 * Applies an Admin's merge patch (US-34): users can't change their own role or deactivate themselves; the last active
 * Admin can't be demoted or deactivated. `activeAdmins` counts active Admins in the tenant, including this user.
 */
export function applyUserPatch(
  actorId: string,
  user: User,
  patch: UserPatch,
  activeAdmins: number,
  now: Date,
): { user: User; changes: UserChangeKind[] } {
  const next: User = { ...user };
  const changes: UserChangeKind[] = [];
  const isSelf = actorId === user.id;

  if (patch.role !== undefined && patch.role !== user.role) {
    if (isSelf) throw new WebError('cannot-change-own-role');
    next.role = patch.role;
    changes.push('role_changed');
  }
  if (patch.status !== undefined && patch.status !== user.status) {
    if (user.status === 'invited')
      throw new WebError('validation-failed', 'an invited user becomes active by signing in');
    if (isSelf && patch.status === 'deactivated')
      throw new WebError('cannot-change-own-role', 'you cannot deactivate yourself');
    next.status = patch.status;
    if (patch.status === 'deactivated') {
      next.deactivatedAt = now;
      changes.push('deactivated');
    } else {
      next.deactivatedAt = null;
      changes.push('reactivated');
    }
  }
  const losesAdmin =
    user.role === 'Admin' && user.status === 'active' && (next.role !== 'Admin' || next.status !== 'active');
  if (losesAdmin && activeAdmins <= 1) throw new WebError('last-admin');

  if (patch.isDataOperator !== undefined && patch.isDataOperator !== user.isDataOperator) {
    next.isDataOperator = patch.isDataOperator;
    if (!changes.length) changes.push('updated');
  }
  if (patch.displayName !== undefined && patch.displayName.trim() !== user.displayName) {
    const name = patch.displayName.trim();
    if (!name) throw new WebError('validation-failed', 'displayName must not be empty');
    next.displayName = name;
    if (!changes.length) changes.push('updated');
  }
  if (changes.length) next.version = user.version + 1;
  return { user: next, changes };
}

/** Audit action per change (web LLD §4.6). */
export const AUDIT_ACTION: Record<UserChangeKind, string> = {
  role_changed: 'user.role_changed',
  deactivated: 'user.deactivated',
  reactivated: 'user.reactivated',
  updated: 'user.updated',
};
