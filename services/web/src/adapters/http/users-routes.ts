// web's own endpoints for users, roles, the audit log and the caller's notifications (web.yaml), plus the platform
// endpoints (relay, drain q_web, jobs).
import topology from '@11e/contracts/event-topology.json' with { type: 'json' };
import type { Kysely } from '@11e/db';
import { expireIdempotencyKeys } from '@11e/db';
import { decodeCursor, idempotent, ifMatchVersion, pageLimit, registerPlatformEndpoints, toPage } from '@11e/http';
import type { JobResult, ServiceContext } from '@11e/http';
import type { Observability } from '@11e/observability';
import { withEventSpan } from '@11e/observability';
import { drainEvents } from '@11e/outbox';
import type { EventHandlers } from '@11e/outbox';
import type { AuditAndNotifications, InboundEvent } from '../../application/audit';
import type { Users } from '../../application/users';
import { userView } from '../../application/users';
import { toHex } from '../../domain/audit';
import type { Producer } from '../../domain/audit';
import { INVITATION_TTL_MS } from '../../domain/users';
import type { User } from '../../domain/users';
import type { WebDb } from '../db/schema';
import { txRepos } from '../db/uow';
import type { operations } from '@11e/contracts/web';
import type { Service } from '@11e/http';

type WebService = Service<operations>;
import { limit, mapped, staffOf } from './security';
import type { RateLimiter } from '../../application/ports';

export interface UserRoutesDeps {
  users: Users;
  audit: AuditAndNotifications;
  db: Kysely<WebDb> | null;
  limiter: RateLimiter | undefined;
  appOrigin: string;
}

const view = (u: User, admin: boolean) =>
  userView(u, admin, u.status === 'invited' && u.invitedAt ? new Date(u.invitedAt.getTime() + INVITATION_TTL_MS) : null);

/** Idempotency-Key replay (R-3, web's own POSTs) when the database is available. */
async function once(
  c: ServiceContext,
  db: Kysely<WebDb> | null,
  who: { tenantId: string; userId: string },
  body: unknown,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  if (db) return idempotent(c, db, who, body, run);
  const r = await run();
  return c.json(r.body as object, r.status as 200);
}

