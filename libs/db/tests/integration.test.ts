// Integration tests against the local Supabase stack (`pnpm db:start`). A scratch schema and temporary roles keep
// them independent of service tables; everything is dropped afterwards.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectionAcquireTimeoutError,
  beginIdempotent,
  checkDbReady,
  completeIdempotent,
  createDb,
  expireIdempotencyKeys,
  hashRequest,
  migrate,
  releaseIdempotent,
  tenantScope,
  withTransaction,
} from '../src/index.js';
import type { Generated, IdempotencyKeysTable } from '../src/index.js';

const ADMIN =
  process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const MIGRATOR =
  process.env['TEST_RECORDS_MIGRATOR_URL'] ??
  'postgresql://records_migrator:local_records_migrator@127.0.0.1:54322/postgres';
const suffix = randomUUID().slice(0, 8);
const SCHEMA = `it_db_${suffix}`;
const CAP_ROLE = `it_cap_${suffix}`;
const CAP_PASSWORD = `it_${suffix}`;

interface TestDb {
  items: { id: Generated<string>; tenant_id: string; name: string; version: Generated<number> };
  idempotency_keys: IdempotencyKeysTable;
  schema_migrations: { version: string };
}

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const USER = '00000000-0000-4000-8000-000000000001';

const admin = new pg.Client({ connectionString: ADMIN });
const handle = createDb<TestDb>({ connectionString: ADMIN, schema: SCHEMA, maxConnections: 4 });
const { db } = handle;

beforeAll(async () => {
  await admin.connect();
  await admin.query(`create schema ${SCHEMA}`);
  await admin.query(
    `create table ${SCHEMA}.items (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, name text not null, version int not null default 1)`,
  );
  await admin.query(`create table ${SCHEMA}.schema_migrations (version text primary key)`);
  await admin.query(`insert into ${SCHEMA}.schema_migrations values ('0003')`);
  await admin.query(
    `create table ${SCHEMA}.idempotency_keys (tenant_id uuid not null, user_id uuid not null, route text not null, key text not null,
       request_hash text not null, status_code integer, response_body jsonb, created_at timestamptz not null default now(),
       expires_at timestamptz not null, primary key (tenant_id, user_id, route, key))`,
  );
  await admin.query(`create role ${CAP_ROLE} login password '${CAP_PASSWORD}' connection limit 1`);
});

