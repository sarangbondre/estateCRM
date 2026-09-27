// WEB-04: users, invitations and roles (US-34), the audit sink and log (US-35), web's notifications (R-6), jobs.
import { randomUUID } from 'node:crypto';
import { createDb } from '@11e/db';
import { observe } from '@11e/observability';
import { beforeEach, describe, expect, it } from 'vitest';
import type { InboundEvent } from '../src/application/audit';
import type { WebDb } from '../src/adapters/db/schema';
import { sha256 } from '../src/adapters/crypto';
import { OTHER_TENANT, TENANT, makeUser } from './fakes';
import { CRON_SECRET, harness } from './harness';

type H = Awaited<ReturnType<typeof harness>>;
let h: H;
let admin: ReturnType<typeof makeUser>;
const json = (method: string, body: unknown, extra: Record<string, string> = {}) => ({
  method,
  headers: { 'content-type': 'application/json', ...extra },
  body: JSON.stringify(body),
});
const patch = (body: unknown, extra: Record<string, string> = {}) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/merge-patch+json', ...extra },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  h = await harness();
  admin = h.memory.add(makeUser({ role: 'Admin', displayName: 'Asha Admin' }));
});

describe('invitations (US-34)', () => {
  it('Admin invites: 201, user invited, invitation pending, audit + user.changed.v1 (active false)', async () => {
    const res = await h.app.request(
      '/v1/users/invitations',
      h.as(admin.id, json('POST', { email: 'New.Agent@Example.com', role: 'Demand agent' })),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ email: 'new.agent@example.com', displayName: 'New Agent', role: 'Demand agent', status: 'invited' });
    expect(body.invitationExpiresAt).toBeTruthy();
    expect(h.auth.invited).toEqual(['new.agent@example.com']);
    expect(h.memory.invitations).toHaveLength(1);
    expect(h.memory.audit.map((a) => a.action)).toEqual(['user.invited']);
    expect(h.memory.events.at(-1)?.user).toMatchObject({ status: 'invited', role: 'Demand agent' });
  });

  it('409 for a pending invitation or an existing user; 403 for non-Admins; 400 for a bad e-mail', async () => {
    const invite = (email: string, as = admin.id) =>
      h.app.request('/v1/users/invitations', h.as(as, json('POST', { email, role: 'Supply agent' })));
    expect((await invite('dup@example.com')).status).toBe(201);
    const again = await invite('DUP@example.com');
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('email-already-invited');
    const existing = h.memory.add(makeUser({ email: 'there@example.com' }), h.keyring.hmac('email-hash', 'there@example.com').toString('hex'));
    expect(existing).toBeTruthy();
    expect((await (await invite('there@example.com')).json()).code).toBe('user-exists');
    const mgr = h.memory.add(makeUser({ role: 'Manager' }));
    expect((await invite('x@example.com', mgr.id)).status).toBe(403);
    expect((await invite('not-an-email')).status).toBe(400);
  });

  it('Supabase down → 503 and nothing stored; a failed transaction deletes the Supabase user again', async () => {
    h.auth.failInvite = true;
    const res = await h.app.request('/v1/users/invitations', h.as(admin.id, json('POST', { email: 'a@example.com', role: 'Manager' })));
    expect(res.status).toBe(503);
    expect(h.memory.invitations).toHaveLength(0);
    h.auth.failInvite = false;
    const append = h.memory.audit.push.bind(h.memory.audit);
    h.memory.audit.push = () => {
      throw new Error('db down');
    };
    const res2 = await h.app.request('/v1/users/invitations', h.as(admin.id, json('POST', { email: 'b@example.com', role: 'Manager' })));
    expect(res2.status).toBe(500);
    expect(h.auth.deleted).toHaveLength(1);
    h.memory.audit.push = append;
  });

  it('revoke: 204, user deactivated, Supabase invite deleted; idempotent; accepted → 409; unknown → 404', async () => {
    const res = await h.app.request('/v1/users/invitations', h.as(admin.id, json('POST', { email: 'r@example.com', role: 'Manager' })));
    const { userId } = await res.json();
    const del = () => h.app.request(`/v1/users/invitations/${userId}`, h.as(admin.id, { method: 'DELETE' }));
    expect((await del()).status).toBe(204);
    expect(h.memory.users.get(userId)?.status).toBe('deactivated');
    expect(h.memory.invitations[0]?.status).toBe('revoked');
    expect(h.auth.deleted).toContain(userId);
    expect(h.memory.events.at(-1)?.user.status).toBe('deactivated');
    expect((await del()).status).toBe(204);
    const active = h.memory.add(makeUser());
    expect((await (await h.app.request(`/v1/users/invitations/${active.id}`, h.as(admin.id, { method: 'DELETE' }))).json()).code).toBe(
      'invitation-already-accepted',
    );
    expect((await h.app.request(`/v1/users/invitations/${randomUUID()}`, h.as(admin.id, { method: 'DELETE' }))).status).toBe(404);
  });

  it('a revoked or expired invitation can be issued again', async () => {
    const first = await (await h.app.request('/v1/users/invitations', h.as(admin.id, json('POST', { email: 'again@example.com', role: 'Manager' })))).json();
    await h.app.request(`/v1/users/invitations/${first.userId}`, h.as(admin.id, { method: 'DELETE' }));
    const second = await h.app.request('/v1/users/invitations', h.as(admin.id, json('POST', { email: 'again@example.com', role: 'Manager' })));
    expect(second.status).toBe(201);
  });

  it('invitation-expire: pending invitations past 7 days expire and the user is deactivated', async () => {
    await h.app.request('/v1/users/invitations', h.as(admin.id, json('POST', { email: 'late@example.com', role: 'Manager' })));
    h.clock.advance(8 * 86_400_000);
    expect(await h.users.expireInvitations()).toEqual({ processed: 1, remaining: 0 });
    expect(h.memory.invitations[0]?.status).toBe('expired');
  });
});

