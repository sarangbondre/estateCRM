// Database types of the records schema: technical tables (0001) and the business tables (0002, records LLD §3).
import pg from 'pg';
import type { IdempotencyKeysTable } from '@11e/db';
import type { JobLeasesTable } from '@11e/http';
import type { OutboxDb } from '@11e/outbox';
import type { Tables } from '../../application/model.js';

export interface RecordsDb extends OutboxDb, Tables {
  idempotency_keys: IdempotencyKeysTable;
  job_leases: JobLeasesTable;
  schema_migrations: { version: string; name: string; checksum: string; applied_at: Date };
}

let installed = false;
/**
 * numeric and bigint as JS numbers (INR amounts < 2^53; areas and bhk are small), `date` as the ISO string
 * (no timezone shift). Process-wide for the pg driver; the records process only talks to its own schema.
 */
export function installTypeParsers(): void {
  if (installed) return;
  installed = true;
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
  pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
  pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
}
installTypeParsers();

/** jsonb columns: values are serialised explicitly (pg would send JS arrays as Postgres arrays). */
export const JSONB_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  persons: ['dependencies'],
  demands: ['stated_tags'],
  price_sheets: ['lines'],
  merge_candidates: ['evidence'],
  merges: ['moved_counts'],
  merge_undo_log: ['old_value', 'new_value'],
  vocabulary_releases: ['content'],
  unrouted_rows: ['row_snapshot'],
  reference_versions: ['recompute_cursor'],
};

/** Tables with an updated_at column (set on every update). */
export const TOUCHED_TABLES = new Set([
  'micromarkets',
  'reference_versions',
  'launch_area_cities',
  'vocabulary_releases',
  'persons',
  'projects',
  'properties',
  'offers',
  'price_sheets',
  'demands',
  'desk_items',
  'enquiries',
  'source_ads',
  'second_sources',
  'ingested_records',
  'unrouted_rows',
  'merge_candidates',
  'merges',
  'photos',
  'market_data_points',
  'upload_migrations',
  'inbound_versions',
]);
