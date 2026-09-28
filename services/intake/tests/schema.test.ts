// INT-01: the intake schema on the local stack: every LLD §3 table and index exists, business indexes lead with
// tenant_id, PII columns are commented, and the runtime role can create a raw_rows month partition.
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrate, sql } from '@11e/db';
import { SCHEMA } from '../src/config.js';
import type { IntakeDb } from '../src/adapters/db.js';
import { dbEnv } from './support/env.js';

const handle = createDb<IntakeDb>({
  connectionString: dbEnv.DATABASE_URL,
  schema: SCHEMA,
  maxConnections: 1,
});
beforeAll(async () => {
  await migrate({
    connectionString: dbEnv.MIGRATOR_DATABASE_URL,
    schema: SCHEMA,
    dir: new URL('../migrations', import.meta.url).pathname,
  });
});
afterAll(() => handle.close());

const TABLES = [
  'code_sequences',
  'templates',
  'uploads',
  'upload_chunks',
  'raw_rows',
  'row_errors',
  'row_fingerprints',
  'review_items',
  'migration_map_entries',
  'vocabulary_cache',
  'legacy_terms',
  'idempotency_keys',
  'outbox',
  'processed_events',
  'job_leases',
];
/** Technical tables (R-4) and job-only indexes that scan across tenants. */
const NOT_TENANT_FIRST = new Set([
  'uploads_purge_due',
  'uploads_file_cleanup_due',
  'upload_chunks_lease_expiry',
  'idempotency_keys_expires_at',
  'outbox_unpublished',
  'outbox_published_at',
]);
const TECHNICAL_TABLES = ['job_leases', 'schema_migrations', 'processed_events'];

describe('intake schema (INT-01)', () => {
  it('has every table of LLD §3', async () => {
    const r = await sql<{ table_name: string }>`select table_name from information_schema.tables
      where table_schema = 'intake'`.execute(handle.db);
    const names = r.rows.map((x) => x.table_name);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it('leads every business index with tenant_id', async () => {
    const r = await sql<{
      indexname: string;
      tablename: string;
      indexdef: string;
    }>`select indexname, tablename, indexdef
      from pg_indexes where schemaname = 'intake'`.execute(handle.db);
    const offenders = r.rows.filter((i) => {
      if (NOT_TENANT_FIRST.has(i.indexname) || i.indexname.endsWith('_pkey')) return false;
      if (TECHNICAL_TABLES.includes(i.tablename)) return false;
      if (/^raw_rows_(\d{4}_\d{2}|default)$/.test(i.tablename)) return false;
      return !/\(tenant_id[,)]/.test(i.indexdef);
    });
    expect(offenders.map((o) => o.indexname)).toEqual([]);
  });

  it('marks PII columns in the migration', async () => {
    const text = await readFile(
      new URL('../migrations/0002_intake_business_tables.sql', import.meta.url),
      'utf8',
    );
    for (const col of ['original jsonb', 'normalised jsonb', 'context jsonb']) {
      expect(text).toMatch(new RegExp(`${col}[^\\n]*-- PII`));
    }
  });

  it('lets the runtime role create a month partition of raw_rows (idempotent)', async () => {
    await sql`select ensure_raw_rows_partition(${'2031-02-14'}::date)`.execute(handle.db);
    await sql`select ensure_raw_rows_partition(${'2031-02-01'}::date)`.execute(handle.db);
    const r = await sql<{
      t: string | null;
    }>`select to_regclass('intake.raw_rows_2031_02')::text as t`.execute(handle.db);
    expect(r.rows[0]?.t).toBe('raw_rows_2031_02');
  });
});
