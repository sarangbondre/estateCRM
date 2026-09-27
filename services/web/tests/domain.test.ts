// Domain rules: roles and permissions (PRD §2.3), user rules (US-34, NFR-16), audit hash chain (US-35), service
// token policy (R-2).
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/adapters/crypto';
import {
  GENESIS_HASH,
  actionFilter,
  canonicalJson,
  linkEntry,
  scrubDetails,
  verifyChain,
} from '../src/domain/audit';
import type { AuditEntry } from '../src/domain/audit';
import { ROLE_CODES, permissionsOf, roleCatalogue } from '../src/domain/roles';
import {
  ALLOWED_AUDIENCES,
  audienceAllowed,
  rotationDue,
  serviceTokenClaims,
  userTokenClaims,
} from '../src/domain/service-tokens';
import {
  applyUserPatch,
  assertCanUseApp,
  defaultDisplayName,
  idleExpiresAt,
  isIdleExpired,
  shouldTouchLastSeen,
} from '../src/domain/users';
import { makeUser } from './fakes';

describe('roles and permissions (PRD §2.3)', () => {
  it('lists the five roles', () => {
    expect(roleCatalogue().map((r) => r.code)).toEqual([...ROLE_CODES]);
  });
  it('gives settings, users, API keys and the audit log to Admin only', () => {
    for (const p of ['settings.manage', 'users.manage', 'api_keys.manage', 'audit.read']) {
      expect(ROLE_CODES.filter((r) => permissionsOf(r, false).includes(p as never))).toEqual(['Admin']);
    }
  });
  it('reassign and capacity are Admin + Manager; undo merge too', () => {
    for (const p of ['queue.reassign', 'capacity.set', 'merge.undo']) {
      expect(ROLE_CODES.filter((r) => permissionsOf(r, false).includes(p as never))).toEqual([
        'Admin',
        'Manager',
      ]);
    }
  });
  it('publication level: Admin, Manager, Supply agent; exits: Admin, Manager, Demand agent', () => {
    expect(ROLE_CODES.filter((r) => permissionsOf(r, false).includes('publication.set'))).toEqual([
      'Admin',
      'Manager',
      'Supply agent',
    ]);
    expect(ROLE_CODES.filter((r) => permissionsOf(r, false).includes('exits.work'))).toEqual([
      'Admin',
      'Manager',
      'Demand agent',
    ]);
  });
  it('data operators see the data-quality dashboard only and work review queues', () => {
    const p = permissionsOf('Data operator', false);
    expect(p).toContain('review.work');
    expect(p).toContain('dashboards.quality');
    expect(p).not.toContain('dashboards.all');
  });
  it('the Data operator flag adds review work to an agent (A-15)', () => {
    expect(permissionsOf('Supply agent', false)).not.toContain('review.work');
    expect(permissionsOf('Supply agent', true)).toContain('review.work');
  });
  it('everyone can view records, upload, chat, export and view desks', () => {
    for (const r of ROLE_CODES)
      for (const p of ['records.view', 'upload.create', 'chat.use', 'export.create', 'desks.view'] as const)
        expect(permissionsOf(r, false)).toContain(p);
  });
});

describe('users (US-34, NFR-16)', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  it('only active users may use the app', () => {
    expect(() => assertCanUseApp(undefined)).toThrow('not-invited');
    expect(() => assertCanUseApp(makeUser({ status: 'invited' }))).toThrow('not-invited');
    expect(() => assertCanUseApp(makeUser({ status: 'deactivated' }))).toThrow('user-deactivated');
    expect(() => assertCanUseApp(makeUser())).not.toThrow();
  });
  it('12 h idle timeout from the last request', () => {
    const u = makeUser({ lastSeenAt: new Date('2026-09-28T00:00:00Z') });
    expect(isIdleExpired(u, new Date('2026-09-28T11:59:00Z'))).toBe(false);
    expect(isIdleExpired(u, new Date('2026-09-28T12:00:01Z'))).toBe(true);
    expect(idleExpiresAt(u, new Date('2026-09-28T01:00:00Z')).toISOString()).toBe('2026-09-28T13:00:00.000Z');
  });
  it('writes last_seen_at at most once a minute', () => {
    expect(shouldTouchLastSeen(null, now)).toBe(true);
    expect(shouldTouchLastSeen(new Date(now.getTime() - 30_000), now)).toBe(false);
    expect(shouldTouchLastSeen(new Date(now.getTime() - 60_000), now)).toBe(true);
  });
  it('users cannot change their own role', () => {
    const admin = makeUser({ role: 'Admin' });
    expect(() => applyUserPatch(admin.id, admin, { role: 'Manager' }, 2, now)).toThrow(
      'cannot-change-own-role',
    );
  });
  it('the last active Admin cannot be demoted or deactivated', () => {
    const a = makeUser({ role: 'Admin' });
    const actor = makeUser({ role: 'Admin', status: 'deactivated' }).id;
    expect(() => applyUserPatch(actor, a, { role: 'Manager' }, 1, now)).toThrow('last-admin');
    expect(() => applyUserPatch(actor, a, { status: 'deactivated' }, 1, now)).toThrow('last-admin');
    expect(applyUserPatch(actor, a, { role: 'Manager' }, 2, now).changes).toEqual(['role_changed']);
  });
  it('bumps the version and reports each change kind', () => {
    const u = makeUser({ version: 3 });
    const r = applyUserPatch('someone-else', u, { status: 'deactivated', displayName: ' New Name ' }, 1, now);
    expect(r.changes).toEqual(['deactivated']);
    expect(r.user).toMatchObject({
      version: 4,
      status: 'deactivated',
      displayName: 'New Name',
      deactivatedAt: now,
    });
    expect(applyUserPatch('x', u, { displayName: u.displayName }, 1, now).changes).toEqual([]);
    expect(applyUserPatch('x', r.user, { status: 'active' }, 1, now).changes).toEqual(['reactivated']);
  });
  it('an invited user is activated by signing in, not by a patch', () => {
    expect(() => applyUserPatch('x', makeUser({ status: 'invited' }), { status: 'active' }, 1, now)).toThrow(
      'validation-failed',
    );
  });
  it('derives a display name from the e-mail', () => {
    expect(defaultDisplayName('priya.shah@example.com')).toBe('Priya Shah');
  });
});

