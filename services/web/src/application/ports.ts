// Ports (interfaces) the use cases depend on; adapters implement them (CLAUDE.md §3.1, web LLD §2).
import type { AuditEntry, Producer, Via } from '../domain/audit';
import type { RoleCode } from '../domain/roles';
import type { Bucket } from '../domain/routes';
import type { ServiceName, SigningKeyStatus } from '../domain/service-tokens';
import type { User, UserStatus } from '../domain/users';

/** Postgres token bucket with an in-memory fallback (web LLD §4.4). */
export interface RateLimiter {
  take(
    tenantId: string,
    subject: string,
    bucket: Bucket,
    cost?: number,
  ): Promise<{ allowed: boolean; remaining: number; limit: number; retryAfterSec: number }>;
}

/** One concurrent chat stream per user (20 s lease > the 15 s stream cap). */
export interface StreamLeases {
  acquire(tenantId: string, userId: string, ttlMs: number): Promise<string | null>;
  release(tenantId: string, userId: string, leaseId: string): Promise<void>;
}

export interface DownstreamRequest {
  service: ServiceName;
  method: string;
  /** Path and query, unchanged from the client. */
  pathAndQuery: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer> | null;
  firstByteMs: number;
  totalMs: number;
  retry: boolean;
}

/** One hop to an owning service: timeouts, one jittered retry, a circuit breaker per downstream. */
export interface Downstream {
  /** Throws WebError('dependency-unavailable') on a timeout, a network error or an open breaker. */
  send(req: DownstreamRequest): Promise<Response>;
  /** Circuit state per downstream for /health/ready. */
  states(): Record<string, string>;
}

export interface Clock {
  now(): Date;
}

/** A verified Supabase access token. */
export interface VerifiedAccessToken {
  userId: string;
  email: string | null;
  expiresAt: Date;
}

/** Supabase Auth (Google sign-in; admin API with the service-role key, web only). */
export interface AuthProvider {
  /** Verifies signature (JWKS), issuer, audience and expiry. Null when invalid. */
  verifyAccessToken(token: string): Promise<VerifiedAccessToken | null>;
  /** Sends the Supabase invite e-mail; returns the auth user id. Throws WebError('dependency-unavailable'). */
  inviteUserByEmail(email: string, redirectTo: string): Promise<{ userId: string }>;
  /** Deletes an auth user (compensation after a failed invite, revoked invitations, uninvited Google sign-ins). */
  deleteUser(userId: string): Promise<void>;
  /** Blocks (deactivation) or unblocks sign-in and token refresh for a user. */
  setBlocked(userId: string, blocked: boolean): Promise<void>;
}

export interface UserListQuery {
  role?: RoleCode;
  status?: UserStatus;
  limit: number;
  after?: { displayName: string; id: string };
}

export interface UserRepo {
  /** By the Supabase user id before the tenant is known (sign-in); UNIQUE (id). */
  findById(id: string): Promise<User | undefined>;
  get(tenantId: string, id: string): Promise<User | undefined>;
  findByEmailHash(tenantId: string, emailHash: string): Promise<User | undefined>;
  list(tenantId: string, q: UserListQuery): Promise<User[]>;
  countActiveAdmins(tenantId: string): Promise<number>;
  /** Idle-timeout bookkeeping; at most once a minute per user and instance. */
  touchLastSeen(tenantId: string, id: string, at: Date): Promise<void>;
  /** Active users idle longer than `before` (idle-session-sweep), bounded. */
  listIdle(before: Date, limit: number): Promise<User[]>;
}

export interface Invitation {
  tenantId: string;
  id: string;
  userId: string;
  emailHash: string;
  role: RoleCode;
  isDataOperator: boolean;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
}

export interface NewAudit {
  tenantId: string;
  eventId?: string | null;
  occurredAt: Date;
  producer: Producer;
  action: string;
  actorUserId: string;
  subjectType: string;
  subjectId: string;
  via: Via;
  details?: Record<string, string>;
  correlationId: string | null;
}

export interface UserChangedEvent {
  tenantId: string;
  user: Pick<User, 'id' | 'role' | 'displayName' | 'status' | 'version'>;
  correlationId: string;
}

