-- journeys business schema (docs/04-lld/journeys.md §3, JOU-01).
-- Every business table has tenant_id, created_at, updated_at; mutable aggregates have version. Every business index
-- starts with tenant_id (conventions §3). Business dates are IST dates; times are timestamptz (UTC).
-- Deviations (technical, B3): btree_gin is not installed, so the few array lookups use junction tables
-- (match_offers) or a plain GIN on the array with tenant_id as a recheck predicate (visits_offer, demand_view_cell).

-- 3.1 Code sequences -------------------------------------------------------------------------------------------
create table if not exists code_sequences (
  tenant_id uuid not null,
  prefix text not null check (prefix in ('SRQ', 'PROP', 'VIS', 'DEAL', 'CALL')),
  next_value bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, prefix)          -- sequence rows, not entities (LLD §3.1)
);

-- 3.2 Local projections --------------------------------------------------------------------------------------------
create table if not exists offer_view (
  id uuid primary key,                     -- records offer id
  tenant_id uuid not null,
  code text not null,
  property_id uuid not null,
  project_id uuid,
  deal_type text not null,
  market text,
  segment text,
  property_types text[] not null default '{}',
  micromarket text,
  locality text,
  city text,
  outside_launch_area boolean not null default false,
  possession_status text,
  possession_date_raw text,                -- 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'
  available_from date,                     -- first day of the stated period (JA-8)
  sale_price_inr_min bigint,
  sale_price_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  area_sqft_min numeric,
  area_sqft_max numeric,
  unit_count integer,
  record_stage text not null default 'Enriched',
  has_real_photos boolean not null default false,
  source_type text,
  sourced_for_demand_id uuid,
  owner_user_id uuid,
  publication_level text not null default 'Private',
  price_sheet_date date,
  contact_person_ids uuid[] not null default '{}',   -- pseudonymous person ids
  captured_on date not null,
  last_seen_on date not null,
  voided boolean not null default false,
  publication_version integer not null default 0,
  facts_version integer not null default 0,
  stage_version integer not null default 0,
  merged_into uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- {idOrCode} resolution
create unique index if not exists offer_view_code on offer_view (tenant_id, code);
-- enquiry on a project → its oldest live configuration (JA-7); price sheet → configurations
create index if not exists offer_view_project on offer_view (tenant_id, project_id, captured_on, id) where project_id is not null;
-- demand gap / supply count per cell
create index if not exists offer_view_cell on offer_view (tenant_id, segment, deal_type, micromarket);

create table if not exists demand_view (
  id uuid primary key,                     -- records demand id
  tenant_id uuid not null,
  code text not null,
  deal_types text[] not null,
  market text,
  segment text,
  property_types text[] not null default '{}',
  micromarkets text[] not null default '{}',
  localities text[] not null default '{}',
  budget_inr_min bigint,
  budget_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  area_sqft_min numeric,
  area_sqft_max numeric,
  move_in_from date,
  move_in_by date,
  outside_launch_area boolean not null default false,
  record_stage text not null default 'Captured',
  source_type text,
  owner_user_id uuid,
  touch_count integer not null default 1,
  contact_person_ids uuid[] not null default '{}',
  voided boolean not null default false,
  captured_on date not null,
  last_seen_on date not null,
  facts_version integer not null default 0,
  merged_into uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists demand_view_code on demand_view (tenant_id, code);
-- open demand per cell (incremental demand gap): micromarkets @> array[$m] and tenant_id = $t (recheck)
create index if not exists demand_view_cell on demand_view using gin (micromarkets) where outside_launch_area = false;

create table if not exists match_view (
  id uuid primary key,                     -- crm-engine match id
  tenant_id uuid not null,
  code text not null,
  demand_id uuid not null,
  offer_ids uuid[] not null,
  is_bundle boolean not null default false,
  score integer not null,
  status text not null check (status in ('Suggested', 'Confirmed', 'Rejected', 'Closed')),
  flags text[] not null default '{}',
  closed_reason text,
  source_version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- proposal option validation; demand derived status; exit notifications
create index if not exists match_view_demand on match_view (tenant_id, demand_id, status);

-- offer ↔ match links (replaces the btree_gin index match_view_offers): offer derived status, notify other demands
create table if not exists match_offers (
  id uuid primary key,
  tenant_id uuid not null,
  match_id uuid not null,
  offer_id uuid not null,
  demand_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists match_offers_link on match_offers (tenant_id, match_id, offer_id);
create index if not exists match_offers_offer on match_offers (tenant_id, offer_id);

create table if not exists person_state (
  id uuid primary key,                     -- records person id (pseudonymous)
  tenant_id uuid not null,
  flags text[] not null default '{}',
  flag_version integer not null default 0,
  consecutive_no_answer integer not null default 0,
  unreachable_at timestamptz,
  last_call_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subject_contacts (
  id uuid primary key,
  tenant_id uuid not null,
  person_id uuid not null,
  subject_type text not null check (subject_type in ('offer', 'demand')),
  subject_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists subject_contacts_link on subject_contacts (tenant_id, person_id, subject_type, subject_id);
-- merges re-point a subject's links
create index if not exists subject_contacts_subject on subject_contacts (tenant_id, subject_id);

create table if not exists staff_users (
  id uuid primary key,                     -- web user id
  tenant_id uuid not null,
  role text not null,
  active boolean not null,
  display_name text,                       -- PII (staff name, conventions §9)
  source_version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- assignment pool (active Supply / Demand agents)
create index if not exists staff_users_role on staff_users (tenant_id, role, active, id);

-- 3.3 Work state ---------------------------------------------------------------------------------------------------
create table if not exists life_curve (
  id uuid primary key,
  tenant_id uuid not null,
  subject_type text not null check (subject_type in ('offer', 'demand')),
  subject_id uuid not null,
  category_key text not null,
  stage text not null check (stage in ('Fresh', 'Ageing', 'Stale', 'Expired', 'Paused')),
  day_count integer not null default 0,
  last_confirmed_at timestamptz,
  last_confirmed_how text,
  clock_floor date not null,
  clock_starts_on date,
  paused_until date,
  availability_unknown boolean not null default false,
  next_change_on date,
  stage_changed_at timestamptz,
  frozen boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists life_curve_subject on life_curve (tenant_id, subject_type, subject_id);
-- nightly: tenant_id = $1 and next_change_on <= $today order by next_change_on, id limit 1000
create index if not exists life_curve_due on life_curve (tenant_id, next_change_on, id)
  where frozen = false and next_change_on is not null;

create table if not exists offer_journey (
  id uuid primary key,                     -- offer id
  tenant_id uuid not null,
  commercial_status text not null check (commercial_status in
    ('Upcoming', 'Available', 'Matched', 'In proposal', 'Site visit', 'In process', 'Closed', 'Inactive')),
  commercial_changed_at timestamptz not null,
  inactive_reason text,
  enquiry_count integer not null default 0,
  open_match_count integer not null default 0,
  confirmed_match_count integer not null default 0,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- /internal/v1/subject-states (updatedAt, id)
create index if not exists offer_journey_updated on offer_journey (tenant_id, updated_at, id);

create table if not exists demand_journey (
  id uuid primary key,                     -- demand id
  tenant_id uuid not null,
  commercial_status text not null check (commercial_status in
    ('New', 'Contacted', 'Active', 'Sourcing', 'Matched', 'Proposal shared', 'Site visit', 'In process', 'Closed')),
  commercial_changed_at timestamptz not null,
  exit_type text check (exit_type in ('Lost', 'Dormant', 'Invalid')),
  exit_reason_code text,
  exit_reason text,                        -- PII possible
  competing_terms text,                    -- PII possible
  competing_price_inr bigint,
  exit_flag_person boolean not null default false,
  exit_person_id uuid,
  revisit_date date,
  exited_at timestamptz,
  exited_by uuid,
  qualified_at timestamptz,
  qualification jsonb,                     -- decisionMakerNote: PII possible
  first_contacted_at timestamptz,
  unreachable boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- dormant-revisit job: revisit_date <= $today
create index if not exists demand_journey_revisit on demand_journey (tenant_id, revisit_date, id) where exit_type = 'Dormant';
create index if not exists demand_journey_updated on demand_journey (tenant_id, updated_at, id);

create table if not exists capacities (
  id uuid primary key,
  tenant_id uuid not null,
  user_id uuid not null,
  team text not null check (team in ('supply', 'demand')),
  daily_calls integer not null default 40 check (daily_calls between 0 and 200),
  updated_by uuid,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists capacities_user on capacities (tenant_id, user_id);
-- GET /v1/capacities?team (user_id order), least-loaded assignment
create index if not exists capacities_team on capacities (tenant_id, team, user_id);

create table if not exists queue_items (
  id uuid primary key,
  tenant_id uuid not null,
  team text not null check (team in ('supply', 'demand')),
  section text not null,
  subject_type text not null,
  subject_id uuid not null,
  subject_code text,                       -- denormalised display code (My queue reads without joins, NFR-8)
  offer_id uuid,
  demand_id uuid,
  assignee_user_id uuid,
  reason text not null,
  reason_ref text,
  priority smallint not null default 0,
  due_at timestamptz,
  rank_score numeric(6, 2),
  rank_factors jsonb,
  rank_dirty boolean not null default false,
  attempts integer not null default 0,
  next_call_date date,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  closed_at timestamptz,
  closed_reason text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- must_call and date sections: order by priority desc, due_at, id
create index if not exists queue_open_due on queue_items (tenant_id, assignee_user_id, section, priority desc, due_at, id)
  where status = 'open';
-- should_call: order by rank_score desc, id
create index if not exists queue_open_rank on queue_items (tenant_id, assignee_user_id, section, rank_score desc, id)
  where status = 'open';
-- one open item per section and subject (upsert target)
create unique index if not exists queue_open_subject on queue_items (tenant_id, section, subject_type, subject_id)
  where status = 'open';
-- close every open item of a subject (retire, exit, close, merge)
create index if not exists queue_subject_any on queue_items (tenant_id, subject_id) where status = 'open';
create index if not exists queue_offer_any on queue_items (tenant_id, offer_id) where status = 'open' and offer_id is not null;
create index if not exists queue_demand_any on queue_items (tenant_id, demand_id) where status = 'open' and demand_id is not null;
-- rank-refresh job
create index if not exists queue_rank_dirty on queue_items (tenant_id, id) where rank_dirty and status = 'open';

create table if not exists queue_counters (
  id uuid primary key,
  tenant_id uuid not null,
  user_id uuid not null,
  section text not null,
  open_count integer not null default 0,
  overdue_count integer not null default 0,
  changed_at timestamptz,
  emitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists queue_counters_user on queue_counters (tenant_id, user_id, section);
-- queue-counts-flush: users whose counts changed since the last emit
create index if not exists queue_counters_dirty on queue_counters (tenant_id, changed_at)
  where changed_at > coalesce(emitted_at, '-infinity'::timestamptz);

create table if not exists calls (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  subject_type text not null,
  subject_id uuid not null,
  person_id uuid,
  queue_item_id uuid,
  channel text not null check (channel in ('call', 'meeting')),
  outcome text not null check (outcome in ('confirmed', 'no_answer', 'already_gone', 'unwilling')),
  attempt_no integer not null,
  known_price_inr bigint,
  next_call_date date,
  notes text,                              -- PII
  logged_by uuid not null,
  logged_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists calls_code on calls (tenant_id, code);
create index if not exists calls_subject on calls (tenant_id, subject_id, logged_at desc, id);
create index if not exists calls_person on calls (tenant_id, person_id, logged_at desc, id) where person_id is not null;
create index if not exists calls_logger_day on calls (tenant_id, logged_by, logged_at desc, id);

create table if not exists demand_gap (
  id uuid primary key,
  tenant_id uuid not null,
  segment text not null,
  deal_type text not null,
  micromarket text not null,
  open_demand integer not null,
  matching_supply integer not null,
  gap integer not null,
  budget_p10 bigint,
  budget_p25 bigint,
  budget_p75 bigint,
  budget_p90 bigint,
  computed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists demand_gap_cell on demand_gap (tenant_id, segment, deal_type, micromarket);

create table if not exists source_quality (
  id uuid primary key,
  tenant_id uuid not null,
  source_type text not null,
  captured_90d integer not null,
  verified_or_matched_90d integer not null,
  score numeric(4, 3) not null,
  computed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists source_quality_type on source_quality (tenant_id, source_type);

create table if not exists sourcing_requests (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  demand_id uuid not null,
  requested_by uuid not null,
  assignee_user_id uuid not null,
  due_date date not null,
  priority text not null check (priority in ('High', 'Normal', 'Low')),
  status text not null check (status in ('Open', 'In progress', 'Fulfilled', 'Cancelled')),
  post_anonymously boolean not null default false,
  offer_ids uuid[] not null default '{}',
  notes text,                              -- PII possible
  closed_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists srq_code on sourcing_requests (tenant_id, code);
create index if not exists srq_assignee on sourcing_requests (tenant_id, assignee_user_id, status, due_date, id);
create index if not exists srq_requester on sourcing_requests (tenant_id, requested_by, status, due_date, id);
create index if not exists srq_demand on sourcing_requests (tenant_id, demand_id, status);
-- unfiltered / status-only list: order by due_date, id
create index if not exists srq_due on sourcing_requests (tenant_id, status, due_date, id);

create table if not exists proposals (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  demand_id uuid not null,
  status text not null check (status in ('Preparing', 'Ready', 'Sent', 'Failed')),
  cover_note text,                         -- PII possible
  snapshot jsonb,                          -- confidential: building names; never contact fields
  snapshot_at timestamptz,
  snapshot_attempts integer not null default 0,
  pdf_status text not null default 'none' check (pdf_status in ('none', 'queued', 'ready', 'failed')),
  pdf_path text,
  pdf_generated_at timestamptz,
  sent_at timestamptz,
  sent_channel text,
  created_by uuid not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists proposals_code on proposals (tenant_id, code);
create index if not exists proposals_demand on proposals (tenant_id, demand_id, created_at desc, id);
create index if not exists proposals_creator on proposals (tenant_id, created_by, created_at desc, id);
create index if not exists proposals_created on proposals (tenant_id, created_at desc, id);

create table if not exists proposal_options (
  id uuid primary key,
  tenant_id uuid not null,
  proposal_id uuid not null references proposals (id),
  position integer not null,
  match_id uuid not null,
  offer_ids uuid[] not null,
  feedback text check (feedback in ('liked', 'rejected', 'visit_requested', 'maybe')),
  feedback_note text,                      -- PII possible
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists proposal_options_proposal on proposal_options (tenant_id, proposal_id, position);
-- offer derived status: Sent proposals whose option carries a Confirmed match of the offer
create index if not exists proposal_options_match on proposal_options (tenant_id, match_id);

create table if not exists proposal_links (
  id uuid primary key,
  tenant_id uuid not null,
  proposal_id uuid not null references proposals (id),
  token_hash bytea not null,               -- sha256(token); the token is never stored
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid not null,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- public page lookup (token is globally unique; the tenant comes from the row)
create unique index if not exists proposal_links_token on proposal_links (token_hash);
create index if not exists proposal_links_active on proposal_links (tenant_id, proposal_id) where revoked_at is null;

create table if not exists proposal_link_opens (
  id uuid primary key,
  tenant_id uuid not null,
  link_id uuid not null references proposal_links (id),
  opened_at timestamptz not null,
  ip_hash bytea,                           -- salted hash; the raw IP is never stored
  ua_family text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists proposal_link_opens_link on proposal_link_opens (tenant_id, link_id, opened_at desc);
-- retention purge (90 days)
create index if not exists proposal_link_opens_at on proposal_link_opens (tenant_id, opened_at);

create table if not exists site_visits (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  demand_id uuid not null,
  offer_ids uuid[] not null,
  scheduled_at timestamptz not null,
  attendee_user_ids uuid[] not null default '{}',
  status text not null check (status in ('Scheduled', 'Completed', 'Cancelled')),
  outcome text,
  visited_offer_ids uuid[] not null default '{}',
  preferred_offer_id uuid,
  notes text,                              -- PII possible
  completed_at timestamptz,
  created_by uuid not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists visits_code on site_visits (tenant_id, code);
create index if not exists visits_demand on site_visits (tenant_id, demand_id, scheduled_at, id);
-- ?offerId (tenant_id is a recheck predicate)
create index if not exists visits_offer on site_visits using gin (offer_ids);
create index if not exists visits_scheduled on site_visits (tenant_id, status, scheduled_at, id);
create index if not exists visits_all on site_visits (tenant_id, scheduled_at, id);

create table if not exists deals (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  demand_id uuid not null,
  offer_id uuid not null,
  match_id uuid,
  multi_unit boolean not null default false,
  stage text not null check (stage in ('Negotiation', 'Documentation', 'Stamp duty & registration', 'Closed', 'Cancelled')),
  agreed_terms jsonb not null default '{}',   -- otherTerms: PII possible
  next_action text,
  follow_up_date date,
  closing_price_inr bigint,
  closed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason_code text,
  cancel_reason text,                      -- PII possible
  owner_user_id uuid,                      -- the demand owner at opening (?ownerUserId filter)
  created_by uuid not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stage in ('Closed', 'Cancelled') or (next_action is not null and follow_up_date is not null))
);
create unique index if not exists deals_code on deals (tenant_id, code);
create index if not exists deals_open_followup on deals (tenant_id, follow_up_date, id) where stage not in ('Closed', 'Cancelled');
create index if not exists deals_demand on deals (tenant_id, demand_id, stage);
create index if not exists deals_offer on deals (tenant_id, offer_id, stage);
create index if not exists deals_updated on deals (tenant_id, stage, updated_at desc, id);
create index if not exists deals_owner on deals (tenant_id, owner_user_id, follow_up_date, id);

create table if not exists deal_events (
  id uuid primary key,
  tenant_id uuid not null,
  deal_id uuid not null references deals (id),
  kind text not null check (kind in ('stage', 'follow_up', 'terms', 'cancel')),
  from_stage text,
  to_stage text,
  note text,                               -- PII possible
  next_action text,
  follow_up_date date,
  at timestamptz not null,
  by_user uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deal_events_deal on deal_events (tenant_id, deal_id, at);

create table if not exists lease_renewals (
  id uuid primary key,
  tenant_id uuid not null,
  deal_id uuid not null,
  offer_id uuid not null,
  property_id uuid not null,
  lease_start_date date not null,
  lease_months integer not null,
  due_on date not null,
  available_from date not null,
  status text not null check (status in ('scheduled', 'emitted', 'cancelled')),
  emitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists lease_renewals_deal on lease_renewals (tenant_id, deal_id);
create index if not exists lease_renewals_due on lease_renewals (tenant_id, status, due_on, id);
create index if not exists lease_renewals_all on lease_renewals (tenant_id, due_on, id);

create table if not exists notifications (
  id uuid primary key,
  tenant_id uuid not null,
  user_id uuid not null,
  kind text not null,
  title text not null,                     -- codes and generated labels only
  body text,
  subject_type text,
  subject_id uuid,
  subject_code text,
  dedupe_key text,
  dedupe_count integer not null default 1,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notifications_user on notifications (tenant_id, user_id, created_at desc, id);
create index if not exists notifications_unread on notifications (tenant_id, user_id, created_at desc, id) where read_at is null;
create unique index if not exists notifications_dedupe on notifications (tenant_id, user_id, dedupe_key)
  where read_at is null and dedupe_key is not null;
-- retention purge (90 days)
create index if not exists notifications_created on notifications (tenant_id, created_at);

create table if not exists watchlist_tasks (
  id uuid primary key,
  tenant_id uuid not null,
  watchlist_item_id uuid not null,
  watchlist_code text,
  signal_type text,
  deadline_date date,
  assignee_user_id uuid,
  due_date date,
  status text not null check (status in ('Open', 'Done', 'Cancelled')),
  outcome text,                            -- PII possible
  completed_at timestamptz,
  completed_by uuid,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists watchlist_tasks_item on watchlist_tasks (tenant_id, watchlist_item_id);
create index if not exists watchlist_tasks_open on watchlist_tasks (tenant_id, status, deadline_date nulls last, id);
create index if not exists watchlist_tasks_all on watchlist_tasks (tenant_id, deadline_date nulls last, id);
create index if not exists watchlist_tasks_assignee on watchlist_tasks (tenant_id, assignee_user_id, status, due_date, id);

create table if not exists settings (
  id uuid primary key,
  tenant_id uuid not null,
  kind text not null check (kind in ('life_curve_thresholds', 'queue_weights')),
  body jsonb not null,
  updated_by uuid,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists settings_kind on settings (tenant_id, kind);

-- 3.4 Infrastructure tables (outbox, processed_events, idempotency_keys, job_leases are in 0001) -----------------
create table if not exists aggregate_versions (
  id uuid primary key,                     -- aggregate id
  tenant_id uuid not null,
  aggregate_type text not null,
  version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists job_runs (
  id uuid primary key,
  tenant_id uuid,
  job text not null,
  run_date date not null,
  cursor text,
  processed integer not null default 0,
  done boolean not null default false,
  started_at timestamptz not null,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists job_runs_key on job_runs (job, run_date, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists merge_log (
  id uuid primary key,
  tenant_id uuid not null,
  merge_id uuid not null,
  table_name text not null,
  row_id uuid not null,
  before jsonb not null,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists merge_log_merge on merge_log (tenant_id, merge_id);

-- Comments: PII columns (LLD §7) ------------------------------------------------------------------------------------
comment on column calls.notes is 'PII';
comment on column staff_users.display_name is 'PII (staff)';
comment on column demand_journey.exit_reason is 'PII possible';
comment on column demand_journey.competing_terms is 'PII possible';
comment on column demand_journey.qualification is 'PII possible (decisionMakerNote)';
comment on column sourcing_requests.notes is 'PII possible';
comment on column proposals.cover_note is 'PII possible';
comment on column proposal_options.feedback_note is 'PII possible';
comment on column site_visits.notes is 'PII possible';
comment on column deals.cancel_reason is 'PII possible';
comment on column deals.agreed_terms is 'PII possible (otherTerms)';
comment on column deal_events.note is 'PII possible';
comment on column watchlist_tasks.outcome is 'PII possible';