export function registerUserRoutes(svc: WebService, d: UserRoutesDeps): void {
  svc.op(
    'listUsers',
    mapped(async (c, { query }) => {
      const staff = staffOf(c);
      const size = pageLimit(query.limit);
      const after = decodeCursor<{ n: string; id: string }>(query.cursor);
      const rows = await d.users.list(staff, {
        limit: size + 1,
        ...(query.role ? { role: query.role } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(after ? { after: { displayName: after.n, id: after.id } } : {}),
      });
      const page = toPage(rows, size, (u) => ({ n: u.displayName, id: u.id }));
      return c.json({ items: page.items.map((u) => view(u, staff.role === 'Admin')), nextCursor: page.nextCursor });
    }),
  );

  svc.op(
    'inviteUser',
    mapped(async (c, { body }) => {
      const staff = staffOf(c);
      return once(c, d.db, staff, body, async () => {
        await limit(c, d.limiter, staff.tenantId, staff.tenantId, 'invite');
        const user = await d.users.invite(
          staff,
          {
            email: body.email,
            role: body.role,
            ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
            ...(body.isDataOperator !== undefined ? { isDataOperator: body.isDataOperator } : {}),
          },
          c.get('correlationId'),
          `${d.appOrigin}/auth/callback`,
        );
        return { status: 201, body: view(user, true) };
      });
    }),
  );

  svc.op(
    'revokeInvitation',
    mapped(async (c, { params }) => {
      await d.users.revokeInvitation(staffOf(c), params.userId, c.get('correlationId'));
      return c.body(null, 204);
    }),
  );

  svc.op(
    'updateUser',
    mapped(async (c, { params, body }) => {
      const user = await d.users.update(staffOf(c), params.userId, body, ifMatchVersion(c), c.get('correlationId'));
      c.header('etag', `"${user.version}"`);
      return c.json(view(user, true));
    }),
  );

  svc.op(
    'listAuditLog',
    mapped(async (c, { query }) => {
      const staff = staffOf(c);
      const size = pageLimit(query.limit);
      const after = decodeCursor<{ o: string; id: string }>(query.cursor);
      const { entries, names } = await d.audit.list(staff, {
        limit: size + 1,
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.subjectType ? { subjectType: query.subjectType } : {}),
        ...(query.subjectId ? { subjectId: query.subjectId } : {}),
        ...(query.producer ? { producer: query.producer as Producer } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
        ...(after ? { after: { occurredAt: new Date(after.o), id: after.id } } : {}),
      });
      const page = toPage(entries, size, (e) => ({ o: e.occurredAt.toISOString(), id: e.id }));
      return c.json({
        items: page.items.map((e) => ({
          auditId: e.id,
          eventId: e.eventId,
          occurredAt: e.occurredAt.toISOString(),
          recordedAt: e.recordedAt.toISOString(),
          producer: e.producer,
          action: e.action,
          actorUserId: e.actorUserId,
          actorDisplayName: names.get(e.actorUserId) ?? null,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          via: e.via,
          details: e.details,
          correlationId: e.correlationId,
          entryHash: toHex(e.entryHash),
        })),
        nextCursor: page.nextCursor,
      });
    }),
  );

  svc.op(
    'listMyNotifications',
    mapped(async (c, { query }) => {
      const staff = staffOf(c);
      const size = pageLimit(query.limit);
      const after = decodeCursor<{ c: string; id: string }>(query.cursor);
      const { items, unreadCount } = await d.audit.myNotifications(staff, {
        unreadOnly: Boolean(query.unreadOnly),
        limit: size + 1,
        ...(after ? { after: { createdAt: new Date(after.c), id: after.id } } : {}),
      });
      const page = toPage(items, size, (n) => ({ c: n.createdAt.toISOString(), id: n.id }));
      return c.json({
        items: page.items.map((n) => ({
          notificationId: n.id,
          kind: n.kind,
          title: n.title,
          subjectType: n.subjectType,
          subjectId: n.subjectId,
          ...(n.subjectCode ? { subjectCode: n.subjectCode } : {}),
          link: n.link,
          createdAt: n.createdAt.toISOString(),
          readAt: n.readAt ? n.readAt.toISOString() : null,
        })),
        nextCursor: page.nextCursor,
        unreadCount,
      });
    }),
  );

  svc.op(
    'markMyNotificationsRead',
    mapped(async (c, { body }) => {
      const staff = staffOf(c);
      return once(c, d.db, staff, body, async () => ({
        status: 200,
        body: await d.audit.markRead(staff, {
          ...(body.ids ? { ids: body.ids } : {}),
          ...(body.upTo ? { upTo: new Date(body.upTo) } : {}),
        }),
      }));
    }),
  );
}

export interface PlatformDeps {
  db: Kysely<WebDb>;
  obs: Observability;
  audit: AuditAndNotifications;
  jobs: Record<string, () => Promise<JobResult>>;
}

const WEB_EVENTS = [
  'audit.recorded.v1',
  'upload.completed.v1',
  'upload.failed.v1',
  'export.completed.v1',
  'export.failed.v1',
] as const;

/** q_web consumers (web LLD §5): each runs inside the drain's transaction, deduped on eventId by libs/outbox. */
export function webEventHandlers(audit: AuditAndNotifications): EventHandlers<WebDb> {
  const handlers: EventHandlers<WebDb> = {};
  for (const type of WEB_EVENTS) {
    (handlers as Record<string, unknown>)[type] = (e: InboundEvent & { traceparent?: string }, ctx: { trx: Parameters<typeof txRepos>[0] }) =>
      withEventSpan(e as never, () => audit.apply(e, txRepos(ctx.trx)), { queue: 'q_web' });
  }
  return handlers;
}

export function registerPlatform(svc: WebService, p: PlatformDeps): void {
  const queue = { db: p.db, schema: 'web' };
  registerPlatformEndpoints(svc, {
    responseStyle: 'compact',
    queue,
    routes: topology.routes,
    drains: {
      q_web: () =>
        drainEvents(queue, {
          queue: 'q_web',
          consumer: 'web',
          handlers: webEventHandlers(p.audit),
          onError: p.obs.drainHooks.onError,
        }),
    },
    jobs: {
      ...p.jobs,
      'idempotency-prune': async () => {
        const processed = await expireIdempotencyKeys(p.db);
        return { processed, remaining: processed >= 5000 ? 1 : 0 };
      },
    },
    onRelay: (r) => p.obs.onRelay(r),
    onDrain: p.obs.drainHooks.onResult,
  });
}
