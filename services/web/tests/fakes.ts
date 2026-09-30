// In-memory adapters for the application ports, so use cases and the HTTP contract run without Postgres or Supabase
// (the web CI job has no database). Synthetic data only.
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import type {
  AuditQuery,
  AuditRepo,
  AuthProvider,
  Clock,
  Invitation,
  NewAudit,
  NotificationRecord,
  NotificationRepo,
  ServiceClient,
  ServiceClientRepo,
  SigningKeyStore,
  StoredSigningKey,
  Tx,
  UnitOfWork,
  UserChangedEvent,
  UserListQuery,
  UserRepo,
  VerifiedAccessToken,
} from '../src/application/ports';
import { GENESIS_HASH, linkEntry } from '../src/domain/audit';
import type { AuditEntry } from '../src/domain/audit';
import type { SigningKeyStatus } from '../src/domain/service-tokens';
import type { User } from '../src/domain/users';
import { sha256 } from '../src/adapters/crypto';

export const TENANT = '11e00000-0000-4000-8000-000000000001';
export const OTHER_TENANT = '22e00000-0000-4000-8000-000000000002';

export class FakeClock implements Clock {
  constructor(public t = new Date('2026-09-28T06:00:00Z')) {}
  now() {
    return new Date(this.t.getTime());
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export function makeUser(p: Partial<User> = {}): User {
  return {
    tenantId: TENANT,
    id: randomUUID(),
    email: `user.${Math.random().toString(36).slice(2, 8)}@example.com`,
    displayName: 'Test User',
    role: 'Demand agent',
    isDataOperator: false,
    status: 'active',
    invitedBy: null,
    invitedAt: null,
    activatedAt: new Date(Date.now() - 30 * 86_400_000),
    deactivatedAt: null,
    lastSeenAt: new Date(Date.now() - 60_000), // relative: harness() runs on the real clock (12 h idle window)
    version: 1,
    ...p,
  };
}

/** Access tokens are "token.<userId>" in tests. */
export class FakeAuth implements AuthProvider {
  deleted: string[] = [];
  blocked = new Map<string, boolean>();
  invited: string[] = [];
  failInvite = false;
  async verifyAccessToken(token: string): Promise<VerifiedAccessToken | null> {
    const m = /^token\.(.+)$/.exec(token);
    return m?.[1] ? { userId: m[1], email: null, expiresAt: new Date(Date.now() + 3600_000) } : null;
  }
  async inviteUserByEmail(email: string): Promise<{ userId: string }> {
    if (this.failInvite) {
      const { WebError } = await import('../src/domain/errors');
      throw new WebError('dependency-unavailable');
    }
    this.invited.push(email);
    return { userId: randomUUID() };
  }
  async deleteUser(userId: string) {
    this.deleted.push(userId);
  }
  async setBlocked(userId: string, blocked: boolean) {
    this.blocked.set(userId, blocked);
  }
}

export class Memory {
  users = new Map<string, User & { emailHash?: string }>();
  invitations: Invitation[] = [];
  audit: AuditEntry[] = [];
  events: UserChangedEvent[] = [];
  notifications: NotificationRecord[] = [];
  touches = 0;

  add(u: User, emailHash = randomUUID().replace(/-/g, '')) {
    this.users.set(u.id, { ...u, emailHash });
    return u;
  }
}

const strip = (u: User & { emailHash?: string }): User => {
  const { emailHash, ...rest } = u;
  void emailHash;
  return rest;
};

export class MemoryUsers implements UserRepo {
  constructor(private readonly m: Memory) {}
  async findById(id: string) {
    const u = this.m.users.get(id);
    return u ? strip(u) : undefined;
  }
  async get(tenantId: string, id: string) {
    const u = this.m.users.get(id);
    return u && u.tenantId === tenantId ? strip(u) : undefined;
  }
  async findByEmailHash(tenantId: string, emailHash: string) {
    const all = [...this.m.users.values()].filter(
      (u) => u.tenantId === tenantId && u.emailHash === emailHash,
    );
    const u = all.at(-1);
    return u ? strip(u) : undefined;
  }
  async list(tenantId: string, q: UserListQuery) {
    return [...this.m.users.values()]
      .filter(
        (u) =>
          u.tenantId === tenantId && (!q.role || u.role === q.role) && (!q.status || u.status === q.status),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
      .filter(
        (u) =>
          !q.after ||
          u.displayName > q.after.displayName ||
          (u.displayName === q.after.displayName && u.id > q.after.id),
      )
      .slice(0, q.limit)
      .map(strip);
  }
  async countActiveAdmins(tenantId: string) {
    return [...this.m.users.values()].filter(
      (u) => u.tenantId === tenantId && u.role === 'Admin' && u.status === 'active',
    ).length;
  }
  async touchLastSeen(tenantId: string, id: string, at: Date) {
    const u = this.m.users.get(id);
    if (u && u.tenantId === tenantId) {
      u.lastSeenAt = at;
      this.m.touches++;
    }
  }
  async getMany(tenantId: string, ids: string[]) {
    return ids.map((id) => this.m.users.get(id)).filter((u): u is User & { emailHash?: string } => !!u && u.tenantId === tenantId).map(strip);
  }
  async listIdle(before: Date, limit: number) {
    return [...this.m.users.values()]
      .filter((u) => u.status === 'active' && u.lastSeenAt && u.lastSeenAt < before)
      .slice(0, limit)
      .map(strip);
  }
}

export class MemoryUow implements UnitOfWork {
  constructor(private readonly m: Memory) {}
  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const m = this.m;
    const users = new MemoryUsers(m);
    const tx: Tx = {
      users: {
        insert: async (u) => {
          m.users.set(u.id, { ...u });
        },
        update: async (u, expected) => {
          const cur = m.users.get(u.id);
          if (!cur || cur.version !== expected) return false;
          m.users.set(u.id, { ...cur, ...u });
          return true;
        },
        get: (t, id) => users.get(t, id),
        countActiveAdmins: (t) => users.countActiveAdmins(t),
      },
      invitations: {
        insert: async (inv) => {
          m.invitations.push({ ...inv });
        },
        pendingForUser: async (t, userId) =>
          m.invitations.find((i) => i.tenantId === t && i.userId === userId && i.status === 'pending'),
        setStatus: async (t, id, status, at) => {
          const i = m.invitations.find((x) => x.tenantId === t && x.id === id);
          if (i) {
            i.status = status;
            if (status === 'accepted') i.acceptedAt = at;
          }
        },
        listExpired: async (now, limit) =>
          m.invitations.filter((i) => i.status === 'pending' && i.expiresAt < now).slice(0, limit),
      },
      audit: {
        append: async (e: NewAudit) => {
          if (e.eventId && m.audit.some((a) => a.tenantId === e.tenantId && a.eventId === e.eventId))
            return false;
          const prev =
            [...m.audit].reverse().find((a) => a.tenantId === e.tenantId)?.entryHash ?? GENESIS_HASH;
          m.audit.push(
            linkEntry(
              {
                tenantId: e.tenantId,
                id: randomUUID(),
                eventId: e.eventId ?? null,
                occurredAt: e.occurredAt,
                recordedAt: new Date(),
                producer: e.producer,
                action: e.action,
                actorUserId: e.actorUserId,
                subjectType: e.subjectType,
                subjectId: e.subjectId,
                via: e.via,
                details: e.details ?? {},
                correlationId: e.correlationId,
              },
              prev,
              sha256,
            ),
          );
          return true;
        },
      },
      outbox: {
        userChanged: async (e) => {
          m.events.push(structuredClone(e));
        },
      },
      notifications: {
        insert: async (n) => {
          if (
            n.sourceEventId &&
            m.notifications.some((x) => x.tenantId === n.tenantId && x.sourceEventId === n.sourceEventId)
          )
            return false;
          m.notifications.push({ ...n });
          return true;
        },
      },
    };
    return fn(tx);
  }
}

export class MemoryAudit implements AuditRepo {
  constructor(private readonly m: Memory) {}
  async list(tenantId: string, q: AuditQuery) {
    return this.m.audit
      .filter((a) => a.tenantId === tenantId)
      .filter((a) => !q.actorUserId || a.actorUserId === q.actorUserId)
      .filter((a) => !q.subjectType || a.subjectType === q.subjectType)
      .filter((a) => !q.subjectId || a.subjectId === q.subjectId)
      .filter((a) => !q.producer || a.producer === q.producer)
      .filter(
        (a) =>
          !q.action ||
          ('exact' in q.action ? a.action === q.action.exact : a.action.startsWith(q.action.prefix)),
      )
      .filter((a) => !q.from || a.occurredAt >= q.from)
      .filter((a) => !q.to || a.occurredAt < q.to)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id))
      .filter(
        (a) =>
          !q.after ||
          a.occurredAt.getTime() < q.after.occurredAt.getTime() ||
          (a.occurredAt.getTime() === q.after.occurredAt.getTime() && a.id < q.after.id),
      )
      .slice(0, q.limit);
  }
  async chainSince(tenantId: string, since: Date, limit: number) {
    return this.m.audit.filter((a) => a.tenantId === tenantId && a.recordedAt >= since).slice(0, limit);
  }
  async tenantsWithEntriesSince() {
    return [...new Set(this.m.audit.map((a) => a.tenantId))];
  }
  async ensurePartitions() {}
}