describe('audit chain (US-35)', () => {
  const base = (i: number) => ({
    tenantId: '11e00000-0000-4000-8000-000000000001',
    id: `00000000-0000-4000-8000-00000000000${i}`,
    eventId: null,
    occurredAt: new Date(`2026-09-28T10:00:0${i}Z`),
    recordedAt: new Date(`2026-09-28T10:00:0${i}Z`),
    producer: 'records' as const,
    action: 'contact.viewed',
    actorUserId: '00000000-0000-4000-8000-0000000000aa',
    subjectType: 'person',
    subjectId: '00000000-0000-4000-8000-0000000000bb',
    via: 'ui' as const,
    details: { field: 'phone' },
    correlationId: 'cid-12345678',
  });
  const chain = (): AuditEntry[] => {
    const out: AuditEntry[] = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= 3; i++) {
      const e = linkEntry(base(i), prev, sha256);
      out.push(e);
      prev = e.entryHash;
    }
    return out;
  };
  it('verifies an intact chain and finds a tampered entry', () => {
    const c = chain();
    expect(verifyChain(c, sha256)).toBeNull();
    c[1] = { ...c[1]!, details: { field: 'email' } };
    expect(verifyChain(c, sha256)).toBe(c[1]!.id);
  });
  it('detects a removed entry', () => {
    const c = chain();
    expect(verifyChain([c[0]!, c[2]!], sha256)).toBe(c[2]!.id);
  });
  it('canonical JSON sorts keys', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(
      '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
    );
  });
  it('scrubs values that look like contact PII and rejects non-strings', () => {
    const pii = (v: string) => /@|\d{10}/.test(v);
    expect(scrubDetails({ field: 'phone', to: '9820011111' }, pii)).toEqual({
      details: { field: 'phone', scrubbed: 'true' },
      scrubbed: true,
    });
    expect(() => scrubDetails({ n: 3 } as never, pii)).toThrow('validation-failed');
  });
  it('action filter: exact or prefix', () => {
    expect(actionFilter('export.*')).toEqual({ prefix: 'export.' });
    expect(actionFilter('merge.done')).toEqual({ exact: 'merge.done' });
  });
});

describe('service tokens (R-2)', () => {
  it('allows only the documented caller → audience pairs', () => {
    expect(audienceAllowed('listings', 'records', ['records'])).toBe(true);
    expect(audienceAllowed('records', 'intake', ['intake'])).toBe(true);
    expect(audienceAllowed('records', 'journeys', ['journeys'])).toBe(false);
    expect(audienceAllowed('insight', 'records', [])).toBe(false);
    expect(Object.values(ALLOWED_AUDIENCES).every((a) => a.length > 0)).toBe(true);
  });
  it('user tokens carry uid/role/dop, service tokens never a uid', () => {
    const u = userTokenClaims({
      audience: 'records',
      tenantId: 't',
      userId: 'u',
      role: 'Manager',
      isDataOperator: true,
    });
    expect(u).toEqual({
      iss: 'web',
      sub: 'web',
      aud: 'records',
      tid: 't',
      uid: 'u',
      role: 'Manager',
      dop: true,
    });
    expect(serviceTokenClaims('listings', 'records', 't')).toEqual({
      iss: 'web',
      sub: 'listings',
      aud: 'records',
      tid: 't',
    });
  });
  it('rotation is due after 90 days', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(rotationDue(at, new Date('2026-03-31T00:00:00Z'))).toBe(false);
    expect(rotationDue(at, new Date('2026-04-01T00:00:00Z'))).toBe(true);
  });
});
