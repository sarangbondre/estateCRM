-- insight business schema (docs/04-lld/insight.md §3, INS-01): the PII-free analytics read model fed by the 64
-- subscribed events, rollups and daily facts, chat conversations (redacted text only), the query-plan catalogue,
-- exports and reference data (vocabulary release, micromarket hierarchy).
-- Conventions: every business table has tenant_id, created_at, updated_at and PK (tenant_id, id); every business index
-- starts with tenant_id (conventions §3). No contact PII anywhere: staff are user ids, people are pseudonymous ids.
-- Technical deviations (B3, recorded in the README):
--   * btree_gin is not installed: array filters use a plain GIN index, the tenant predicate is a recheck.
--   * per-producer aggregate versions live in rm_version (one row per aggregate and producer) instead of one column
--     per producer on every table.

-- 3.1 Read model: base tables ------------------------------------------------------------------------------------
create table if not exists rm_offer (
  tenant_id uuid not null,
  id uuid not null,                         -- records offer id
  code text,                                -- null while a stub (an event arrived before offer.created)
  property_id uuid,
  project_id uuid,
  deal_type text,
  market text,
  segment text,
  property_types text[] not null default '{}',
  property_type_primary text,
  bhk_min numeric(3,1),
  bhk_max numeric(3,1),
  area_sqft_min numeric(12,2),
  area_sqft_max numeric(12,2),
  area_basis text,
  land_area_sqft numeric(12,2),
  sale_price_inr_min bigint,
  sale_price_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  deposit_inr bigint,
  current_rent_inr bigint,
  locality text,
  micromarket text,
  city text,
  outside_launch_area boolean not null default false,
  tenancy_status text,
  sale_mode text,
  possession_status text,
  possession_date text,                     -- as stated ('YYYY', 'YYYY-MM', 'YYYY-MM-DD')
  possession_sort date,                     -- first day of the stated period
  furnishing text,
  unit_count integer,
  source_type text,
  owner_user_id uuid,
  sourced_for_demand_id uuid,
  contact_person_ids uuid[] not null default '{}',   -- pseudonymous ids, used only to fetch contacts at export time
  photo_count integer not null default 0,
  has_real_photos boolean not null default false,
  record_stage text,
  verified_at timestamptz,
  verified_by uuid,
  void_reason text,
  commercial_status text,
  closed_at timestamptz,
  closing_price_inr bigint,
  retired_reason text,
  life_stage text,
  life_day integer,
  last_confirmed_at timestamptz,
  confirmed_how text,
  publication_level text,
  public_id text,
  enquiry_count integer not null default 0,
  match_suggested_count integer not null default 0,
  match_confirmed_count integer not null default 0,
  merged_into_id uuid,
  created_at_src timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- codes in chat ("INV-00452") and action-card path params
create unique index if not exists rm_offer_code on rm_offer (tenant_id, code);
-- list/count offers by classification + locality (Appendix A Q1, Q2, Q9)
create index if not exists rm_offer_class on rm_offer (tenant_id, deal_type, segment, micromarket, commercial_status);
-- locality filter ("in Andheri West" when it is a locality)
create index if not exists rm_offer_locality on rm_offer (tenant_id, locality, deal_type);
-- "Public offers that turned Stale this week" (Q6); supply life-curve drill-down
create index if not exists rm_offer_life on rm_offer (tenant_id, life_stage, publication_level, updated_at);
-- "Upcoming offers available in the next 60 days" (Q12)
create index if not exists rm_offer_upcoming on rm_offer (tenant_id, commercial_status, possession_sort)
  where commercial_status = 'Upcoming';
-- "offers each supply agent verified this week" (Q10 drill-down)
create index if not exists rm_offer_verified on rm_offer (tenant_id, verified_by, verified_at);
-- offers of a property (photo.added / photo.removed adjust every offer of the property)
create index if not exists rm_offer_property on rm_offer (tenant_id, property_id);
-- project configurations
create index if not exists rm_offer_project on rm_offer (tenant_id, project_id) where project_id is not null;
-- "my offers"
create index if not exists rm_offer_owner on rm_offer (tenant_id, owner_user_id, commercial_status);
-- default list order + cursor
create index if not exists rm_offer_recent on rm_offer (tenant_id, created_at_src desc, id desc);
-- property_type filter (GIN; tenant as recheck)
create index if not exists rm_offer_types on rm_offer using gin (property_types);
-- source quality (share that verify / close) per source type
create index if not exists rm_offer_source on rm_offer (tenant_id, source_type, record_stage);

create table if not exists rm_demand (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  deal_types text[] not null default '{}',
  deal_type_primary text,
  market text,
  segment text,
  property_types text[] not null default '{}',
  property_type_primary text,
  bhk_min numeric(3,1),
  bhk_max numeric(3,1),
  area_sqft_min numeric(12,2),
  area_sqft_max numeric(12,2),
  area_basis text,
  budget_inr_min bigint,
  budget_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  micromarkets text[] not null default '{}',
  localities text[] not null default '{}',
  move_in_by date,
  stated_tags jsonb not null default '{}',
  outside_launch_area boolean not null default false,
  record_stage text,
  source_type text,                          -- first touch (C7)
  owner_user_id uuid,
  contact_person_ids uuid[] not null default '{}',
  commercial_status text,
  sourcing_since timestamptz,
  exit_type text,
  exit_reason text,
  revisit_date date,
  qualified_at timestamptz,
  life_stage text,
  life_day integer,
  last_confirmed_at timestamptz,
  publication_level text,
  touch_count integer not null default 0,
  match_suggested_count integer not null default 0,
  match_confirmed_count integer not null default 0,
  last_matching_at timestamptz,
  last_match_count integer,
  void_reason text,
  merged_into_id uuid,
  created_at_src timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create unique index if not exists rm_demand_code on rm_demand (tenant_id, code);
-- "demands in Sourcing > 7 days" (Q7)
create index if not exists rm_demand_sourcing on rm_demand (tenant_id, commercial_status, sourcing_since);
-- classification grid drill-down, open demand vs supply (Q3)
create index if not exists rm_demand_class on rm_demand (tenant_id, segment, deal_type_primary, commercial_status);
-- micromarket filter (GIN; tenant as recheck)
create index if not exists rm_demand_mm on rm_demand using gin (micromarkets);
create index if not exists rm_demand_localities on rm_demand using gin (localities);
-- "source type with most qualified demand last month" (Q8)
create index if not exists rm_demand_source on rm_demand (tenant_id, source_type, qualified_at);
-- "my" demand lists
create index if not exists rm_demand_owner on rm_demand (tenant_id, owner_user_id, commercial_status);
-- exits this month
create index if not exists rm_demand_exit on rm_demand (tenant_id, exit_type, updated_at);
-- default list order + cursor
create index if not exists rm_demand_recent on rm_demand (tenant_id, created_at_src desc, id desc);

create table if not exists rm_touch (
  tenant_id uuid not null,
  id uuid not null,
  demand_id uuid not null,
  source_type text,
  capture_mode text,
  is_first_touch boolean not null default false,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists rm_touch_demand on rm_touch (tenant_id, demand_id);
-- demand by source
create index if not exists rm_touch_source on rm_touch (tenant_id, source_type, occurred_at);

create table if not exists rm_enquiry (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  offer_id uuid,
  project_id uuid,
  demand_id uuid,
  campaign_ref text,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists rm_enquiry_offer on rm_enquiry (tenant_id, offer_id);
-- enquiries per period
create index if not exists rm_enquiry_received on rm_enquiry (tenant_id, received_at);

create table if not exists rm_match (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  demand_id uuid,
  offer_ids uuid[] not null default '{}',
  is_bundle boolean not null default false,
  score numeric(6,2),
  flags text[] not null default '{}',
  status text,                               -- Suggested / Confirmed / Rejected / Closed
  close_reason text,
  reject_reason text,
  suggested_at timestamptz,
  confirmed_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists rm_match_demand on rm_match (tenant_id, demand_id, status);
create index if not exists rm_match_offers on rm_match using gin (offer_ids);
-- "bundles suggested for office demand > 5,000 sq ft" (Q11, joined to rm_demand by id)
create index if not exists rm_match_bundles on rm_match (tenant_id, is_bundle, status, suggested_at);

create table if not exists rm_deal (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  demand_id uuid,
  offer_id uuid,
  status text not null default 'open',       -- open / closed / cancelled
  stage text,
  follow_up_date date,
  overdue boolean not null default false,
  owner_user_id uuid,                        -- the demand's owner at open time ("my follow-ups")
  opened_at timestamptz,
  closed_at timestamptz,
  closing_price_inr bigint,
  deal_type text,
  lease_months integer,
  units_booked integer,
  cancel_reason text,
  segment text,                              -- offer dimensions copied at apply time
  property_type_primary text,
  micromarket text,
  locality text,
  area_sqft numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists rm_deal_status on rm_deal (tenant_id, status, closed_at);
-- closed-price stats (Q4)
create index if not exists rm_deal_market on rm_deal (tenant_id, segment, micromarket, closed_at);
-- "In process with follow-up due"; "my follow-ups overdue" (Q5)
create index if not exists rm_deal_follow_up on rm_deal (tenant_id, status, follow_up_date);
create index if not exists rm_deal_owner on rm_deal (tenant_id, owner_user_id, status, follow_up_date);

create table if not exists rm_market_price (
  tenant_id uuid not null,
  id uuid not null,                          -- deal id (closed_by_us), offer id (retired_known), market data id
  source text not null,                      -- closed_by_us / retired_known / closed_elsewhere / reported
  offer_id uuid,
  deal_type text,
  segment text,
  property_type_primary text,
  micromarket text,
  locality text,
  area_sqft numeric(12,2),
  price_inr bigint,                          -- sale price
  rent_monthly_inr bigint,                   -- monthly rent (Lease)
  occurred_at timestamptz not null,
  void boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- avg / median price (Q4)
create index if not exists rm_market_price_stats
  on rm_market_price (tenant_id, deal_type, segment, property_type_primary, micromarket, occurred_at);
create index if not exists rm_market_price_mm on rm_market_price (tenant_id, micromarket, occurred_at);

create table if not exists rm_sourcing_request (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  demand_id uuid,
  assignee_user_id uuid,
  due_date date,
  priority text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- "Sourcing requests open"
create index if not exists rm_srq_status on rm_sourcing_request (tenant_id, status, due_date);
create index if not exists rm_srq_assignee on rm_sourcing_request (tenant_id, assignee_user_id, due_date);

create table if not exists rm_proposal (
  tenant_id uuid not null,
  id uuid not null,
  demand_id uuid,
  match_ids uuid[] not null default '{}',
  sent_at timestamptz,
  feedback jsonb not null default '{}',      -- matchId → verdict
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists rm_proposal_demand on rm_proposal (tenant_id, demand_id);
-- "Proposals out"
create index if not exists rm_proposal_sent on rm_proposal (tenant_id, sent_at);

create table if not exists rm_site_visit (
  tenant_id uuid not null,
  id uuid not null,
  demand_id uuid,
  offer_ids uuid[] not null default '{}',
  scheduled_for timestamptz,
  preferred_offer_id uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- "Site visits this week"
create index if not exists rm_site_visit_scheduled on rm_site_visit (tenant_id, scheduled_for);
create index if not exists rm_site_visit_completed on rm_site_visit (tenant_id, completed_at);

create table if not exists rm_call (
  tenant_id uuid not null,
  id uuid not null,
  subject_type text not null,
  subject_id uuid not null,
  outcome text not null,
  attempt integer,
  person_unreachable boolean not null default false,
  called_by uuid,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- calls per agent
create index if not exists rm_call_agent on rm_call (tenant_id, called_by, occurred_at);

create table if not exists rm_project (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  name text,                                 -- project name (public business data, not personal)
  rera_number text,
  locality text,
  micromarket text,
  city text,
  possession_date text,
  offer_ids uuid[] not null default '{}',
  latest_sheet_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create unique index if not exists rm_project_code on rm_project (tenant_id, code);
create index if not exists rm_project_mm on rm_project (tenant_id, micromarket);

create table if not exists rm_queue_counts (
  tenant_id uuid not null,
  user_id uuid not null,
  counts jsonb not null default '{}',        -- section → count (journeys LLD §4.3.1 section keys)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)           -- team queue tiles (SUM over users)
);

create table if not exists rm_user (
  tenant_id uuid not null,
  user_id uuid not null,
  role text not null,
  active boolean not null default true,      -- no name or e-mail: the UI resolves names via web
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index if not exists rm_user_role on rm_user (tenant_id, role, active);

create table if not exists rm_upload (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  mode text,
  source_type text,
  source_detail text,
  row_count integer,
  accepted integer,
  rejected integer,
  needs_review integer,
  unchanged integer,
  rejection_reasons jsonb not null default '{}',   -- error code → count
  status text not null default 'running',          -- running / completed / failed
  anonymised boolean not null default false,
  uploaded_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  fail_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- uploads per source, time since last upload
create index if not exists rm_upload_source on rm_upload (tenant_id, source_type, started_at);
create index if not exists rm_upload_recent on rm_upload (tenant_id, started_at desc, id desc);

create table if not exists rm_review_item (
  tenant_id uuid not null,
  id uuid not null,
  upload_id uuid,
  reason_code text,
  detail_code text,
  status text not null default 'open',       -- open / resolved
  action text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- review queue by review_reason
create index if not exists rm_review_item_status on rm_review_item (tenant_id, status, reason_code);

create table if not exists rm_merge_candidate (
  tenant_id uuid not null,
  id uuid not null,
  kind text not null,                        -- uncertain_merge / possible_repeat / price_gap
  aggregate_type text,
  raised_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- uncertain merges, price gaps
create index if not exists rm_merge_candidate_kind on rm_merge_candidate (tenant_id, kind, raised_at);

create table if not exists rm_row_stat (
  tenant_id uuid not null,
  id uuid not null,                          -- hash of (upload_id, record_scope, side, reason, needs_review, source_name, repeat)
  upload_id uuid not null,
  record_scope text,
  side text,
  review_reason_code text,
  needs_review boolean not null default false,
  source_name text,
  possible_repeat boolean not null default false,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists rm_row_stat_upload on rm_row_stat (tenant_id, upload_id);
-- side checks ("side_defaulted" per run), review by reason
create index if not exists rm_row_stat_reason on rm_row_stat (tenant_id, review_reason_code, created_at);

create table if not exists rm_desk_item (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  record_scope text,
  deal_types text[] not null default '{}',
  side text,
  sector text,
  participant_role text,
  linked_property_id uuid,
  status text not null default 'open',
  assignee_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- "Other scopes" dashboard
create index if not exists rm_desk_item_scope on rm_desk_item (tenant_id, record_scope, side, sector);
create index if not exists rm_desk_item_role on rm_desk_item (tenant_id, record_scope, participant_role);

create table if not exists rm_watchlist_item (
  tenant_id uuid not null,
  id uuid not null,
  code text,
  signal_type text,
  deadline_date date,
  task_open boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- "deadlines in 14 days"
create index if not exists rm_watchlist_deadline on rm_watchlist_item (tenant_id, deadline_date) where task_open;
create index if not exists rm_watchlist_signal on rm_watchlist_item (tenant_id, signal_type);

create table if not exists rm_person_flag (
  tenant_id uuid not null,
  id uuid not null,                          -- hash of (person_id, flag)
  person_id uuid not null,                   -- pseudonymous id, no person data
  flag text not null,
  active boolean not null default true,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists rm_person_flag_flag on rm_person_flag (tenant_id, flag, active, occurred_at);

-- Per-producer aggregate versions (LLD §4.10): an event whose aggregateVersion is ≤ the stored one is ignored.
create table if not exists rm_version (
  tenant_id uuid not null,
  aggregate_id uuid not null,
  producer text not null,
  version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, aggregate_id, producer)
);

-- 3.2 Rollups (dashboards ≤ 2 s at 5M records) ----------------------------------------------------------------------
create table if not exists rm_offer_rollup (
  tenant_id uuid not null,
  dims_hash text not null,                   -- md5 of the dimension tuple
  segment text,
  deal_type text,
  market text,
  property_type_primary text,
  micromarket text,
  owner_user_id uuid,
  source_type text,
  life_stage text,
  commercial_status text,
  record_stage text,
  publication_level text,
  outside_launch_area boolean,
  sale_mode text,
  tenancy_status text,
  n bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, dims_hash)         -- delta upsert
);
-- classification grids and dashboard filters
create index if not exists rm_offer_rollup_class on rm_offer_rollup (tenant_id, segment, deal_type, market);

create table if not exists rm_demand_rollup (
  tenant_id uuid not null,
  dims_hash text not null,
  segment text,
  deal_type_primary text,
  market text,
  property_type_primary text,
  micromarket text,                          -- first stated micromarket
  owner_user_id uuid,
  source_type text,
  life_stage text,
  commercial_status text,
  record_stage text,
  exit_type text,
  outside_launch_area boolean,
  n bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, dims_hash)
);
create index if not exists rm_demand_rollup_class on rm_demand_rollup (tenant_id, segment, deal_type_primary, market);

create table if not exists rm_daily_fact (
  tenant_id uuid not null,
  day date not null,                         -- IST business day
  metric text not null,
  dims_hash text not null,
  segment text,
  deal_type text,
  market text,
  source_type text,
  owner_user_id uuid,                        -- actor for offer_verified / calls_logged
  micromarket text,
  reason text,
  n bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day, metric, dims_hash)   -- delta upsert
);
-- a period SUM per tile
create index if not exists rm_daily_fact_metric on rm_daily_fact (tenant_id, metric, day);

create table if not exists rm_state (
  tenant_id uuid not null,
  last_event_at timestamptz,                 -- "data as of"
  lag_seconds integer,
  events_applied bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id)
);

-- 3.3 Chat ----------------------------------------------------------------------------------------------------------
create table if not exists conversation (
  tenant_id uuid not null,
  id uuid not null,
  code text not null,                        -- CONV-…
  user_id uuid not null,
  title text not null,                       -- PII-possible: redacted, never logged
  message_count integer not null default 0,
  last_message_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- sidebar list
create index if not exists conversation_sidebar on conversation (tenant_id, user_id, last_message_at desc, id desc)
  where deleted_at is null;
create unique index if not exists conversation_code on conversation (tenant_id, code);
-- purge job (deleted)
create index if not exists conversation_deleted on conversation (tenant_id, deleted_at) where deleted_at is not null;
-- purge job (retention: 180 days after the last message)
create index if not exists conversation_last on conversation (tenant_id, last_message_at);

create table if not exists message (
  tenant_id uuid not null,
  id uuid not null,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  redacted_text text not null,               -- PII-possible: placeholders only, never logged
  redaction_counts jsonb not null default '{}',
  plan jsonb,
  how_i_got_this jsonb,
  cards jsonb not null default '[]',         -- with placeholders, never rehydrated values
  outcome text,                              -- answered / action_proposed / clarify / refused / error
  fallback_used boolean not null default false,
  model text,
  timings jsonb,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- message list
create index if not exists message_list on message (tenant_id, conversation_id, created_at, id);
-- stream replay
create unique index if not exists message_idempotency on message (tenant_id, conversation_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists code_sequence (
  tenant_id uuid not null,
  prefix text not null check (prefix in ('CONV', 'EXP')),
  next_value bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, prefix)
);

-- The query-plan catalogue. Global rows use the nil tenant; they are synced from domain/plans/catalogue.ts.
create table if not exists plan_template (
  tenant_id uuid not null,
  plan_id text not null,
  version integer not null,
  kind text not null,
  description text not null,
  allowed_filters jsonb not null default '[]',
  allowed_group_by text[] not null default '{}',
  allowed_metrics text[] not null default '{}',
  allowed_sort text[] not null default '{}',
  base_table text not null,
  max_rows integer not null,
  roles text[] not null default '{}',
  enabled boolean not null default true,
  catalogue_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, plan_id, version)
);
create index if not exists plan_template_enabled on plan_template (tenant_id, enabled);

-- 3.4 Exports and plumbing ------------------------------------------------------------------------------------------
create table if not exists export_job (
  tenant_id uuid not null,
  id uuid not null,
  code text not null,                        -- EXP-…
  requested_by uuid not null,
  requester_role text not null,
  plan jsonb not null,
  include_contacts boolean not null default false,
  file_name text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'expired')),
  estimated_rows integer,
  row_count integer,
  file_path text,
  file_bytes bigint,
  source_message_id uuid,
  attempts integer not null default 0,
  error_code text,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- GET /v1/exports (own) and the 10-per-hour check
create index if not exists export_job_mine on export_job (tenant_id, requested_by, created_at desc, id desc);
-- Admin list
create index if not exists export_job_all on export_job (tenant_id, created_at desc, id desc);
create unique index if not exists export_job_code on export_job (tenant_id, code);
-- export-expire
create index if not exists export_job_expire on export_job (tenant_id, status, expires_at) where status = 'completed';
-- export-expire across tenants (the job scans by expiry first)
create index if not exists export_job_expiry_scan on export_job (expires_at) where status = 'completed';

create table if not exists hf_usage (
  tenant_id uuid not null,
  day date not null,
  calls integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  errors integer not null default 0,
  timeouts integer not null default 0,
  credits_exhausted_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day)
);

-- Active controlled-vocabulary release fetched from records (vocabulary-refresh); libs/vocabulary is the fallback.
create table if not exists vocabulary_release (
  tenant_id uuid not null,
  version text not null,
  checksum text,
  content jsonb not null,                    -- the VocabularyRelease document (fields → values, legacy terms)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, version)
);
create unique index if not exists vocabulary_release_active on vocabulary_release (tenant_id) where active;

-- Micromarket hierarchy with aliases (records reference data, R-13), for resolving locality names in questions.
create table if not exists micromarket_ref (
  tenant_id uuid not null,
  id uuid not null,
  parent_id uuid,
  level text not null,                       -- zone / micromarket / locality / sub_locality
  name text not null,
  aliases text[] not null default '{}',
  city text,
  in_launch_area boolean not null default true,
  tree_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists micromarket_ref_level on micromarket_ref (tenant_id, level, name);

create table if not exists job_checkpoint (
  tenant_id uuid not null,
  job text not null,
  cursor text,
  run_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, job)
);