describe('PATCH /v1/users/{id} (US-34)', () => {
  let agent: ReturnType<typeof makeUser>;
  beforeEach(() => {
    agent = h.memory.add(makeUser({ role: 'Demand agent', version: 3 }));
  });

  it('role change: 200 + ETag, audit from/to, user.changed.v1, a notification for the user', async () => {
    const res = await h.app.request(`/v1/users/${agent.id}`, h.as(admin.id, patch({ role: 'Manager' }, { 'if-match': '"3"' })));
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"4"');
    expect(await res.json()).toMatchObject({ role: 'Manager', version: 4 });
    expect(h.memory.audit.at(-1)).toMatchObject({ action: 'user.role_changed', details: { from: 'Demand agent', to: 'Manager' } });
    expect(h.memory.events.at(-1)?.user).toMatchObject({ id: agent.id, role: 'Manager', version: 4 });
    expect(h.memory.notifications.at(-1)).toMatchObject({ userId: agent.id, kind: 'role_changed', title: 'Your role is now Manager' });
  });

  it('412 on a stale If-Match, 415 without merge-patch, 409 own role, 404 unknown, 403 for non-Admins', async () => {
    expect((await h.app.request(`/v1/users/${agent.id}`, h.as(admin.id, patch({ role: 'Manager' }, { 'if-match': '"1"' })))).status).toBe(412);
    expect((await h.app.request(`/v1/users/${agent.id}`, h.as(admin.id, json('PATCH', { role: 'Manager' })))).status).toBe(415);
    const own = await h.app.request(`/v1/users/${admin.id}`, h.as(admin.id, patch({ role: 'Manager' })));
    expect((await own.json()).code).toBe('cannot-change-own-role');
    expect((await h.app.request(`/v1/users/${randomUUID()}`, h.as(admin.id, patch({ role: 'Manager' })))).status).toBe(404);
    expect((await h.app.request(`/v1/users/${admin.id}`, h.as(agent.id, patch({ role: 'Manager' })))).status).toBe(403);
    // The last active Admin rule (409 last-admin) is covered by the domain tests: through the API an Admin can
    // only lose the role by another Admin's hand, and then they aren't the last one.
  });

  it('deactivation blocks the Supabase user and takes effect at once on this instance; reactivation notifies', async () => {
    expect((await h.app.request('/v1/me', h.as(agent.id))).status).toBe(200);
    expect((await h.app.request(`/v1/users/${agent.id}`, h.as(admin.id, patch({ status: 'deactivated' })))).status).toBe(200);
    expect(h.auth.blocked.get(agent.id)).toBe(true);
    expect((await (await h.app.request('/v1/me', h.as(agent.id))).json()).code).toBe('user-deactivated');
    await h.app.request(`/v1/users/${agent.id}`, h.as(admin.id, patch({ status: 'active' })));
    expect(h.auth.blocked.get(agent.id)).toBe(false);
    expect(h.memory.notifications.at(-1)?.kind).toBe('account_reactivated');
  });
});

