// Database types of the intake schema (migrations/0001 technical tables, 0002 business tables; intake LLD §3).
import type { ColumnType, IdempotencyKeysTable } from '@11e/db';
import type { JobLeasesTable } from '@11e/http';
import type { OutboxDb } from '@11e/outbox';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb: read as parsed JSON, written as a JSON string (pg does not stringify arrays as JSON). */
type Json<T = unknown> = ColumnType<T, string, string>;
type NullableJson<T = unknown> = ColumnType<T | null, string | null | undefined, string | null>;
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export interface CodeSequencesTable {
  tenant_id: string;
  prefix: string;
  next_value: Defaulted<string>;
}

export interface TemplatesTable {
  id: string;
  tenant_id: string;
  name: string;
  source_type: string;
  source_detail: string | null;
  headers: string[];
  header_fingerprint: string;
  column_map: Json<Record<string, string | null>>;
  constants: NullableJson<Record<string, unknown>>;
  created_by: string;
  deleted_at: NullableTimestamp;
  version: Defaulted<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UploadsTable {
  id: string;
  tenant_id: string;
  code: string;
  file_name: string;
  content_type: string;
  size_bytes: ColumnType<string, number | string, number | string>;
  storage_path: string;
  sha256: string | null;
  sheet_names: string[] | null;
  sheet_name: string | null;
  header: string[] | null;
  header_fingerprint: string | null;
  row_estimate: number | null;
  mode: string | null;
  status: string;
  stage: string | null;
  source_type: string;
  source_detail: string | null;
  template_id: string | null;
  column_map: NullableJson<Record<string, string | null>>;
  suggested_mapping: NullableJson<Record<string, string | null>>;
  constants: NullableJson<Record<string, unknown>>;
  anonymise: boolean;
  import_crm_notes: Defaulted<boolean>;
  reprocess_unchanged: Defaulted<boolean>;
  allow_duplicate: Defaulted<boolean>;
  vocabulary_version: string | null;
  has_migration_map: Defaulted<boolean>;
  migration_entries: Defaulted<number>;
  duplicate_of_upload_id: string | null;
  chunk_size: number | null;
  chunk_count: number | null;
  chunks_done: Defaulted<number>;
  chunks_failed: Defaulted<number>;
  batch_count: number | null;
  batches_emitted: Defaulted<number>;
  rows_read: Defaulted<number>;
  rows_accepted: Defaulted<number>;
  rows_rejected: Defaulted<number>;
  rows_needs_review: Defaulted<number>;
  rows_unchanged: Defaulted<number>;
  rows_unclassified: Defaulted<number>;
  rejected_file_path: string | null;
  rejected_file_ready_at: NullableTimestamp;
  failure_reason: string | null;
  uploaded_by: string;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  source_file_deleted_at: NullableTimestamp;
  file_cleanup_at: NullableTimestamp;
  purge_after: NullableTimestamp;
  purged_at: NullableTimestamp;
  version: Defaulted<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UploadChunksTable {
  id: string;
  tenant_id: string;
  upload_id: string;
  chunk_no: number;
  row_from: number;
  row_to: number;
  chunk_file_path: string;
  status: Defaulted<string>;
  attempts: Defaulted<number>;
  leased_until: NullableTimestamp;
  rows_accepted: Defaulted<number>;
  rows_rejected: Defaulted<number>;
  rows_unchanged: Defaulted<number>;
  rows_needs_review: Defaulted<number>;
  error_code: string | null;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RawRowsTable {
  id: string;
  partition_month: ColumnType<Date, string | Date, string | Date>;
  tenant_id: string;
  upload_id: string;
  chunk_no: number;
  batch_no: number | null;
  row_no: number;
  sheet_name: string | null;
  original: Json<Record<string, string | null>>;
  normalised: NullableJson<Record<string, unknown>>;
  /** PII (CR-012). */
  crm_notes: Defaulted<string | null>;
  external_source: string;
  external_ref: string;
  parent_external_ref: string | null;
  content_hash: string;
  outcome: string;
  needs_review: boolean;
  review_reason_text: string | null;
  reason_codes: string[] | null;
  primary_reason_code: string | null;
  detail_code: string | null;
  record_scope: string | null;
  side: string | null;
  market: string | null;
  segment: string | null;
  deal_types: string[] | null;
  property_types: string[] | null;
  used_model: Defaulted<boolean>;
  anonymised: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RowErrorsTable {
  id: string;
  tenant_id: string;
  upload_id: string;
  row_id: string | null;
  row_no: number;
  sheet_name: string | null;
  field: string;
  severity: string;
  code: string;
  value: string | null;
  message: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RowFingerprintsTable {
  tenant_id: string;
  external_source: string;
  external_ref: string;
  content_hash: string;
  last_upload_id: string;
  last_row_id: string;
  updated_at: Timestamp;
}

export interface ReviewItemsTable {
  id: string;
  tenant_id: string;
  upload_id: string;
  row_id: string;
  row_no: number;
  external_ref: string;
  reason_code: string;
  detail_code: string;
  review_reason_text: string | null;
  current: Json<Record<string, unknown>>;
  suggested: NullableJson<Record<string, unknown>>;
  context: Json<Record<string, unknown>>;
  status: Defaulted<string>;
  resolution: NullableJson<Record<string, unknown>>;
  note: string | null;
  resolved_by: string | null;
  resolved_at: NullableTimestamp;
  vocabulary_version: string;
  version: Defaulted<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MigrationMapEntriesTable {
  id: string;
  tenant_id: string;
  upload_id: string;
  entry_no: number;
  old_ref: string;
  new_refs: string[];
  action: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface VocabularyCacheTable {
  id: string;
  tenant_id: string;
  version: string;
  checksum: string;
  content: Json<Record<string, unknown>>;
  status: string;
  fetched_at: Timestamp;
  superseded_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LegacyTermsTable {
  tenant_id: string;
  version: string;
  field: string;
  term_norm: string;
  maps: Json<Record<string, string>>;
  created_at: Timestamp;
}

export interface IntakeDb extends OutboxDb {
  idempotency_keys: IdempotencyKeysTable;
  job_leases: JobLeasesTable;
  schema_migrations: { version: string; name: string; checksum: string; applied_at: Date };
  code_sequences: CodeSequencesTable;
  templates: TemplatesTable;
  uploads: UploadsTable;
  upload_chunks: UploadChunksTable;
  raw_rows: RawRowsTable;
  row_errors: RowErrorsTable;
  row_fingerprints: RowFingerprintsTable;
  review_items: ReviewItemsTable;
  migration_map_entries: MigrationMapEntriesTable;
  vocabulary_cache: VocabularyCacheTable;
  legacy_terms: LegacyTermsTable;
}