/** Repositories bound to one database transaction. */
export interface Tx {
  users: {
    insert(user: User & { emailHash: string }): Promise<void>;
    /** Optimistic update; false when the version moved. */
    update(user: User, expectedVersion: number): Promise<boolean>;
    get(tenantId: string, id: string): Promise<User | undefined>;
    countActiveAdmins(tenantId: string): Promise<number>;
  };
  invitations: {
    insert(inv: Invitation): Promise<void>;
    pendingForUser(tenantId: string, userId: string): Promise<Invitation | undefined>;
    setStatus(tenantId: string, id: string, status: Invitation['status'], at: Date): Promise<void>;
    /** Pending invitations past their expiry (invitation-expire), bounded. */
    listExpired(now: Date, limit: number): Promise<Invitation[]>;
  };
  audit: {
    /** Appends to the per-tenant hash chain. Returns false for a duplicate eventId (second-level dedupe). */
    append(entry: NewAudit): Promise<boolean>;
  };
  outbox: {
    userChanged(e: UserChangedEvent): Promise<void>;
  };
  notifications: NotificationWriter;
}

export interface UnitOfWork {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface AuditQuery {
  actorUserId?: string;
  action?: { exact: string } | { prefix: string };
  subjectType?: string;
  subjectId?: string;
  producer?: Producer;
  from?: Date;
  to?: Date;
  limit: number;
  after?: { occurredAt: Date; id: string };
}

export interface AuditRepo {
  list(tenantId: string, q: AuditQuery): Promise<AuditEntry[]>;
  /** Entries recorded since `since`, in chain order, bounded (audit-chain-verify). */
  chainSince(tenantId: string, since: Date, limit: number): Promise<AuditEntry[]>;
  tenantsWithEntriesSince(since: Date): Promise<string[]>;
  ensurePartitions(): Promise<void>;
}

export type NotificationKind =
  | 'upload_completed'
  | 'upload_failed'
  | 'export_ready'
  | 'export_failed'
  | 'role_changed'
  | 'account_reactivated';

export interface NotificationRecord {
  tenantId: string;
  id: string;
  userId: string;
  kind: NotificationKind;
  subjectType: 'upload' | 'export' | 'user';
  subjectId: string;
  subjectCode: string | null;
  title: string;
  link: string;
  sourceEventId: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export interface NotificationWriter {
  /** Returns false when a notification for the same source event exists (dedupe). */
  insert(n: NotificationRecord): Promise<boolean>;
}

export interface NotificationRepo {
  list(
    tenantId: string,
    userId: string,
    q: { unreadOnly: boolean; limit: number; after?: { createdAt: Date; id: string } },
  ): Promise<NotificationRecord[]>;
  unreadCount(tenantId: string, userId: string, cap: number): Promise<number>;
  markRead(tenantId: string, userId: string, sel: { ids?: string[]; upTo?: Date }, at: Date): Promise<number>;
  prune(before: Date, limit: number): Promise<number>;
}

export interface StoredSigningKey {
  kid: string;
  status: SigningKeyStatus;
  publicJwk: Record<string, unknown>;
  /** PKCS#8 private key, encrypted at rest (adapter concern). */
  privateKey: CryptoKey | null;
  activatedAt: Date;
  retireAfter: Date | null;
}

export interface SigningKeyStore {
  /** Active + previous keys. */
  loadUsable(): Promise<StoredSigningKey[]>;
  /** Creates and stores a new key with the given status; returns it. */
  create(status: SigningKeyStatus, now: Date): Promise<StoredSigningKey>;
  /** Moves the current active key to previous (retire after grace) and makes `kid` active, atomically. */
  promote(kid: string, now: Date, graceMs: number): Promise<void>;
  /** Retires previous keys whose grace ended. */
  retireExpired(now: Date): Promise<number>;
}

export interface TokenSigner {
  sign(claims: Record<string, unknown>, ttlSec: number): Promise<{ token: string; expiresAt: Date }>;
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
  /** Reloads keys after a rotation. */
  reload(): Promise<void>;
  ready(): boolean;
}

export interface ServiceClient {
  name: ServiceName;
  allowedAudiences: string[];
  status: 'active' | 'revoked';
}

export interface ServiceClientRepo {
  findByCredential(credential: string): Promise<ServiceClient | undefined>;
}
