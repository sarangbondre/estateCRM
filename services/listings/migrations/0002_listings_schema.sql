-- listings business schema (docs/04-lld/listings.md §3). The runner sets search_path to the listings schema.
-- Every business table: tenant_id first in every index (conventions §3). Technical exceptions are marked (R-4).
-- PII: listings stores no contact PII. Sensitive columns are marked -- PII-possible / -- sensitive (LLD §7).

-- Level order used by the "ceiling below level" health index and queries (Private < Anonymous < Public).
create or replace function level_rank(level text) returns integer
  language sql immutable parallel safe
  as $$ select case level when 'Public' then 2 when 'Anonymous' then 1 else 0 end $$;

-- 3.1 Ceiling inputs (projections fed by events) ------------------------------------------------------------------
create table if not exists offer_input (
  tenant_id uuid not null,
  id uuid not null,                              -- = records offerId
  code text not null,
  property_id uuid not null,
  project_id uuid,
  deal_type text not null,
  market text,
  segment text,
  property_types text[] not null default '{}',
  bhk_min numeric(3,1),
  bhk_max numeric(3,1),
  area_sqft_min numeric(12,2),
  area_sqft_max numeric(12,2),
  area_basis text,
  land_area_sqft numeric(14,2),
  sale_price_inr_min bigint,
  sale_price_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,                   -- deposit and current rent are never stored (not public)
  locality text,
  micromarket text,
  city text,
  outside_launch_area boolean not null default false,
  tenancy_status text,
  sale_mode text,
  possession_status text,
  furnishing text,
  possession_date text,                          -- YYYY, YYYY-MM or YYYY-MM-DD
  unit_count integer,
  floor_band text,                               -- Low / Mid / High (the exact floor never reaches listings)
  total_floors integer,
  parking integer,
  amenities text[] not null default '{}',
  selected_photo_ids uuid[] not null default '{}',
  public_description_source text,                -- reference only, never fetched (OQ-L4)
  voided_reason text,
  record_stage text,
  has_real_photos boolean not null default false,
  commercial_status text,
  life_stage text,
  life_day integer,
  retired_reason text,
  merged_into_id uuid,
  records_version integer not null default 0,
  journeys_version integer not null default 0,
  scan_terms_fetched_at timestamptz,             -- private_term cache freshness for this offer's property
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (tenant_id, id)
);
create unique index if not exists offer_input_code on offer_input (tenant_id, code);
create index if not exists offer_input_project on offer_input (tenant_id, project_id) where project_id is not null;
create index if not exists offer_input_property on offer_input (tenant_id, property_id);

create table if not exists project_input (
  tenant_id uuid not null,
  id uuid not null,                              -- = records projectId
  code text not null,
  name text not null,                            -- project marketing name (public by nature)
  developer_person_id uuid,
  developer_name text,                           -- business name, not contact PII
  city text,
  micromarket text,
  locality text,
  rera_number text,
  possession_date text,
  amenities text[] not null default '{}',
  offer_ids uuid[] not null default '{}',
  records_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (tenant_id, id)
);
create unique index if not exists project_input_code on project_input (tenant_id, code);

create table if not exists demand_input (
  tenant_id uuid not null,
  id uuid not null,                              -- = records demandId
  code text not null,
  deal_types text[] not null default '{}',
  market text,
  segment text,
  property_types text[] not null default '{}',
  micromarkets text[] not null default '{}',
  area_sqft_min numeric(12,2),
  area_sqft_max numeric(12,2),
  area_basis text,
  budget_inr_min bigint,
  budget_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  move_in_by text,
  outside_launch_area boolean not null default false,
  commercial_status text,                        -- demand status from journeys (Sourcing, …)
  life_stage text,
  exit_type text,                                -- Lost / Dormant / Invalid
  matched boolean not null default false,        -- match.confirmed.v1 for this demand
  post_requested boolean not null default false,
  sourcing_request_id uuid,
  voided_reason text,
  merged_into_id uuid,
  records_version integer not null default 0,
  journeys_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (tenant_id, id)
);
create unique index if not exists demand_input_code on demand_input (tenant_id, code);

