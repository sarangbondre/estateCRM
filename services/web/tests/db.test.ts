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
});