export class MemoryNotifications implements NotificationRepo {
  constructor(private readonly m: Memory) {}
  private mine(t: string, u: string) {
    return this.m.notifications.filter((n) => n.tenantId === t && n.userId === u);
  }
  async list(
    t: string,
    u: string,
    q: { unreadOnly: boolean; limit: number; after?: { createdAt: Date; id: string } },
  ) {
    return this.mine(t, u)
      .filter((n) => !q.unreadOnly || !n.readAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .filter(
        (n) =>
          !q.after ||
          n.createdAt.getTime() < q.after.createdAt.getTime() ||
          (n.createdAt.getTime() === q.after.createdAt.getTime() && n.id < q.after.id),
      )
      .slice(0, q.limit);
  }
  async unreadCount(t: string, u: string, cap: number) {
    return Math.min(cap, this.mine(t, u).filter((n) => !n.readAt).length);
  }
  async markRead(t: string, u: string, sel: { ids?: string[]; upTo?: Date }, at: Date) {
    let n = 0;
    for (const x of this.mine(t, u)) {
      if (x.readAt) continue;
      if ((sel.ids && sel.ids.includes(x.id)) || (sel.upTo && x.createdAt <= sel.upTo)) {
        x.readAt = at;
        n++;
      }
    }
    return n;
  }
  async prune(before: Date, limit: number) {
    const keep = this.m.notifications.filter((n) => n.createdAt >= before);
    const n = Math.min(limit, this.m.notifications.length - keep.length);
    this.m.notifications = keep;
    return n;
  }
}

export class MemoryKeyStore implements SigningKeyStore {
  keys: StoredSigningKey[] = [];
  async loadUsable() {
    return this.keys.filter((k) => k.status !== 'retired');
  }
  async create(status: SigningKeyStatus, now: Date) {
    if (status === 'active' && this.keys.some((k) => k.status === 'active'))
      return this.keys.find((k) => k.status === 'active')!;
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
    const k: StoredSigningKey = {
      kid,
      status,
      publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' },
      privateKey: privateKey as CryptoKey,
      activatedAt: now,
      retireAfter: null,
    };
    this.keys.push(k);
    return k;
  }
  async promote(kid: string, now: Date, graceMs: number) {
    for (const k of this.keys)
      if (k.status === 'active')
        Object.assign(k, { status: 'previous', retireAfter: new Date(now.getTime() + graceMs) });
    const n = this.keys.find((k) => k.kid === kid && k.status === 'next');
    if (n) Object.assign(n, { status: 'active', activatedAt: now });
  }
  async retireExpired(now: Date) {
    let n = 0;
    for (const k of this.keys)
      if (k.status === 'previous' && k.retireAfter && k.retireAfter < now) {
        k.status = 'retired';
        n++;
      }
    return n;
  }
}

export class MemoryClients implements ServiceClientRepo {
  constructor(public clients: Map<string, ServiceClient> = new Map()) {}
  async findByCredential(credential: string) {
    return this.clients.get(credential);
  }
}
