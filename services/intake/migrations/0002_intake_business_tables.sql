-- intake business tables (intake LLD §3). Every business index leads with tenant_id (conventions §3); the few job-only
-- indexes that scan across tenants are marked "(job, cross-tenant)". PII columns are marked -- PII (LLD §7).

-- §3.10 display codes (UPL-000123)
create table if not exists code_sequences (
  tenant_id uuid not null,
  prefix text not null,
  next_value bigint not null default 1,
  primary key (tenant_id, prefix)
);

-- §3.6 mapping templates
create table if not exists templates (
  id uuid primary key,
  tenant_id uuid not null,
  name text not null,
  source_type text not null check (source_type in ('Channel', 'Digi', 'Direct')),
  source_detail text,
  headers text[] not null,
  header_fingerprint text not null,
  column_map jsonb not null,
  constants jsonb,
  created_by uuid not null,
  deleted_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 409 template-name-taken
create unique index if not exists templates_name_unique on templates (tenant_id, lower(name)) where deleted_at is null;
-- inspection suggestion; GET /v1/templates?headerFingerprint=
create index if not exists templates_fingerprint on templates (tenant_id, header_fingerprint) where deleted_at is null;
-- GET /v1/templates ordered by name + cursor
create index if not exists templates_by_name on templates (tenant_id, lower(name), id) where deleted_at is null;
-- GET /v1/templates?sourceType=
create index if not exists templates_by_source on templates (tenant_id, source_type, lower(name), id) where deleted_at is null;

-- §3.1 uploads
create table if not exists uploads (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  file_name text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  storage_path text not null,
  sha256 text,
  sheet_names text[],
  sheet_name text,
  header text[],
  header_fingerprint text,
  row_estimate integer,
  mode text check (mode in ('strict', 'mapping')),
  status text not null check (status in ('awaiting_file', 'inspecting', 'awaiting_mapping', 'ready',
    'awaiting_duplicate_confirmation', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  stage text check (stage in ('parsing', 'normalising', 'classifying', 'emitting')),
  source_type text not null check (source_type in ('Channel', 'Digi', 'Direct')),
  source_detail text,
  template_id uuid references templates (id),
  column_map jsonb,
  suggested_mapping jsonb,
  constants jsonb,
  anonymise boolean not null,
  import_crm_notes boolean not null default false,
  reprocess_unchanged boolean not null default false,
  allow_duplicate boolean not null default false,
  vocabulary_version text,
  has_migration_map boolean not null default false,
  migration_entries integer not null default 0,
  duplicate_of_upload_id uuid references uploads (id),
  chunk_size integer,
  chunk_count integer,
  chunks_done integer not null default 0,
  chunks_failed integer not null default 0,
  batch_count integer,
  batches_emitted integer not null default 0,
  rows_read integer not null default 0,
  rows_accepted integer not null default 0,
  rows_rejected integer not null default 0,
  rows_needs_review integer not null default 0,
  rows_unchanged integer not null default 0,
  rows_unclassified integer not null default 0,
  rejected_file_path text,
  rejected_file_ready_at timestamptz,
  failure_reason text,
  uploaded_by uuid not null,
  started_at timestamptz,
  completed_at timestamptz,
  source_file_deleted_at timestamptz,
  -- next time delete-processed-files has work for this upload (source file 30 d, rejected file 7 d)
  file_cleanup_at timestamptz,
  purge_after timestamptz,
  purged_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- GET /v1/uploads/{code}
create unique index if not exists uploads_code on uploads (tenant_id, code);
-- GET /v1/uploads default order + cursor (created_at, id) < ($c)
create index if not exists uploads_recent on uploads (tenant_id, created_at desc, id desc);
-- GET /v1/uploads?status=
create index if not exists uploads_by_status on uploads (tenant_id, status, created_at desc, id desc);
-- GET /v1/uploads?uploadedBy= ; also the 5 uploads/hour per user check (created_at > now() - 1 h)
create index if not exists uploads_by_uploader on uploads (tenant_id, uploaded_by, created_at desc, id desc);
-- GET /v1/uploads?sourceType=
create index if not exists uploads_by_source on uploads (tenant_id, source_type, created_at desc, id desc);
-- GET /v1/uploads?mode=
create index if not exists uploads_by_mode on uploads (tenant_id, mode, created_at desc, id desc);
-- duplicate detection at inspection: tenant_id=$1 and sha256=$2 and status='completed' limit 1
create index if not exists uploads_completed_sha on uploads (tenant_id, sha256) where status = 'completed';
-- retention-purge per tenant
create index if not exists uploads_purge on uploads (tenant_id, purge_after) where purge_after is not null;
-- retention-purge (job, cross-tenant): purge_after < now() and purged_at is null order by purge_after limit n
create index if not exists uploads_purge_due on uploads (purge_after) where purge_after is not null and purged_at is null;
-- delete-processed-files (job, cross-tenant): file_cleanup_at < now() order by file_cleanup_at limit n
create index if not exists uploads_file_cleanup_due on uploads (file_cleanup_at) where file_cleanup_at is not null;

-- §3.2 chunks
create table if not exists upload_chunks (
  id uuid primary key,
  tenant_id uuid not null,
  upload_id uuid not null references uploads (id),
  chunk_no integer not null,
  row_from integer not null,
  row_to integer not null,
  chunk_file_path text not null,
  status text not null default 'queued' check (status in ('queued', 'leased', 'done', 'failed', 'cancelled')),
  attempts integer not null default 0,
  leased_until timestamptz,
  rows_accepted integer not null default 0,
  rows_rejected integer not null default 0,
  rows_unchanged integer not null default 0,
  rows_needs_review integer not null default 0,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- chunk idempotency key (ADR-0005): where upload_id=$ and chunk_no=$ for update
create unique index if not exists upload_chunks_key on upload_chunks (tenant_id, upload_id, chunk_no);
-- concurrency semaphore: count(*) where tenant_id=$ and status='leased' and leased_until > now()
create index if not exists upload_chunks_leased on upload_chunks (tenant_id, status, leased_until) where status = 'leased';
-- reap-chunk-leases (job, cross-tenant): status='leased' and leased_until < now() limit n
create index if not exists upload_chunks_lease_expiry on upload_chunks (leased_until) where status = 'leased';
-- progress and finalize checks
create index if not exists upload_chunks_by_status on upload_chunks (tenant_id, upload_id, status);

-- §3.3 raw rows, partitioned by month of the upload start so retention works on whole months
create table if not exists raw_rows (
  id uuid not null,
  partition_month date not null,
  tenant_id uuid not null,
  upload_id uuid not null,
  chunk_no integer not null,
  batch_no integer,
  row_no integer not null,
  sheet_name text,
  original jsonb not null,            -- PII (header → cell text as read; anonymised when the switch is on)
  normalised jsonb,                   -- PII (IntakeRow shape)
  external_source text not null check (external_source in ('extractor', 'upload')),
  external_ref text not null,
  parent_external_ref text,
  content_hash text not null,
  outcome text not null check (outcome in ('accepted', 'rejected', 'unchanged')),
  needs_review boolean not null,
  review_reason_text text,
  reason_codes text[],
  primary_reason_code text,
  detail_code text,
  record_scope text,
  side text,
  market text,
  segment text,
  deal_types text[],
  property_types text[],
  used_model boolean not null default false,
  anonymised boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, partition_month)
) partition by range (partition_month);
create table if not exists raw_rows_default partition of raw_rows default;
-- idempotent chunk retry: insert … on conflict do nothing
create unique index if not exists raw_rows_row on raw_rows (tenant_id, upload_id, row_no, partition_month);
-- GET /internal/v1/uploads/{id}/rows?batch= (≤ 500 rows, row order)
create index if not exists raw_rows_batch on raw_rows (tenant_id, upload_id, batch_no, row_no) where outcome = 'accepted';
-- finalize: rejected-rows file (outcome='rejected' order by row_no, 1,000 at a time); retention deletes by upload
create index if not exists raw_rows_outcome on raw_rows (tenant_id, upload_id, outcome, row_no);
-- lineage / support: latest raw row of a ref
create index if not exists raw_rows_ref on raw_rows (tenant_id, external_source, external_ref, partition_month desc);

-- Monthly partitions are created on demand by the split job (runtime role has no DDL rights, so it calls this).
create or replace function ensure_raw_rows_partition(p_month date) returns void
language plpgsql security definer set search_path = intake as $$
declare
  m date := date_trunc('month', p_month)::date;
  part text := 'raw_rows_' || to_char(m, 'YYYY_MM');
begin
  if to_regclass('intake.' || part) is null then
    begin
      execute format('create table intake.%I partition of intake.raw_rows for values from (%L) to (%L)',
        part, m, (m + interval '1 month')::date);
    exception when duplicate_table then null;
    end;
  end if;
end $$;
grant execute on function ensure_raw_rows_partition(date) to intake_svc;

-- §3.4 row errors
create table if not exists row_errors (
  id uuid primary key,
  tenant_id uuid not null,
  upload_id uuid not null references uploads (id),
  row_id uuid,
  row_no integer not null,
  sheet_name text,
  field text not null,
  severity text not null check (severity in ('error', 'warning')),
  code text not null,
  value text,                         -- null when the field is a PII field
  message text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- idempotent insert on chunk retry
create unique index if not exists row_errors_key on row_errors (tenant_id, upload_id, row_no, field, code);
-- GET /v1/uploads/{id}/row-errors in row order + cursor
create index if not exists row_errors_by_row on row_errors (tenant_id, upload_id, row_no, id);
-- ?field=&code= filters; rejection reasons per code for the report
create index if not exists row_errors_by_field on row_errors (tenant_id, upload_id, field, code, row_no);
-- ?code= alone; upload.completed.v1 rejectionReasons (severity='error' group by code)
create index if not exists row_errors_by_code on row_errors (tenant_id, upload_id, code, row_no);

-- §3.5 fingerprints (upsert key memory, US-07a)
create table if not exists row_fingerprints (
  tenant_id uuid not null,
  external_source text not null,
  external_ref text not null,
  content_hash text not null,
  last_upload_id uuid not null,
  last_row_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, external_source, external_ref)
);

-- §3.7 review items
create table if not exists review_items (
  id uuid primary key,
  tenant_id uuid not null,
  upload_id uuid not null references uploads (id),
  row_id uuid not null,
  row_no integer not null,
  external_ref text not null,
  reason_code text not null check (reason_code in ('side_defaulted', 'deal_type_missing', 'side_unclear',
    'property_type_missing', 'value_not_translatable', 'model_unavailable', 'low_confidence', 'other')),
  detail_code text not null check (detail_code in ('extractor_flag', 'value_not_translatable', 'model_unavailable',
    'low_confidence', 'redaction_uncertain', 'side_missing', 'scope_unclear')),
  review_reason_text text,
  current jsonb not null,
  suggested jsonb,
  context jsonb not null,             -- PII (redacted text may still hold a name)
  status text not null default 'open' check (status in ('open', 'resolved', 'skipped')),
  resolution jsonb,
  note text,
  resolved_by uuid,
  resolved_at timestamptz,
  vocabulary_version text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one item per row; on conflict do nothing on chunk retry
create unique index if not exists review_items_row on review_items (tenant_id, row_id);
-- GET /v1/review-items?reasonCode=&status= oldest first + cursor; summary group by reason_code where status='open'
create index if not exists review_items_queue on review_items (tenant_id, status, reason_code, created_at, id);
-- ?uploadId= list and per-upload summary
create index if not exists review_items_by_upload on review_items (tenant_id, upload_id, status, reason_code, created_at, id);
-- ?detailCode=
create index if not exists review_items_by_detail on review_items (tenant_id, status, detail_code, created_at, id);
-- list without reasonCode filter (status only), oldest first
create index if not exists review_items_by_status on review_items (tenant_id, status, created_at, id);

-- §3.8 migration map entries (CR-006 Z-5)
create table if not exists migration_map_entries (
  id uuid primary key,
  tenant_id uuid not null,
  upload_id uuid not null references uploads (id),
  entry_no integer not null,
  old_ref text not null,
  new_refs text[] not null,
  action text not null check (action in ('kept', 'merged', 'split')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- idempotent insert at split; entry order + cursor
create unique index if not exists migration_map_key on migration_map_entries (tenant_id, upload_id, entry_no);
-- ?action= filter and per-action counts
create index if not exists migration_map_by_action on migration_map_entries (tenant_id, upload_id, action, entry_no);

-- §3.9 vocabulary cache and legacy terms
create table if not exists vocabulary_cache (
  id uuid primary key,
  tenant_id uuid not null,
  version text not null,
  checksum text not null,
  content jsonb not null,
  status text not null check (status in ('active', 'superseded')),
  fetched_at timestamptz not null default now(),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- load a pinned version
create unique index if not exists vocabulary_cache_version on vocabulary_cache (tenant_id, version);
-- active release lookup
create unique index if not exists vocabulary_cache_active on vocabulary_cache (tenant_id) where status = 'active';

create table if not exists legacy_terms (
  tenant_id uuid not null,
  version text not null,
  field text not null,
  term_norm text not null,
  maps jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, version, field, term_norm)
);
