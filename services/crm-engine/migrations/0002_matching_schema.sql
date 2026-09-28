-- crm-engine business schema (docs/04-lld/crm-engine.md §3). PII-free by design: no names, phones, emails, building
-- names, wing/unit/floor or free text in any column (a schema test enforces the deny-list, LLD §7).
--
-- Index note (technical, B3): the LLD's composite GIN candidate indexes need btree_gin, which the service owner role
-- cannot install (no CREATE on the database). The candidate lookups instead use one text[] column `match_keys` per
-- projection row holding "<tenant>|<segment>|<deal_type>|<micromarket node>" keys, indexed with a plain GIN index. The
-- tenant is the first component of every key, so the tenant-first rule (conventions §3) still holds.

-- 3.1 Display codes -------------------------------------------------------------------------------------------------
create table if not exists code_sequences (
  tenant_id uuid not null,
  prefix text not null check (prefix in ('MAT', 'BND')),
  next_value bigint not null default 1,
  primary key (tenant_id, prefix)
);

-- 3.2 Matchable projection (PII-free) ---------------------------------------------------------------------------------
create table if not exists offer_mx (
  id uuid primary key,                           -- = records offer id
  tenant_id uuid not null,
  code text not null,
  property_id uuid not null,
  project_id uuid,
  building_key text,                             -- opaque hash of building identity, never the building name
  deal_type text not null,
  market text,
  segment text,
  property_types text[] not null default '{}',
  bhk_min numeric(3,1),
  bhk_max numeric(3,1),
  area_sqft_min numeric,
  area_sqft_max numeric,
  area_basis text,
  land_area_sqft numeric,
  sale_price_inr_min bigint,
  sale_price_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  deposit_inr bigint,
  current_rent_inr bigint,
  price_key bigint,                              -- Sale/Pagdi/JV: sale price (min, else max); Lease: rent (min, else max)
  micromarket text,
  locality text,
  mm_path text[] not null default '{}',          -- node keys: most specific node + ancestors up to micromarket level
  zone text,
  outside_launch_area boolean not null default false,
  tenancy_status text,
  sale_mode text,
  possession_status text,
  possession_date_raw text,
  tenure text,
  agreement_form text,
  is_jodi boolean,
  parking int,
  amenities text[] not null default '{}',
  floor_band text,
  total_floors int,
  price_sheet_date date,
  last_seen_date date,
  available_from date,                           -- period start ('2027-02' -> 2027-02-01); null = Ready / unknown
  available_to date,                             -- period end ('2027-02' -> 2027-02-28)
  furnishing text,
  unit_count int,
  record_stage text,
  life_stage text not null default 'Fresh',
  commercial_status text not null default 'Available',
  voided boolean not null default false,
  merged_into uuid,
  match_keys text[] not null default '{}',       -- candidate keys (see index note above)
  is_matchable boolean generated always as (
    not outside_launch_area and life_stage <> 'Expired' and commercial_status not in ('Closed', 'Inactive')
    and merged_into is null and not voided) stored,
  facts_version int not null default 0,
  price_version int not null default 0,
  life_version int not null default 0,
  commercial_version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- {idOrCode} resolution
create unique index if not exists offer_mx_code on offer_mx (tenant_id, code);
-- Demand-side candidates: match_keys && $keys (tenant|segment|deal_type|node) where is_matchable
create index if not exists offer_mx_candidates on offer_mx using gin (match_keys) where is_matchable;
-- Candidate narrowing when the GIN query hits the 5,000 cap: price_key <= budget × (1 + priceOverBudgetZeroPct)
create index if not exists offer_mx_price on offer_mx (tenant_id, segment, deal_type, price_key) where is_matchable;
-- Bundle finder: largest candidate offers per micromarket
create index if not exists offer_mx_bundle on offer_mx (tenant_id, segment, micromarket, deal_type, area_sqft_max desc)
  where is_matchable;
-- Same-building bundles
create index if not exists offer_mx_building on offer_mx (tenant_id, building_key)
  where building_key is not null and is_matchable;
-- Exclusions for Expired / Inactive offers that would otherwise match (LLD §4.1 row 3), bounded per demand
create index if not exists offer_mx_unlive on offer_mx using gin (match_keys)
  where not is_matchable and not voided and merged_into is null and not outside_launch_area;
-- Keyset batches (micromarket-refresh recompute, projection-reconcile)
create index if not exists offer_mx_keyset on offer_mx (tenant_id, id);
-- Retention: rows merged away (deleted 30 days after merged_into is set)
create index if not exists offer_mx_merged on offer_mx (tenant_id, updated_at) where merged_into is not null;

create table if not exists demand_mx (
  id uuid primary key,                           -- = records demand id
  tenant_id uuid not null,
  code text not null,
  deal_types text[] not null,
  market text,
  segment text,
  property_types text[] not null default '{}',
  bhk_min numeric(3,1),
  bhk_max numeric(3,1),
  area_sqft_min numeric,
  area_sqft_max numeric,
  area_basis text,
  budget_inr_min bigint,
  budget_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  micromarkets text[] not null default '{}',
  localities text[] not null default '{}',
  mm_expanded text[] not null default '{}',      -- listed nodes + descendants + parent micromarket of listed localities
  move_in_from date,
  move_in_by date,
  stated_tags jsonb not null default '{}',       -- controlled values only (tenancy_status, sale_mode, furnishing, ...)
  outside_launch_area boolean not null default false,
  record_stage text,
  qualified boolean not null default false,
  owner_user_id uuid,                            -- staff user id, not contact PII
  life_stage text not null default 'Fresh',
  commercial_status text not null default 'New',
  exit_type text,
  voided boolean not null default false,
  merged_into uuid,
  match_keys text[] not null default '{}',
  is_matchable boolean generated always as (
    not outside_launch_area and exit_type is null and commercial_status <> 'Closed'
    and life_stage not in ('Expired', 'Paused') and merged_into is null and not voided) stored,
  accepts_new boolean generated always as (
    not outside_launch_area and exit_type is null and commercial_status <> 'Closed'
    and life_stage not in ('Stale', 'Expired', 'Paused') and merged_into is null and not voided) stored,
  facts_version int not null default 0,
  life_version int not null default 0,
  status_version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- {idOrCode} resolution
create unique index if not exists demand_mx_code on demand_mx (tenant_id, code);
-- Offer-side candidates: match_keys && $keys where is_matchable
create index if not exists demand_mx_candidates on demand_mx using gin (match_keys) where is_matchable;
-- Nightly time-sensitive re-score (move_in_by <= today + 90)
create index if not exists demand_mx_time on demand_mx (tenant_id, move_in_by, id)
  where is_matchable and move_in_by is not null;
-- Full re-score keyset batches over live demands
create index if not exists demand_mx_keyset on demand_mx (tenant_id, id) where is_matchable;
-- Keyset batches over every row (micromarket-refresh recompute, projection-reconcile)
create index if not exists demand_mx_all on demand_mx (tenant_id, id);
-- Retention: rows merged away
create index if not exists demand_mx_merged on demand_mx (tenant_id, updated_at) where merged_into is not null;

create table if not exists micromarket_nodes (   -- copy of records' hierarchy (reference data, no PII)
  id uuid primary key,                           -- = records micromarket id
  tenant_id uuid not null,
  node_key text not null,                        -- = records micromarket id as text (stable across renames)
  level text not null check (level in ('zone', 'micromarket', 'locality', 'sub_locality')),
  name text not null,                            -- place name (reference data, not personal data)
  name_keys text[] not null default '{}',        -- R-11 match keys of the name and its aliases
  parent_key text,
  path text[] not null,                          -- ancestors incl. self, most specific first
  adjacent_keys text[] not null default '{}',    -- Admin-maintained adjacency (R-13)
  in_launch_area boolean not null default true,
  release_version integer not null,              -- micromarkets.updated.v1 version
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Hierarchy lookups (the whole tenant tree is cached in memory per reference_state.mm_version)
create unique index if not exists mm_nodes_key on micromarket_nodes (tenant_id, node_key);

create table if not exists reference_state (     -- cache key for the in-memory hierarchy; pending refresh marker
  tenant_id uuid primary key,
  mm_version integer not null default 0,
  mm_loaded_at timestamptz,
  mm_requested_version integer,
  vocabulary_version text,
  updated_at timestamptz not null default now()
);

create table if not exists vocabulary_cache (
  id uuid primary key,
  tenant_id uuid not null,
  version text not null,
  checksum text not null,
  body jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, version)
);

-- 3.3 Matching state ----------------------------------------------------------------------------------------------------
create table if not exists matches (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  demand_id uuid not null,
  offer_ids uuid[] not null,                     -- sorted ascending
  offer_set_key text not null,                   -- sorted ids joined with ','
  is_bundle boolean not null default false,
  bundle_id uuid,
  score smallint not null check (score between 0 and 100),
  rank smallint,
  factors jsonb not null,                        -- [{factor, weight, value, points, applicable, note}]
  flags text[] not null default '{}',
  status text not null check (status in ('Suggested', 'Confirmed', 'Rejected', 'Closed')),
  closed_reason text,
  closed_by_deal_id uuid,
  prior_status text,                             -- for reopen / compensation (deal cancelled)
  rejected_reason text,
  rejected_score smallint,
  rejected_facts_version int,
  origin text not null check (origin in ('engine', 'user')),
  weights_version int not null,
  confirmed_by uuid,                             -- staff user id
  confirmed_at timestamptz,
  open_deal_id uuid,                             -- deal.opened.v1 on this pair (reject guard, match-in-deal)
  proposal_sent_at timestamptz,                  -- proposal.sent.v1 (M6 funnel)
  visited_at timestamptz,                        -- site_visit.completed.v1 (M6 funnel)
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- /v1/matches/{idOrCode}
create unique index if not exists matches_code on matches (tenant_id, code);
-- Upsert target for a (demand, offer set) pair
create unique index if not exists matches_pair on matches (tenant_id, demand_id, offer_set_key);
-- GET /v1/demands/{id}/matches (status filter, score order); top-N maintenance; demand exit/close
create index if not exists matches_demand on matches (tenant_id, demand_id, status, score desc, id);
-- deal.cancelled.v1 -> reopen matches closed by that deal
create index if not exists matches_deal on matches (tenant_id, closed_by_deal_id) where closed_by_deal_id is not null;
-- /internal/v1/matches rebuild feed (updatedAt, id)
create index if not exists matches_updated on matches (tenant_id, updated_at, id);
-- Retention: Rejected / Closed matches 24 months after closing
create index if not exists matches_retention on matches (tenant_id, updated_at) where status in ('Rejected', 'Closed');

create table if not exists match_offers (       -- one row per offer in a match (single: 1, bundle: 2-3)
  id uuid primary key,
  tenant_id uuid not null,
  match_id uuid not null references matches (id) on delete cascade,
  offer_id uuid not null,
  demand_id uuid not null,
  status text not null,                          -- denormalised from matches for filtering
  score smallint not null default 0,             -- denormalised from matches for the offer-side list order
  unique (tenant_id, match_id, offer_id)
);
-- GET /v1/offers/{id}/matches; close/flag propagation when an offer changes
create index if not exists match_offers_offer on match_offers (tenant_id, offer_id, status, match_id);
-- GET /v1/offers/{id}/matches order (score desc, id)
create index if not exists match_offers_offer_score on match_offers (tenant_id, offer_id, score desc, match_id);
-- match_offers_match: the unique constraint (tenant_id, match_id, offer_id) loads the offers of a match

create table if not exists bundles (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  demand_id uuid not null,
  offer_ids uuid[] not null,
  grouping text not null check (grouping in ('same_building', 'same_micromarket', 'adjacent_micromarket')),
  combined_area_sqft numeric not null,
  combined_price_inr bigint,
  combined_rent_monthly_inr bigint,
  origin text not null check (origin in ('engine', 'user')),
  created_by uuid,                               -- staff user id
  match_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- GET /v1/bundles/{idOrCode}
create unique index if not exists bundles_code on bundles (tenant_id, code);
-- Existing-bundle check per demand
create index if not exists bundles_demand on bundles (tenant_id, demand_id);

create table if not exists exclusions (
  id uuid primary key,
  tenant_id uuid not null,
  demand_id uuid not null,
  offer_id uuid not null,
  reason text not null check (reason in ('available_too_late', 'offer_expired', 'offer_inactive', 'demand_stale')),
  available_from date,
  move_in_by date,
  computed_at timestamptz not null,
  unique (tenant_id, demand_id, offer_id)
);
-- GET /v1/demands/{id}/exclusions (computedAt desc, id)
create index if not exists exclusions_demand on exclusions (tenant_id, demand_id, computed_at desc, id);
-- Clear exclusions when an offer's date or status changes
create index if not exists exclusions_offer on exclusions (tenant_id, offer_id);
-- Retention: rows older than 90 days without refresh
create index if not exists exclusions_computed on exclusions (tenant_id, computed_at);

create table if not exists feedback (            -- M6: share of suggestions confirmed; weight-tuning input
  id uuid primary key,
  tenant_id uuid not null,
  match_id uuid not null,
  demand_id uuid not null,
  action text not null check (action in ('confirmed', 'rejected', 'client_liked', 'client_rejected',
    'client_visit_requested')),
  source text not null check (source in ('staff', 'proposal')),
  reason_code text,                              -- code only, no free text
  score smallint not null,
  factors jsonb not null,
  weights_version int not null,
  by_user uuid not null,                         -- staff user id (system actor for proposal feedback)
  at timestamptz not null
);
-- Feedback history per match
create index if not exists feedback_match on feedback (tenant_id, match_id, at);
-- M6 reporting by period; retention (24 months)
create index if not exists feedback_at on feedback (tenant_id, at);

create table if not exists weights (
  id uuid primary key,
  tenant_id uuid not null,
  version int not null,
  body jsonb not null,                           -- Weights schema (factors + tuning)
  active boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, version)
);
-- Current weights
create unique index if not exists weights_active on weights (tenant_id) where active;

create table if not exists matching_runs (
  id uuid primary key,
  tenant_id uuid not null,
  scope text not null check (scope in ('demand', 'offer', 'full')),
  subject_id uuid,
  trigger text not null,
  status text not null check (status in ('queued', 'running', 'done', 'failed')),
  candidates int,
  suggested int,
  closed int,
  excluded int,
  error text,
  requested_by uuid,                             -- staff user id
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- Idempotent re-run (existing queued/running run for the subject)
create index if not exists runs_subject on matching_runs (tenant_id, subject_id, created_at desc);
-- Retention: 30 days
create index if not exists runs_created on matching_runs (tenant_id, created_at);

create table if not exists rescore_pending (     -- dedupes work before it is sent to pgmq q_crm_engine_rescore
  id uuid primary key,
  tenant_id uuid not null,
  subject_type text not null check (subject_type in ('offer', 'demand')),
  subject_id uuid not null,
  reasons text[] not null,
  run_id uuid,
  enqueued_at timestamptz not null
);
-- Dedupe dirty subjects
create unique index if not exists rescore_pending_subject on rescore_pending (tenant_id, subject_type, subject_id);

create table if not exists deals (               -- journeys deals seen through events (reject guard, close propagation)
  id uuid primary key,                           -- = journeys deal id
  tenant_id uuid not null,
  demand_id uuid not null,
  offer_id uuid not null,
  status text not null check (status in ('open', 'closed', 'cancelled')),
  units_booked int,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Latest closed deal on an offer (offer close -> closed_by_deal_id); open deal on a pair
create index if not exists deals_offer on deals (tenant_id, offer_id, status, closed_at desc);
-- Latest closed deal of a demand (demand Closed -> closed_by_deal_id)
create index if not exists deals_demand on deals (tenant_id, demand_id, status, closed_at desc);

-- 3.4 Infrastructure tables (journeys LLD §3.4) -------------------------------------------------------------------
create table if not exists aggregate_versions (  -- monotonic aggregateVersion per produced aggregate (match, demand)
  id uuid primary key,
  tenant_id uuid not null,
  aggregate_type text not null,
  version int not null
);

create table if not exists job_runs (
  id uuid primary key,
  tenant_id uuid,
  job text not null,
  run_date date not null,
  cursor text,
  processed int not null default 0,
  done boolean not null default false,
  started_at timestamptz not null,
  finished_at timestamptz
);
-- One run per job, date and tenant (null tenant = all tenants)
create unique index if not exists job_runs_key on job_runs (job, run_date, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists merge_log (           -- before-images for records.merge_undone.v1
  id uuid primary key,
  tenant_id uuid not null,
  merge_id uuid not null,
  table_name text not null,
  row_id uuid not null,
  before jsonb not null,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);
-- Undo a merge
create index if not exists merge_log_merge on merge_log (tenant_id, merge_id);