afterAll(async () => {
  await handle.close();
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = $1`, [CAP_ROLE]);
  await admin.query(`drop role if exists ${CAP_ROLE}`);
  await admin.end();
});

describe('tenantScope', () => {
  it('never reads, updates or deletes another tenant’s rows', async () => {
    const a = tenantScope(db, A);
    const b = tenantScope(db, B);
    await a.insertInto('items', [{ name: 'a1' }, { name: 'a2' }]).execute();
    await b.insertInto('items', { name: 'b1' }).execute();

    expect((await a.selectFrom('items').select('name').orderBy('name').execute()).map((r) => r.name)).toEqual(
      ['a1', 'a2'],
    );
    expect((await b.selectFrom('items').selectAll().execute()).map((r) => r.tenant_id)).toEqual([B]);

    await b.updateTable('items').set({ name: 'hijack' }).execute();
    await b.deleteFrom('items').where('name', '=', 'a1').execute();
    const aRows = await a.selectFrom('items').select('name').orderBy('name').execute();
    expect(aRows.map((r) => r.name)).toEqual(['a1', 'a2']);
  });
});

describe('withTransaction', () => {
  it('rolls back on error and applies the statement timeout', async () => {
    await expect(
      withTransaction(db, async (trx) => {
        await tenantScope(trx, A).insertInto('items', { name: 'rolled-back' }).execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(
      await tenantScope(db, A).selectFrom('items').select('id').where('name', '=', 'rolled-back').execute(),
    ).toEqual([]);

    await expect(
      withTransaction(
        db,
        async (trx) => {
          const { sql } = await import('kysely');
          await sql`select pg_sleep(1)`.execute(trx);
        },
        { statementTimeoutMs: 100, retries: 0 },
      ),
    ).rejects.toThrow(/statement timeout/);
  });
});

describe('idempotency keys', () => {
  const ref = { tenantId: A, userId: USER, route: 'POST /v1/items', key: randomUUID() };
  const h = hashRequest({ name: 'x' });

  it('new → in-progress → replay; different body → conflict', async () => {
    expect(await beginIdempotent(db, ref, h)).toEqual({ outcome: 'new' });
    expect(await beginIdempotent(db, ref, h)).toEqual({ outcome: 'in-progress' });
    await completeIdempotent(db, ref, 201, { id: 'abc', items: [1, 2] });
    expect(await beginIdempotent(db, ref, h)).toEqual({
      outcome: 'replay',
      statusCode: 201,
      body: { id: 'abc', items: [1, 2] },
    });
    expect(await beginIdempotent(db, ref, hashRequest({ name: 'y' }))).toEqual({ outcome: 'conflict' });
  });

  it('is scoped per tenant/user, releasable, and expires after 24 h', async () => {
    const other = { ...ref, tenantId: B };
    expect(await beginIdempotent(db, other, h)).toEqual({ outcome: 'new' });
    await releaseIdempotent(db, other);
    expect(await beginIdempotent(db, other, h)).toEqual({ outcome: 'new' });

    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await beginIdempotent(db, ref, hashRequest({ name: 'z' }), later)).toEqual({ outcome: 'new' });
    expect(
      await expireIdempotencyKeys(db, new Date(Date.now() + 50 * 60 * 60 * 1000)),
    ).toBeGreaterThanOrEqual(2);
  });

  it('only one of many concurrent claims wins', async () => {
    const r = { ...ref, key: randomUUID() };
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => beginIdempotent(db, r, h)));
    expect(outcomes.filter((o) => o.outcome === 'new')).toHaveLength(1);
  });
});

describe('checkDbReady', () => {
  it('reports ready, behind, and unreachable', async () => {
    expect(await checkDbReady(db, '0003')).toEqual({ ok: true, migration: '0003' });
    expect(await checkDbReady(db, '0004')).toEqual({ ok: false, migration: '0003', reason: 'behind' });
    const dead = createDb<TestDb>({
      connectionString: 'postgresql://nobody:x@127.0.0.1:1/postgres',
      schema: SCHEMA,
      acquireTimeoutMs: 300,
    });
    expect(await checkDbReady(dead.db, '0001')).toEqual({ ok: false, reason: 'unreachable' });
    await dead.close();
  });
});

describe('role connection cap', () => {
  const capUrl = () => {
    const u = new URL(ADMIN);
    u.username = CAP_ROLE;
    u.password = CAP_PASSWORD;
    return u.toString();
  };

  it('waits for a connection freed by another process instead of failing', async () => {
    const holder = new pg.Client({ connectionString: capUrl() });
    await holder.connect();
    const waiter = createDb<TestDb>({ connectionString: capUrl(), schema: SCHEMA, acquireTimeoutMs: 3000 });
    setTimeout(() => void holder.end(), 400);
    const { sql } = await import('kysely');
    const started = Date.now();
    await sql`select 1`.execute(waiter.db);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await waiter.close();
  });

  it('fails with ConnectionAcquireTimeoutError when nothing is freed in time', async () => {
    const holder = new pg.Client({ connectionString: capUrl() });
    await holder.connect();
    const waiter = createDb<TestDb>({ connectionString: capUrl(), schema: SCHEMA, acquireTimeoutMs: 300 });
    const { sql } = await import('kysely');
    await expect(sql`select 1`.execute(waiter.db)).rejects.toBeInstanceOf(ConnectionAcquireTimeoutError);
    await waiter.close();
    await holder.end();
  });
});

describe('migrate (as records_migrator)', () => {
  const table = `schema_migrations_it_${suffix}`;
  const t1 = `it_${suffix}_t1`;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    await writeFile(join(dir, '0001_create.sql'), `create table ${t1} (id int primary key);`);
    await writeFile(join(dir, '0002_expand.sql'), `alter table ${t1} add column name text;`);
  });
  afterAll(async () => {
    await admin.query(`drop table if exists records.${t1}, records.${table}`);
    await rm(dir, { recursive: true, force: true });
  });

  it('applies in order as the schema owner, then is a no-op', async () => {
    const opts = { connectionString: MIGRATOR, schema: 'records', dir, table };
    expect(await migrate(opts)).toEqual({ applied: ['0001', '0002'], alreadyApplied: [] });
    const { rows } = await admin.query(
      `select pg_get_userbyid(relowner) as owner from pg_class where oid = 'records.${t1}'::regclass`,
    );
    expect(rows[0].owner).toBe('records_owner');
    expect(await migrate(opts)).toEqual({ applied: [], alreadyApplied: ['0001', '0002'] });
  });

  it('rejects an edited applied file, a failing file, and a destructive change', async () => {
    const opts = { connectionString: MIGRATOR, schema: 'records', dir, table };
    await writeFile(join(dir, '0001_create.sql'), `create table ${t1} (id int primary key); -- edited`);
    await expect(migrate(opts)).rejects.toThrow(/edited after being applied/);
    await writeFile(join(dir, '0001_create.sql'), `create table ${t1} (id int primary key);`);

    await writeFile(join(dir, '0003_bad.sql'), `alter table ${t1} add column broken nosuchtype;`);
    await expect(migrate(opts)).rejects.toThrow(/0003_bad failed/);
    await rm(join(dir, '0003_bad.sql'));

    await writeFile(join(dir, '0003_drop.sql'), `alter table ${t1} drop column name;`);
    await expect(migrate(opts)).rejects.toThrow(/not backward compatible/);
    await rm(join(dir, '0003_drop.sql'));
  });

  it('cannot touch another service schema', async () => {
    const other = await mkdtemp(join(tmpdir(), 'migrations-'));
    await writeFile(join(other, '0001_x.sql'), `create table listings.it_${suffix}_evil (id int);`);
    await expect(
      migrate({ connectionString: MIGRATOR, schema: 'records', dir: other, table: `${table}_x` }),
    ).rejects.toThrow(/permission denied/);
    await admin.query(`drop table if exists records.${table}_x`);
    await rm(other, { recursive: true, force: true });
  });
});