describe('GET /v1/users', () => {
  it('Admins see e-mails; others get the directory view; cursor pages by name; role filter', async () => {
    h.memory.add(makeUser({ displayName: 'Bela', role: 'Supply agent' }));
    const agent = h.memory.add(makeUser({ displayName: 'Chirag', role: 'Demand agent' }));
    h.memory.add(makeUser({ displayName: 'Other', tenantId: OTHER_TENANT }));
    const p1 = await (await h.app.request('/v1/users?limit=2', h.as(admin.id))).json();
    expect(p1.items.map((u: { displayName: string }) => u.displayName)).toEqual(['Asha Admin', 'Bela']);
    expect(p1.items[0].email).toBeTruthy();
    const p2 = await (await h.app.request(`/v1/users?limit=2&cursor=${p1.nextCursor}`, h.as(admin.id))).json();
    expect(p2.items.map((u: { displayName: string }) => u.displayName)).toEqual(['Chirag']);
    expect(p2.nextCursor).toBeNull();
    const dir = await (await h.app.request('/v1/users?role=Supply%20agent', h.as(agent.id))).json();
    expect(dir.items).toEqual([{ userId: expect.any(String), displayName: 'Bela', role: 'Supply agent', status: 'active' }]);
  });
});

const event = (type: string, data: Record<string, unknown>, producer = 'records'): InboundEvent => ({
  eventId: randomUUID(),
  eventType: type,
  occurredAt: new Date().toISOString(),
  correlationId: 'corr-evt-12345',
  producer,
  tenantId: TENANT,
  data,
});

describe('audit sink and log (US-35)', () => {
  const apply = (e: InboundEvent) => h.uow.run((tx) => h.audit.apply(e, tx));

  it('records audit.recorded.v1 once per eventId, scrubs PII values and chains the entries', async () => {
    const e = event('audit.recorded.v1', {
      action: 'contact.viewed',
      actorUserId: admin.id,
      subjectType: 'person',
      subjectId: randomUUID(),
      via: 'ui',
      details: { field: 'phone', leaked: '98200 11111' },
    });
    await apply(e);
    await apply(e);
    expect(h.memory.audit).toHaveLength(1);
    expect(h.memory.audit[0]?.details).toEqual({ field: 'phone', scrubbed: 'true' });
    await apply(event('audit.recorded.v1', { action: 'export.created', actorUserId: admin.id, subjectType: 'export', subjectId: randomUUID() }, 'insight'));
    expect(await h.audit.verifyChains(sha256)).toMatchObject({ processed: 2 });
  });

  it('rejects malformed audit events (→ DLQ after retries)', async () => {
    await expect(apply(event('audit.recorded.v1', { action: 'x', actorUserId: admin.id, subjectType: 't', subjectId: randomUUID(), details: { n: 1 } }))).rejects.toThrow();
    await expect(apply(event('audit.recorded.v1', { action: 'x' }))).rejects.toThrow();
    await expect(apply(event('audit.recorded.v1', { action: 'x', actorUserId: admin.id, subjectType: 't', subjectId: randomUUID() }, 'evil'))).rejects.toThrow();
  });

  it('GET /v1/audit-log: Admin only, newest first, action prefix filter, actor names, cursor', async () => {
    for (const action of ['export.created', 'export.downloaded', 'merge.done'])
      await apply(event('audit.recorded.v1', { action, actorUserId: admin.id, subjectType: 'export', subjectId: randomUUID() }));
    const res = await h.app.request('/v1/audit-log?action=export.*&limit=1', h.as(admin.id));
    expect(res.status).toBe(200);
    const p1 = await res.json();
    expect(p1.items).toHaveLength(1);
    expect(p1.items[0]).toMatchObject({ producer: 'records', actorDisplayName: 'Asha Admin' });
    expect(p1.items[0].entryHash).toMatch(/^[0-9a-f]{64}$/);
    const p2 = await (await h.app.request(`/v1/audit-log?action=export.*&limit=5&cursor=${p1.nextCursor}`, h.as(admin.id))).json();
    expect(p2.items).toHaveLength(1);
    const mgr = h.memory.add(makeUser({ role: 'Manager' }));
    expect((await h.app.request('/v1/audit-log', h.as(mgr.id))).status).toBe(403);
  });

  it('audit-chain-verify raises an alarm when an entry was altered', async () => {
    let broken: string | undefined;
    const h2 = await harness();
    const a2 = h2.memory.add(makeUser({ role: 'Admin' }));
    for (let i = 0; i < 3; i++)
      await h2.uow.run((tx) => h2.audit.apply(event('audit.recorded.v1', { action: `a.${i}`, actorUserId: a2.id, subjectType: 't', subjectId: randomUUID() }), tx));
    h2.memory.audit[1] = { ...h2.memory.audit[1]!, action: 'tampered' };
    const { AuditAndNotifications } = await import('../src/application/audit');
    const { MemoryAudit, MemoryNotifications, MemoryUsers } = await import('./fakes');
    const verifier = new AuditAndNotifications({
      audit: new MemoryAudit(h2.memory),
      notifications: new MemoryNotifications(h2.memory),
      users: new MemoryUsers(h2.memory),
      clock: h2.clock,
      looksLikePii: () => false,
      onChainBroken: (_t, id) => {
        broken = id;
      },
    });
    await verifier.verifyChains(sha256);
    expect(broken).toBe(h2.memory.audit[1]!.id);
  });
});