-- 3.2 Publication state -------------------------------------------------------------------------------------------
create table if not exists publication (
  tenant_id uuid not null,
  id uuid not null,
  subject_type text not null check (subject_type in ('offer', 'project', 'demand_post')),
  subject_id uuid not null,
  level text not null default 'Private' check (level in ('Private', 'Anonymous', 'Public')),
  ceiling text not null default 'Private' check (ceiling in ('Private', 'Anonymous', 'Public')),
  ceiling_reasons text[] not null default '{}',
  life_stage text,
  public_id text,                                -- L- + 10 Crockford base32; never reused for another subject
  public_description text,                       -- PII-possible: staff free text, blocked by the scan, never logged
  description_source text not null default 'generated' check (description_source in ('generated', 'staff')),
  last_scan_id uuid,
  last_change_reason text,
  last_changed_by uuid,
  published_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create unique index if not exists publication_subject on publication (tenant_id, subject_type, subject_id);
create unique index if not exists publication_public_id on publication (tenant_id, public_id) where public_id is not null;
create index if not exists publication_by_level on publication (tenant_id, level, updated_at desc, id desc);
create index if not exists publication_by_type on publication (tenant_id, subject_type, updated_at desc, id desc);
create index if not exists publication_life on publication (tenant_id, life_stage, level);
create index if not exists publication_ceiling_below on publication (tenant_id, id)
  where level_rank(level) > level_rank(ceiling);
-- ceiling-sweep job: every publication above Private across tenants, by id (job path; documented exception like R-4)
create index if not exists publication_sweep on publication (id) where level <> 'Private';

-- 3.3 Sanitised public projection (the only table the public API reads) --------------------------------------------
create table if not exists public_item (
  tenant_id uuid not null,
  id uuid not null,                              -- = publication.id
  public_id text not null,
  subject_type text not null check (subject_type in ('listing', 'project', 'demand_post')),
  level text not null check (level in ('Anonymous', 'Public')),
  payload jsonb not null,                        -- the exact public JSON (field allow-list)
  payload_hash text not null,                    -- SHA-256 hex: decides whether a change is an `updated` feed row
  deal_type text,
  deal_types text[],
  market text,
  segment text,
  city text,
  micromarket text,
  locality text,
  micromarket_path text[] not null default '{}',
  property_types text[] not null default '{}',
  bhk_min numeric(3,1),
  bhk_max numeric(3,1),
  area_sqft_min numeric(12,2),
  area_sqft_max numeric(12,2),
  sale_price_inr_min bigint,
  rent_monthly_inr_min bigint,
  price_sort_inr bigint,
  possession_sort date,
  sale_mode text,
  tenancy_status text,
  furnishing text,
  project_public_id text,
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create unique index if not exists public_item_public_id on public_item (tenant_id, public_id);
create index if not exists public_item_newest on public_item (tenant_id, subject_type, published_at desc, id desc);
create index if not exists public_item_deal_segment
  on public_item (tenant_id, subject_type, deal_type, segment, published_at desc, id desc);
create index if not exists public_item_price on public_item (tenant_id, subject_type, deal_type, price_sort_inr, id);
create index if not exists public_item_property_types on public_item using gin (tenant_id, property_types);
create index if not exists public_item_micromarket_path on public_item using gin (tenant_id, micromarket_path);
create index if not exists public_item_city on public_item (tenant_id, subject_type, city, published_at desc, id desc);
create index if not exists public_item_project on public_item (tenant_id, project_public_id)
  where project_public_id is not null;

create table if not exists change_feed (
  tenant_id uuid not null,
  id uuid not null,
  seq bigint generated always as identity,
  public_id text not null,
  subject_type text not null check (subject_type in ('listing', 'project', 'demand_post')),
  change_type text not null check (change_type in ('published', 'updated', 'upgraded', 'downgraded', 'withdrawn')),
  level text check (level in ('Anonymous', 'Public')),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create unique index if not exists change_feed_seq on change_feed (tenant_id, seq);
create index if not exists change_feed_time on change_feed (tenant_id, occurred_at, seq);
-- change-feed-prune job: rows older than 30 days across tenants (job path; documented exception like R-4)
create index if not exists change_feed_prune on change_feed (occurred_at);

-- 3.4 Photos, private terms, scans ---------------------------------------------------------------------------------
create table if not exists photo (
  tenant_id uuid not null,
  id uuid not null,                              -- = records photoId
  property_id uuid not null,
  origin text not null,
  is_real boolean not null default false,
  source_storage_path text not null,             -- records bucket path (never public)
  has_text_detected boolean,                     -- from records; warning only (R-8)
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed', 'removed')),
  private_path text,                             -- listings-photos bucket (sanitised copy)
  public_path text,                              -- listings-public bucket, only while used by a Public item
  public_name text,                              -- random, never the photo id
  width integer,
  height integer,
  sort_order integer not null default 0,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (tenant_id, id)
);
create index if not exists photo_property on photo (tenant_id, property_id, sort_order);
create index if not exists photo_pending on photo (tenant_id, status, created_at) where status = 'pending';

create table if not exists private_term (
  tenant_id uuid not null,
  id uuid not null,
  property_id uuid not null,
  kind text not null check (kind in ('building', 'society', 'wing', 'unit')),
  token_hash text not null,                      -- sensitive: HMAC-SHA-256 hex from records scan-terms (R-20); never logged
  ngram smallint not null default 1,
  salt_key_id text not null,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists private_term_property on private_term (tenant_id, property_id);
create index if not exists private_term_hash on private_term (tenant_id, token_hash);

create table if not exists privacy_scan (
  tenant_id uuid not null,
  id uuid not null,
  subject_type text not null,
  subject_id uuid not null,
  text_sha256 text not null,
  rules_version text not null,
  result text not null check (result in ('pass', 'warning', 'blocked')),
  findings jsonb not null default '[]',          -- kinds and offsets only, never the matched text
  scanned_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists privacy_scan_latest on privacy_scan (tenant_id, subject_type, subject_id, created_at desc);

-- 3.5 Settings, API keys, rate limits -----------------------------------------------------------------------------
create table if not exists settings (
  tenant_id uuid not null,
  id uuid not null,
  maharera_agent_number text,                    -- null until set (pilot: "registration pending", questionnaire A7)
  subject_to_confirmation_note text not null default 'Details subject to confirmation',
  version integer not null default 1,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create unique index if not exists settings_tenant on settings (tenant_id);

create table if not exists api_key (
  tenant_id uuid not null,
  id uuid not null,
  name text not null,
  prefix text not null,
  key_hash text not null,                        -- sensitive: hashApiKey(secret); the plaintext is never stored
  status text not null default 'active' check (status in ('active', 'rotating', 'revoked')),
  rate_limit_rps integer not null default 50 check (rate_limit_rps between 1 and 50),
  burst integer not null default 100 check (burst between 1 and 100),
  allowed_origins text[] not null default '{}',
  grace_ends_at timestamptz,
  replaced_by_key_id uuid,
  last_used_at timestamptz,
  created_by uuid not null,
  revoked_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- the tenant is unknown until the key resolves: documented exception to tenant-first (LLD §3.5)
create unique index if not exists api_key_hash on api_key (key_hash);
create index if not exists api_key_list on api_key (tenant_id, created_at desc, id desc);
create index if not exists api_key_rotating on api_key (tenant_id, status, grace_ends_at) where status = 'rotating';
-- api-key-expire job across tenants (job path; documented exception like R-4)
create index if not exists api_key_grace on api_key (grace_ends_at) where status = 'rotating';

create table if not exists rate_limit_bucket (
  api_key_id uuid primary key,                   -- technical table (libs-style token bucket, R-1)
  tenant_id uuid not null,
  tokens numeric not null,
  refilled_at timestamptz not null
);
create index if not exists rate_limit_bucket_refilled on rate_limit_bucket (refilled_at);

-- 3.6 Plumbing ------------------------------------------------------------------------------------------------------
create table if not exists merge_log (
  tenant_id uuid not null,
  id uuid not null,
  merge_id uuid not null,
  subject_type text not null,
  subject_id uuid not null,
  prior jsonb not null,                          -- publication level/public id before the merge (no PII)
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists merge_log_merge on merge_log (tenant_id, merge_id);

create table if not exists vocabulary_release (
  tenant_id uuid not null,
  id uuid not null,
  version text not null,
  checksum text not null,
  "values" jsonb not null default '{}',
  micromarkets jsonb not null default '{}',      -- name → ancestor names (micromarket hierarchy, R-13)
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (tenant_id, id)
);
create unique index if not exists vocabulary_release_version on vocabulary_release (tenant_id, version);
create unique index if not exists vocabulary_release_active on vocabulary_release (tenant_id) where active;

-- resumable job cursors (technical table: jobs run across tenants)
create table if not exists job_checkpoint (
  name text primary key,
  cursor jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
