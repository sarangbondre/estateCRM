// Database types of the journeys schema and the Postgres type mapping the application rows expect.
import type { ColumnType } from 'kysely';
import pg from 'pg';
import type { IdempotencyKeysTable } from '@11e/db';
import type { JobLeasesTable } from '@11e/http';
import type { OutboxDb } from '@11e/outbox';
import type { Tables } from '../application/model.js';

/** Every business column is optional on insert (the application's NewRow<T> decides what is required). */
type Table<R> = { [K in keyof R]: ColumnType<R[K], R[K] | undefined, R[K]> };

type BusinessTables = { [K in keyof Tables]: Table<Tables[K]> };

export interface JourneysDb extends OutboxDb, BusinessTables {
  idempotency_keys: IdempotencyKeysTable;
  job_leases: JobLeasesTable;
  schema_migrations: { version: string; name: string; checksum: string; applied_at: Date };
  code_sequences: { tenant_id: string; prefix: string; next_value: number; created_at: Date; updated_at: Date };
  aggregate_versions: Table<{ id: string; tenant_id: string; aggregate_type: string; version: number; created_at: Date; updated_at: Date }>;
  job_runs: Table<{
    id: string;
    tenant_id: string | null;
    job: string;
    run_date: string;
    cursor: string | null;
    processed: number;
    done: boolean;
    started_at: Date;
    finished_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>;
}

let configured = false;
/**
 * `date` stays 'YYYY-MM-DD' (IST business dates, never shifted by the process time zone); bigint (INR) and numeric
 * (areas, ranks) become numbers — INR values are far below 2^53. Process-wide, called by the composition root.
 */
export function configurePgTypes(): void {
  if (configured) return;
  configured = true;
  pg.types.setTypeParser(1082, (v: string) => v);
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
}