describe('notifications (R-6, FR-NTF-1)', () => {
  const apply = (e: InboundEvent) => h.uow.run((tx) => h.audit.apply(e, tx));

  it('upload and export events notify the uploader / requester with PII-free titles and links', async () => {
    await apply(
      event('upload.completed.v1', {
        uploadId: randomUUID(),
        code: 'UPL-000231',
        counts: { read: 20000, accepted: 19870, rejected: 130, needsReview: 12 },
        uploadedBy: admin.id,
      }, 'intake'),
    );
    await apply(event('export.failed.v1', { exportId: randomUUID(), code: 'EXP-000045', requestedBy: admin.id, reason: 'Some free text with a phone 9820011111' }, 'insight'));
    const res = await (await h.app.request('/v1/me/notifications', h.as(admin.id))).json();
    expect(res.unreadCount).toBe(2);
    expect(res.items.map((n: { title: string }) => n.title)).toEqual([
      'EXP-000045 failed (export did not complete)',
      'UPL-000231 processed: 19,870 accepted, 130 rejected, 12 to review',
    ]);
    expect(res.items[1]).toMatchObject({ kind: 'upload_completed', link: '/uploads/UPL-000231', subjectType: 'upload' });
  });

  it('redelivered events notify once; mark read by ids and upTo; unreadOnly; other users see nothing', async () => {
    const e = event('export.completed.v1', { exportId: randomUUID(), code: 'EXP-000046', rowCount: 1234, requestedBy: admin.id }, 'insight');
    await apply(e);
    await apply(e);
    await apply(event('upload.failed.v1', { uploadId: randomUUID(), code: 'UPL-000232', reason: 'header-mismatch', uploadedBy: admin.id }, 'intake'));
    const list = await (await h.app.request('/v1/me/notifications?unreadOnly=true', h.as(admin.id))).json();
    expect(list.items).toHaveLength(2);
    const failed = list.items.find((n: { kind: string }) => n.kind === 'upload_failed');
    expect(failed.title).toBe('UPL-000232 failed: because the columns do not match the template');
    const r1 = await h.app.request('/v1/me/notifications/read', h.as(admin.id, json('POST', { ids: [failed.notificationId] })));
    expect(await r1.json()).toEqual({ updated: 1, unreadCount: 1 });
    const r2 = await h.app.request('/v1/me/notifications/read', h.as(admin.id, json('POST', { upTo: new Date(Date.now() + 1000).toISOString() })));
    expect(await r2.json()).toEqual({ updated: 1, unreadCount: 0 });
    expect((await h.app.request('/v1/me/notifications/read', h.as(admin.id, json('POST', {})))).status).toBe(400);
    const other = h.memory.add(makeUser());
    expect((await (await h.app.request('/v1/me/notifications', h.as(other.id))).json()).items).toEqual([]);
  });

  it('notification-prune removes entries older than 90 days', async () => {
    await apply(event('export.completed.v1', { exportId: randomUUID(), code: 'EXP-1', rowCount: 1, requestedBy: admin.id }, 'insight'));
    h.clock.advance(91 * 86_400_000);
    expect((await h.audit.pruneNotifications()).processed).toBe(1);
  });
});

describe('contract completeness', () => {
  it('every web operation has a handler (svc.unimplemented() is empty)', async () => {
    const lazy = createDb<WebDb>({ connectionString: 'postgresql://nobody@127.0.0.1:1/none', schema: 'web', maxConnections: 1 });
    const full = await harness((p) => ({
      platform: { db: lazy.db, obs: observe('web', { level: 'fatal' }), audit: p.audit, jobs: {} },
    }));
    // /health/live and /health/ready are served by the libs/http factory itself.
    expect(full.svc.unimplemented().filter((id) => id !== 'live' && id !== 'ready')).toEqual([]);
    // Scheduler endpoints refuse without the cron secret.
    expect((await full.app.request('/internal/v1/relay', { method: 'POST' })).status).toBe(401);
    expect((await full.app.request('/internal/v1/jobs/keep-alive', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } })).status).toBe(401);
    expect(CRON_SECRET).toHaveLength(36);
    await lazy.close();
  });
});
