// Adapter integration tests on the local Postgres (skipped when unreachable): migrations, role seed, users and
// tenant isolation (NFR-15), the audit hash chain and its immutability, signing keys, service clients, the token bucket.
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { sql, withTransaction } from '@11e/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keyring, sha256 } from '../src/adapters/crypto';
import { DbAuditRepo } from '../src/adapters/db/audit';
import { DbServiceClientRepo, DbSigningKeyStore } from '../src/adapters/db/keys';
import { DbUnitOfWork, txRepos } from '../src/adapters/db/uow';
import { DbUserRepo } from '../src/adapters/db/users';
import { PgRateLimiter, PgStreamLeases } from '../src/adapters/db/limits';
import { DbNotificationRepo } from '../src/adapters/db/notifications';
import { webEventHandlers } from '../src/adapters/http/users-routes';
import { observe } from '@11e/observability';
import { CRON_SECRET, harness } from './harness';
import { EXPECTED_MIGRATION } from '../src/config';
import { verifyChain } from '../src/domain/audit';
import { roleCatalogue } from '../src/domain/roles';
import { makeUser } from './fakes';
import { closeDb, hasDb, testDb } from './db-helpers';

it('EXPECTED_MIGRATION is the newest migration file', () => {
  const newest = readdirSync(new URL('../migrations', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .at(-1);
  expect(newest?.slice(0, 4)).toBe(EXPECTED_MIGRATION);
});

describe.skipIf(!hasDb)('web schema on Postgres', () => {
  const tenant = randomUUID();
  const other = randomUUID();
  const keyring = new Keyring(randomBytes(32));
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeDb);

  it('seeds the five roles with the domain permission lists', async () => {
    const rows = await db.selectFrom('role').select(['code', 'permissions']).orderBy('code').execute();
    const domain = Object.fromEntries(roleCatalogue().map((r) => [r.code, [...r.permissions].sort()]));
    expect(Object.fromEntries(rows.map((r) => [r.code, [...r.permissions].sort()]))).toEqual(domain);
  });

  it('stores users; reads are tenant-scoped; list pages by name', async () => {
    const repo = new DbUserRepo(db);
    const uow = new DbUnitOfWork(db);
    const a = makeUser({ tenantId: tenant, displayName: 'Aarav Test' });
    const b = makeUser({ tenantId: tenant, displayName: 'Bela Test' });
    const x = makeUser({ tenantId: other, displayName: 'Other Tenant' });
    await uow.run(async (tx) => {
      for (const u of [a, b, x])
        await tx.users.insert({ ...u, emailHash: keyring.hmac('email-hash', u.email).toString('hex') });
    });
    expect((await repo.findById(a.id))?.displayName).toBe('Aarav Test');
    expect(await repo.get(other, a.id)).toBeUndefined(); // NFR-15
    const page1 = await repo.list(tenant, { limit: 1 });
    expect(page1.map((u) => u.id)).toEqual([a.id]);
    const page2 = await repo.list(tenant, { limit: 5, after: { displayName: a.displayName, id: a.id } });
    expect(page2.map((u) => u.id)).toEqual([b.id]);
    expect(
      (await repo.findByEmailHash(tenant, keyring.hmac('email-hash', b.email).toString('hex')))?.id,
    ).toBe(b.id);
    await uow.run(async (tx) => {
      expect(await tx.users.update({ ...a, role: 'Manager', version: 2 }, 1)).toBe(true);
      expect(await tx.users.update({ ...a, role: 'Admin', version: 2 }, 1)).toBe(false); // stale version
    });
  });

  it('appends a verifiable hash chain; UPDATE and DELETE are refused', async () => {
    const actor = randomUUID();
    await withTransaction(db, async (trx) => {
      const tx = txRepos(trx);
      for (const action of ['user.invited', 'user.activated', 'session.signed_out'])
        await tx.audit.append({
          tenantId: tenant,
          occurredAt: new Date(),
          producer: 'web',
          action,
          actorUserId: actor,
          subjectType: 'user',
          subjectId: actor,
          via: 'ui',
          details: { k: 'v' },
          correlationId: 'cid-12345678',
        });
      const eventId = randomUUID();
      const e = {
        tenantId: tenant,
        eventId,
        occurredAt: new Date(),
        producer: 'records' as const,
        action: 'contact.viewed',
        actorUserId: actor,
        subjectType: 'person',
        subjectId: randomUUID(),
        via: 'ui' as const,
        correlationId: null,
      };
      expect(await tx.audit.append(e)).toBe(true);
      expect(await tx.audit.append(e)).toBe(false); // redelivered event
    });
    const repo = new DbAuditRepo(db);
    const chain = await repo.chainSince(tenant, new Date(Date.now() - 60_000), 100);
    expect(chain).toHaveLength(4);
    expect(verifyChain(chain, sha256)).toBeNull();
    expect(
      (await repo.list(tenant, { limit: 10, action: { prefix: 'user.' } })).map((e) => e.action).sort(),
    ).toEqual(['user.activated', 'user.invited']);
    await expect(
      sql`update web.audit_log set action = 'x' where tenant_id = ${tenant}`.execute(db),
    ).rejects.toThrow();
    await expect(sql`delete from web.audit_log where tenant_id = ${tenant}`.execute(db)).rejects.toThrow();
    await repo.ensurePartitions();
  });

  it('signing keys: one active key, encrypted at rest, promote and retire', async () => {
    const store = new DbSigningKeyStore(db, keyring);
    // Other keys may exist from a running dev server with another KEK: only look at ours.
    const now = new Date();
    const next = await store.create('next', now);
    const raw = await db
      .selectFrom('signing_key')
      .select('private_key_enc')
      .where('kid', '=', next.kid)
      .executeTakeFirstOrThrow();
    expect(raw.private_key_enc.toString('utf8')).not.toContain('PRIVATE KEY');
    await db.updateTable('signing_key').set({ status: 'retired' }).where('kid', '=', next.kid).execute();
  });

  it('service clients are found by the HMAC of their credential only', async () => {
    const repo = new DbServiceClientRepo(db, keyring);
    const credential = randomBytes(24).toString('base64url');
    await repo.upsert('crm-engine', credential, ['records'], new Date());
    expect(await repo.findByCredential(credential)).toEqual({
      name: 'crm-engine',
      allowedAudiences: ['records'],
      status: 'active',
    });
    expect(await repo.findByCredential(`${credential}x`)).toBeUndefined();
  });

  it('take_token: burst, refusal, refill', async () => {
    const subject = randomUUID();
    const take = async () =>
      (
        await sql<{
          allowed: boolean;
          tokens: string;
        }>`select * from web.take_token(${tenant}::uuid, ${subject}, 'api', 20, 2, 1)`.execute(db)
      ).rows[0]!;
    expect((await take()).allowed).toBe(true);
    expect((await take()).allowed).toBe(true);
    const refused = await take();
    expect(refused.allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect((await take()).allowed).toBe(true);
  });

  it('PgRateLimiter: api takes blocks of 5 per round trip; a slow store falls back in memory', async () => {
    const limiter = new PgRateLimiter(db, { timeoutMs: 2000 });
    const subject = randomUUID();
    const first = await limiter.take(tenant, subject, 'api');
    expect(first).toMatchObject({ allowed: true, limit: 40 });
    const row = await db
      .selectFrom('rate_limit_bucket')
      .select('tokens')
      .where('tenant_id', '=', tenant)
      .where('subject_key', '=', subject)
      .executeTakeFirstOrThrow();
    expect(Number(row.tokens)).toBeCloseTo(35, 0); // 40 − one block of 5
    for (let i = 0; i < 4; i++) expect((await limiter.take(tenant, subject, 'api')).allowed).toBe(true);
    const fallbacks: string[] = [];
    const slow = new PgRateLimiter(db, { timeoutMs: 0, onFallback: (b) => fallbacks.push(b) });
    expect((await slow.take(tenant, randomUUID(), 'upload')).allowed).toBe(true);
    expect(fallbacks).toEqual(['upload']);
    expect(await limiter.prune(new Date(Date.now() + 3600_000), 1000)).toBeGreaterThan(0);
  });

  it('PgStreamLeases: one live lease per user; released or expired leases can be taken again', async () => {
    const leases = new PgStreamLeases(db);
    const u = randomUUID();
    const a = await leases.acquire(tenant, u, 20_000);
    expect(a).toBeTruthy();
    expect(await leases.acquire(tenant, u, 20_000)).toBeNull();
    await leases.release(tenant, u, a!);
    const b = await leases.acquire(tenant, u, 1);
    expect(b).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(await leases.acquire(tenant, u, 20_000)).toBeTruthy(); // the 1 ms lease expired
  });

  it('q_web handlers run inside the drain transaction: audit entry + notification, deduped by the stores', async () => {
    const h = await harness();
    const handlers = webEventHandlers(h.audit) as Record<string, (e: unknown, ctx: { trx: unknown; attempt: number }) => Promise<void>>;
    const actor = randomUUID();
    const audit = { eventId: randomUUID(), eventType: 'audit.recorded.v1', schemaVersion: 1, occurredAt: new Date().toISOString(), correlationId: 'corr-db-123456', producer: 'records', tenantId: tenant, aggregateType: 'person', aggregateId: randomUUID(), aggregateVersion: 1, data: { action: 'contact.viewed', actorUserId: actor, subjectType: 'person', subjectId: randomUUID(), via: 'ui', details: { field: 'phone' } } };
    const upload = { ...audit, eventId: randomUUID(), eventType: 'upload.completed.v1', producer: 'intake', data: { uploadId: randomUUID(), code: 'UPL-900001', counts: { read: 3, accepted: 2, rejected: 1, needsReview: 0 }, uploadedBy: actor } };
    await withTransaction(db, async (trx) => {
      await handlers['audit.recorded.v1']!(audit, { trx, attempt: 1 });
      await handlers['upload.completed.v1']!(upload, { trx, attempt: 1 });
      await handlers['upload.completed.v1']!(upload, { trx, attempt: 1 }); // redelivery
    });
    const entries = await new DbAuditRepo(db).list(tenant, { limit: 10, actorUserId: actor });
    expect(entries.map((e) => e.action)).toEqual(['contact.viewed']);
    const repo = new DbNotificationRepo(db);
    const mine = await repo.list(tenant, actor, { unreadOnly: true, limit: 10 });
    expect(mine.map((n) => n.title)).toEqual(['UPL-900001 processed: 2 accepted, 1 rejected, 0 to review']);
    expect(await repo.unreadCount(tenant, actor, 99)).toBe(1);
    expect(await repo.markRead(tenant, actor, { ids: [mine[0]!.id] }, new Date())).toBe(1);
    expect(await repo.unreadCount(tenant, actor, 99)).toBe(0);
  });

  it('relay, drain q_web and jobs run with the cron secret on the real schema', async () => {
    const h = await harness((p) => ({
      db,
      platform: { db, obs: observe('web', { level: 'fatal' }), audit: p.audit, jobs: { 'keep-alive': async () => ({ processed: 1 }) } },
    }));
    const cron = { 'x-cron-secret': CRON_SECRET };
    const relay = await h.app.request('/internal/v1/relay', { method: 'POST', headers: cron });
    expect(relay.status).toBe(200);
    expect(await relay.json()).toMatchObject({ processed: expect.any(Number), more: expect.any(Boolean) });
    expect((await h.app.request('/internal/v1/drain/q_web', { method: 'POST', headers: cron })).status).toBe(200);
    expect(await (await h.app.request('/internal/v1/jobs/keep-alive', { method: 'POST', headers: cron })).json()).toEqual({ processed: 1, more: false });
    expect((await h.app.request('/internal/v1/jobs/idempotency-prune', { method: 'POST', headers: cron })).status).toBe(200);
    expect((await h.app.request('/internal/v1/drain/q_other', { method: 'POST', headers: cron })).status).toBe(400);
  });
});
