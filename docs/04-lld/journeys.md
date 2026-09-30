# 04 — LLD: `journeys` (work management)

| | |
|---|---|
| Service | S3 `journeys` (HLD §2) |
| Version | 0.2 (draft; aligned to events v0.2 and conventions §10) |
| Date | 2026-09-24 |
| Based on | BRD v0.6.1, PRD v0.6, HLD v0.2 (approved), `docs/04-lld/conventions.md` (incl. §10 R-1…R-22), `contracts/asyncapi/events.yaml` v0.2.0 |
| Contract | `contracts/openapi/journeys.yaml` |
| Status | IN PROGRESS (Stage 4) |

This document follows `conventions.md` with no deviations; where an earlier draft disagreed with the reconciliation decisions (§10 R-x), the decisions win. IDs, tenancy, HTTP rules, errors, pagination, idempotency,
the event envelope, the outbox and PII rules are not repeated here.

---

## 1. Purpose and scope

journeys tells each person what to do next and moves every offer and demand through its stages to Closed or an exit
(HLD S3). It owns:

- **Work queues**: My queue sections for both teams, Must call / Should call ranking, daily capacity, call attempts
  and outcomes (PRD §4.2, §4.3, D-10, US-12, US-19).
- **Life curve** for every live offer and demand: last confirmed, day count, stage, automatic actions, the nightly run
  (BRD §4.5, PRD §4.1, D-12, US-11).
- **Commercial axis** of offers (Upcoming … Closed, Inactive) and demands (New … Closed), and demand **exits** (Lost,
  Dormant, Invalid) (BRD §4.4, §6.1).
- **Sourcing requests, proposals** (content snapshot, PDF, share link, public page), **site visits, deals**
  (stages, required follow-ups, close, cancel), **lease renewals** (US-16, US-22…27, D-11).
- **Work notifications** (FR-NTF-1; matches, SRQs, handoffs, follow-ups; upload/export/user notifications are web's, R-6) and **Watchlist follow-up tasks** (D-14, US-36).
- **Settings** it enforces: life-curve thresholds and queue weights (Admin, US-34), capacities (Manager).

It does **not** own offer/demand facts, prices, the Record axis, people, flags or photos (records), matches or weights
(crm-engine), or the Publication axis (listings). It keeps **local projections** of the facts it needs, built from
events (§3.2).

## 2. Internal module layout

```
services/journeys/
  src/domain/                  pure logic, no I/O or framework imports
    lifecurve/                 CategoryKey, Thresholds, LifeCurve (stage/day/nextChangeOn), StageActions
    commercial/                OfferStatus, DemandStatus, derivation rule (§4.2), ExitPolicy
    queue/                     Section, QueueItem, ShouldCallRanker (§4.3), DailyPlan, Assignment policy
    calls/                     CallOutcome rules, AttemptCounter (3-attempt rule)
    deals/                     Deal state machine, FollowUp rule, LeaseRenewal schedule
    proposals/                 Proposal, ShareToken (hash/expiry), Snapshot validation (no contact fields)
    sourcing/, visits/, watchlist/, notifications/   aggregates + rules
  src/application/             use cases; depend only on ports
    commands/                  LogCall, QualifyDemand, ExitDemand, ReactivateDemand, RetireOffer, CreateSourcingRequest,
                               CreateProposal, BuildProposalSnapshot, GenerateProposalPdf, CreateShareLink, MarkProposalSent,
                               ScheduleVisit, CompleteVisit, OpenDeal, UpdateDeal, CloseDeal, CancelDeal, LogFollowUp,
                               ReassignQueueItems, SetCapacity, PutThresholds, PutQueueWeights, CompleteWatchlistTask
    queries/                   GetMyQueue, ListSection, GetLifeCurve, GetOfferJourney, GetDemandJourney, lists
    handlers/                  one per consumed event (§5.2)
    jobs/                      LifeCurveNightly, DemandGapRefresh, RankRefresh, LeaseRenewalScan, DormantRevisit,
                               FollowUpReminders, RetentionPurge
    ports/                     JourneyRepository, QueueRepository, ProjectionRepository, OutboxPort, IdempotencyStore,
                               Clock (IST), ProposalContentPort (records), PublicationSettingsPort (listings),
                               FileStoragePort, PdfRendererPort, ServiceTokenPort (web issuer, R-2),
                               WorkQueuePort (pgmq), JobCursorStore, TokenGenerator
  src/adapters/
    http/                      route handlers generated from contracts/openapi/journeys.yaml, auth (staff/service/cron),
                               RFC 7807 mapper, idempotency middleware, correlation-id propagation
    db/                        Postgres repositories (schema `journeys`, role `journeys_svc`, Supavisor transaction mode)
    messaging/                 outbox writer, relay, pgmq drain + DLQ, processed_events dedupe
    records/                   ProposalContentPort → records' existing GET endpoints (offer, property, photos) and projection
                               re-reads, with a service token minted by web (R-2, verified via web JWKS)
    listings/                  PublicationSettingsPort → listings GET /v1/publication-settings (MahaRERA number) with a service token
    storage/                   Supabase Storage bucket `journeys-proposals` (private, signed URLs)
    pdf/                       PdfRendererPort implementation (library fixed in Stage 6)
  src/main.ts                  composition root: wires adapters to ports, reads env/secrets
  migrations/                  forward-only SQL (expand → migrate → contract), incl. seeds for thresholds and weights
  tests/unit/                  domain: life curve tables, ranking, state machines, derivation rule
  tests/integration/           repositories, outbox/relay/drain, idempotency, tenant isolation (NFR-15)
  tests/contract/              OpenAPI conformance; AsyncAPI payload conformance for produced/consumed events
  tests/scenarios/             PRD Appendix B AS-D1…AS-S6 driven through commands + fake event feeds
```

The import linter (CLAUDE.md §3.1) enforces `domain` ← `application` ← `adapters`; only `main.ts` imports adapters.

## 3. Data schema

Schema `journeys`, role `journeys_svc`. Every table has `tenant_id uuid not null`, `created_at timestamptz not null
default now()`, `updated_at timestamptz not null default now()`; mutable aggregates have `version int not null default 1`.
These common columns are omitted below unless they matter. Every index starts with `tenant_id`. Times are `timestamptz`
(UTC); business dates (`date`) are in IST (Asia/Kolkata). `-- PII` marks columns that may hold personal data (§7).

### 3.1 Code sequences
```sql
create table code_sequences (
  tenant_id uuid not null, prefix text not null check (prefix in ('SRQ','PROP','VIS','DEAL','CALL')),
  next_value bigint not null default 1,
  primary key (tenant_id, prefix)             -- convention exception: composite PK, no id (sequence rows, not entities)
);
```
Codes are issued with `update … set next_value = next_value + 1 returning next_value - 1` in the same transaction as the
insert, and formatted `SRQ-000`, `PROP-0000`, `VIS-0000`, `DEAL-0000`, `CALL-000000` (zero padded, width grows).

### 3.2 Local projections (built from records and crm-engine events)

```sql
create table offer_view (                       -- one row per records Offer; id = records offer id
  id uuid primary key, tenant_id uuid not null,
  code text not null, property_id uuid not null, project_id uuid,
  deal_type text not null, market text, segment text, property_types text[] not null default '{}',
  micromarket text, locality text, city text, outside_launch_area boolean not null default false,
  possession_status text, possession_date_raw text,          -- 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'
  available_from date,                                       -- normalised: first day of the stated period
  sale_price_inr_min bigint, sale_price_inr_max bigint, rent_monthly_inr_min bigint, rent_monthly_inr_max bigint,
  area_sqft_min numeric, area_sqft_max numeric, unit_count int,
  record_stage text not null default 'Enriched', has_real_photos boolean not null default false,   -- R-10 initial stage
  source_type text, sourced_for_demand_id uuid, owner_user_id uuid,
  publication_level text not null default 'Private',        -- from publication.changed.v1
  price_sheet_date date,                                     -- priceSheetDate / price_sheet.applied.v1 (projects)
  contact_person_ids uuid[] not null default '{}',           -- contactPersonIds (pseudonymous ids)
  captured_on date not null,                                 -- occurredAt (IST date) of offer.created
  last_seen_on date not null,                                -- lastSeenDate from offer facts
  voided boolean not null default false,                     -- offer.voided.v1
  publication_version int not null default 0,
  facts_version int not null default 0,                      -- aggregateVersion of the last full-facts event applied
  stage_version int not null default 0,                      -- aggregateVersion of the last record_stage event applied
  merged_into uuid,
  unique (tenant_id, code)
);
create table demand_view (                      -- id = records demand id
  id uuid primary key, tenant_id uuid not null, code text not null,
  deal_types text[] not null, market text, segment text, property_types text[] not null default '{}',
  micromarkets text[] not null default '{}', localities text[] not null default '{}',
  budget_inr_min bigint, budget_inr_max bigint, rent_monthly_inr_min bigint, rent_monthly_inr_max bigint,
  area_sqft_min numeric, area_sqft_max numeric, move_in_from date, move_in_by date,
  outside_launch_area boolean not null default false, record_stage text not null default 'Captured',
  source_type text, owner_user_id uuid, touch_count int not null default 1,
  contact_person_ids uuid[] not null default '{}', voided boolean not null default false,
  captured_on date not null, last_seen_on date not null,
  facts_version int not null default 0, merged_into uuid,
  unique (tenant_id, code)
);
create table match_view (                       -- id = crm-engine match id
  id uuid primary key, tenant_id uuid not null, code text not null,
  demand_id uuid not null, offer_ids uuid[] not null, is_bundle boolean not null default false,
  score int not null, status text not null check (status in ('Suggested','Confirmed','Rejected','Closed')),
  flags text[] not null default '{}', closed_reason text,
  source_version int not null                               -- match aggregateVersion
);
create table person_state (                     -- flags from records + our own attempt counting
  id uuid primary key,                          -- = records person id (pseudonymous; not PII by itself)
  tenant_id uuid not null, flags text[] not null default '{}', flag_version int not null default 0,
  consecutive_no_answer int not null default 0, unreachable_at timestamptz, last_call_at timestamptz
);
create table subject_contacts (                 -- person ↔ subject links: contactPersonIds from facts events + persons called
  id uuid primary key, tenant_id uuid not null, person_id uuid not null,
  subject_type text not null check (subject_type in ('offer','demand')), subject_id uuid not null,
  unique (tenant_id, person_id, subject_type, subject_id)
);
create table staff_users (                      -- from user.changed.v1 (assignment pool, names in queue UI)
  id uuid primary key,                          -- = web user id
  tenant_id uuid not null, role text not null, active boolean not null,
  display_name text,                            -- staff PII (conventions §9)
  source_version int not null
);
```

### 3.3 Work state

```sql
create table life_curve (
  id uuid primary key, tenant_id uuid not null,
  subject_type text not null check (subject_type in ('offer','demand')), subject_id uuid not null,
  category_key text not null, stage text not null check (stage in ('Fresh','Ageing','Stale','Expired','Paused')),
  day_count int not null default 0,
  last_confirmed_at timestamptz, last_confirmed_how text,       -- call|meeting|visit|price_sheet|deal_follow_up
  clock_floor date not null,                                    -- captured_on, latest price sheet, or Upcoming start
  clock_starts_on date,                                         -- Upcoming: available_from − 60 days; null otherwise
  paused_until date,                                            -- Dormant revisit date
  availability_unknown boolean not null default false,          -- Expired offer
  next_change_on date,                                          -- next date the stage can change; null = frozen
  stage_changed_at timestamptz, frozen boolean not null default false,   -- Closed/Inactive/exited subjects
  version int not null default 1,
  unique (tenant_id, subject_type, subject_id)
);
create table offer_journey (                    -- id = offer id
  id uuid primary key, tenant_id uuid not null,
  commercial_status text not null check (commercial_status in
    ('Upcoming','Available','Matched','In proposal','Site visit','In process','Closed','Inactive')),
  commercial_changed_at timestamptz not null, inactive_reason text,
  enquiry_count int not null default 0, open_match_count int not null default 0, confirmed_match_count int not null default 0,
  version int not null default 1
);
create table demand_journey (                   -- id = demand id
  id uuid primary key, tenant_id uuid not null,
  commercial_status text not null check (commercial_status in
    ('New','Contacted','Active','Sourcing','Matched','Proposal shared','Site visit','In process','Closed')),
  commercial_changed_at timestamptz not null,
  exit_type text check (exit_type in ('Lost','Dormant','Invalid')), exit_reason_code text,
  exit_reason text,                              -- PII possible
  competing_terms text,                          -- PII possible
  revisit_date date, exited_at timestamptz, exited_by uuid,
  qualified_at timestamptz, qualification jsonb,  -- checklist; decisionMakerNote is PII possible
  first_contacted_at timestamptz, unreachable boolean not null default false,
  version int not null default 1
);
create table capacities (
  id uuid primary key, tenant_id uuid not null, user_id uuid not null,
  team text not null check (team in ('supply','demand')), daily_calls int not null default 40 check (daily_calls between 0 and 200),
  updated_by uuid, version int not null default 1, unique (tenant_id, user_id)
);
create table queue_items (                      -- the single materialised work list behind My queue
  id uuid primary key, tenant_id uuid not null,
  team text not null check (team in ('supply','demand')), section text not null,       -- enum in the contract
  subject_type text not null, subject_id uuid not null, offer_id uuid, demand_id uuid,
  assignee_user_id uuid,                         -- null only transiently (assignment policy §4.3.5)
  reason text not null, reason_ref text, priority smallint not null default 0,          -- 1 = top (Sourced for)
  due_at timestamptz, rank_score numeric(6,2), rank_factors jsonb, rank_dirty boolean not null default false,
  attempts int not null default 0, next_call_date date,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  closed_at timestamptz, closed_reason text, version int not null default 1
);
create table queue_counters (                   -- per user/section open counts; maintained in the same tx, reconciled nightly
  id uuid primary key, tenant_id uuid not null, user_id uuid not null, section text not null,
  open_count int not null default 0, overdue_count int not null default 0,
  changed_at timestamptz, emitted_at timestamptz,          -- debounce for queue.counts_changed.v1 (≤ 1/min per user)
  unique (tenant_id, user_id, section)
);
create table calls (
  id uuid primary key, tenant_id uuid not null, code text not null,
  subject_type text not null, subject_id uuid not null, person_id uuid, queue_item_id uuid,
  channel text not null check (channel in ('call','meeting')),
  outcome text not null check (outcome in ('confirmed','no_answer','already_gone','unwilling')),
  attempt_no int not null, known_price_inr bigint, next_call_date date,
  notes text,                                    -- PII
  logged_by uuid not null, logged_at timestamptz not null,
  unique (tenant_id, code)
);
create table demand_gap (                       -- Should call inputs per cell, refreshed nightly + incrementally
  id uuid primary key, tenant_id uuid not null,
  segment text not null, deal_type text not null, micromarket text not null,
  open_demand int not null, matching_supply int not null, gap int not null,
  budget_p10 bigint, budget_p25 bigint, budget_p75 bigint, budget_p90 bigint,   -- price basis per deal_type (§4.3.3)
  computed_at timestamptz not null,
  unique (tenant_id, segment, deal_type, micromarket)
);
create table source_quality (
  id uuid primary key, tenant_id uuid not null, source_type text not null,
  captured_90d int not null, verified_or_matched_90d int not null, score numeric(4,3) not null,
  computed_at timestamptz not null, unique (tenant_id, source_type)
);
create table sourcing_requests (
  id uuid primary key, tenant_id uuid not null, code text not null, demand_id uuid not null,
  requested_by uuid not null, assignee_user_id uuid not null, due_date date not null,
  priority text not null check (priority in ('High','Normal','Low')),
  status text not null check (status in ('Open','In progress','Fulfilled','Cancelled')),
  post_anonymously boolean not null default false, offer_ids uuid[] not null default '{}',
  notes text,                                    -- PII possible
  closed_at timestamptz, version int not null default 1, unique (tenant_id, code)
);
create table proposals (
  id uuid primary key, tenant_id uuid not null, code text not null, demand_id uuid not null,
  status text not null check (status in ('Preparing','Ready','Sent','Failed')),
  cover_note text,                               -- PII possible
  snapshot jsonb, snapshot_at timestamptz,       -- CONFIDENTIAL: building names; never contact fields (§4.6)
  pdf_status text not null default 'none' check (pdf_status in ('none','queued','ready','failed')),
  pdf_path text, pdf_generated_at timestamptz,
  sent_at timestamptz, sent_channel text, created_by uuid not null, version int not null default 1,
  unique (tenant_id, code)
);
create table proposal_options (
  id uuid primary key, tenant_id uuid not null, proposal_id uuid not null references proposals(id),
  position int not null, match_id uuid not null, offer_ids uuid[] not null,
  feedback text check (feedback in ('liked','rejected','visit_requested')), feedback_note text,   -- PII possible (values = proposal.feedback_recorded.v1 verdicts)
  unique (tenant_id, proposal_id, position)
);
create table proposal_links (
  id uuid primary key, tenant_id uuid not null, proposal_id uuid not null references proposals(id),
  token_hash bytea not null,                     -- sha256(token); the token itself is never stored
  expires_at timestamptz not null, revoked_at timestamptz, created_by uuid not null,
  open_count int not null default 0, last_opened_at timestamptz
);
create table proposal_link_opens (
  id uuid primary key, tenant_id uuid not null, link_id uuid not null references proposal_links(id),
  opened_at timestamptz not null, ip_hash bytea, ua_family text   -- salted hash; raw IP never stored
);
create table site_visits (
  id uuid primary key, tenant_id uuid not null, code text not null, demand_id uuid not null,
  offer_ids uuid[] not null, scheduled_at timestamptz not null, attendee_user_ids uuid[] not null default '{}',
  status text not null check (status in ('Scheduled','Completed','Cancelled')),
  outcome text, visited_offer_ids uuid[] not null default '{}', preferred_offer_id uuid,
  notes text,                                    -- PII possible
  completed_at timestamptz, created_by uuid not null, version int not null default 1, unique (tenant_id, code)
);
create table deals (
  id uuid primary key, tenant_id uuid not null, code text not null,
  demand_id uuid not null, offer_id uuid not null, match_id uuid, multi_unit boolean not null default false,
  stage text not null check (stage in ('Negotiation','Documentation','Stamp duty & registration','Closed','Cancelled')),
  agreed_terms jsonb not null default '{}',      -- business terms; otherTerms is PII possible
  next_action text, follow_up_date date,         -- required while open (check below)
  closing_price_inr bigint, closed_at timestamptz, cancelled_at timestamptz,
  cancel_reason_code text, cancel_reason text,   -- cancel_reason PII possible
  created_by uuid not null, version int not null default 1,
  unique (tenant_id, code),
  check (stage in ('Closed','Cancelled') or (next_action is not null and follow_up_date is not null))
);
create table deal_events (                      -- stage history + follow-ups (append-only)
  id uuid primary key, tenant_id uuid not null, deal_id uuid not null references deals(id),
  kind text not null check (kind in ('stage','follow_up','terms','cancel')),
  from_stage text, to_stage text, note text,     -- PII possible
  next_action text, follow_up_date date, at timestamptz not null, by_user uuid not null
);
create table lease_renewals (
  id uuid primary key, tenant_id uuid not null, deal_id uuid not null, offer_id uuid not null, property_id uuid not null,
  lease_start_date date not null, lease_months int not null, due_on date not null, available_from date not null,
  status text not null check (status in ('scheduled','emitted','cancelled')), emitted_at timestamptz,
  unique (tenant_id, deal_id)
);
create table notifications (
  id uuid primary key, tenant_id uuid not null, user_id uuid not null, kind text not null,
  title text not null, body text,                -- codes and generated labels only; never contact PII
  subject_type text, subject_id uuid, subject_code text, dedupe_key text,
  read_at timestamptz
);
create table watchlist_tasks (
  id uuid primary key, tenant_id uuid not null, watchlist_item_id uuid not null, watchlist_code text,
  signal_type text, deadline_date date, assignee_user_id uuid, due_date date,
  status text not null check (status in ('Open','Done','Cancelled')),
  outcome text,                                  -- PII possible
  completed_at timestamptz, completed_by uuid, version int not null default 1,
  unique (tenant_id, watchlist_item_id)
);
create table settings (                         -- life_curve_thresholds and queue_weights documents
  id uuid primary key, tenant_id uuid not null, kind text not null check (kind in ('life_curve_thresholds','queue_weights')),
  body jsonb not null, updated_by uuid, version int not null default 1, unique (tenant_id, kind)
);
```

### 3.4 Infrastructure tables

```sql
create table outbox (
  id uuid primary key, tenant_id uuid not null, event_type text not null, aggregate_type text not null,
  aggregate_id uuid not null, aggregate_version int not null, payload jsonb not null,
  occurred_at timestamptz not null, published_at timestamptz
);
create table aggregate_versions (               -- monotonic aggregateVersion per produced aggregate
  id uuid primary key,                          -- = aggregate id (offer, demand, deal, proposal, visit, srq, task, renewal)
  tenant_id uuid not null, aggregate_type text not null, version int not null
);
create table processed_events (event_id uuid primary key, consumer text not null, processed_at timestamptz not null);
create table idempotency_keys (
  id uuid primary key, tenant_id uuid not null, user_id uuid not null, route text not null, key uuid not null,
  request_hash bytea not null, status_code int, response jsonb, expires_at timestamptz not null,
  unique (tenant_id, user_id, route, key)
);
create table job_runs (
  id uuid primary key, tenant_id uuid, job text not null, run_date date not null,
  cursor text, processed int not null default 0, done boolean not null default false,
  started_at timestamptz not null, finished_at timestamptz, unique (job, run_date, tenant_id)
);
create table merge_log (                        -- before-images for records.merge_undone.v1
  id uuid primary key, tenant_id uuid not null, merge_id uuid not null, table_name text not null,
  row_id uuid not null, before jsonb not null, undone_at timestamptz
);
```
`aggregate_versions` gives every event journeys produces a strictly increasing `aggregateVersion` per aggregate
(journeys-scoped: offer and demand events from journeys have their own counter, independent of records' versions).

### 3.5 Indexes (every query path)

| Index | Columns / kind | Query it serves |
|---|---|---|
| `offer_view_pkey` / `demand_view_pkey` | `id` | Event handlers; joins from queue rows (`where id = $1`) |
| `offer_view_code` / `demand_view_code` | unique `(tenant_id, code)` | `{idOrCode}` resolution |
| `offer_view_project` | `(tenant_id, project_id) where project_id is not null` | Enquiry on a project → pick its live offer (§5.2) |
| `offer_view_cell` | `(tenant_id, segment, deal_type, micromarket)` | Demand gap / supply count per cell (demand-gap-refresh, incremental) |
| `demand_view_cell` | GIN `(tenant_id, deal_types, micromarkets)` (btree_gin) + `where outside_launch_area = false` | Open-demand count per cell |
| `match_view_demand` | `(tenant_id, demand_id, status)` | Proposal option validation; demand derived status; exit notifications |
| `match_view_offers` | GIN `(tenant_id, offer_ids)` (btree_gin) | Offer derived status; notify other demands' owners |
| `subject_contacts_person` | `(tenant_id, person_id)` | `person.flagged.v1` → linked subjects |
| `life_curve_subject` | unique `(tenant_id, subject_type, subject_id)` | Read / update one life curve |
| `life_curve_due` | `(tenant_id, next_change_on, id) where frozen = false and next_change_on is not null` | Nightly: `where tenant_id=$1 and next_change_on <= $today order by next_change_on, id limit 1000` (keyset) |
| `demand_journey_revisit` | `(tenant_id, revisit_date) where exit_type = 'Dormant'` | Dormant revisit job: `revisit_date <= $today` |
| `queue_open_due` | `(tenant_id, assignee_user_id, section, priority desc, due_at, id) where status = 'open'` | Must call and date-driven sections: `order by priority desc, due_at, id limit $n` (overdue = `due_at < now()` sorts first) |
| `queue_open_rank` | `(tenant_id, assignee_user_id, section, rank_score desc, id) where status = 'open'` | Should call: `section='should_call' and (next_call_date is null or next_call_date <= $today) order by rank_score desc, id limit $n` |
| `queue_open_subject` | unique `(tenant_id, section, subject_type, subject_id) where status = 'open'` | One open item per section and subject (upsert target); close items of a subject |
| `queue_subject_any` | `(tenant_id, subject_id) where status = 'open'` | Close every open item of a subject (retire, exit, close, merge) |
| `queue_rank_dirty` | `(tenant_id, id) where rank_dirty and status = 'open'` | rank-refresh job |
| `queue_counters_user` | unique `(tenant_id, user_id, section)` | My queue summary (one row per section) |
| `queue_counters_dirty` | `(tenant_id, changed_at) where changed_at > coalesce(emitted_at, '-infinity')` | queue-counts-flush: users whose counts changed since the last emit |
| `staff_users_role` | `(tenant_id, role, active)` | Assignment pool (active Supply / Demand agents) |
| `offer_view_contacts` / `demand_view_contacts` | GIN `(tenant_id, contact_person_ids)` | `person.flagged.v1` / `person.flag_removed.v1` → linked subjects |
| `calls_subject` | `(tenant_id, subject_id, logged_at desc, id)` | Call history of a subject |
| `calls_person` | `(tenant_id, person_id, logged_at desc, id) where person_id is not null` | Person panel call history (P-04) |
| `calls_logger_day` | `(tenant_id, logged_by, logged_at desc, id)` | `callsLoggedToday` for the daily plan; `?loggedBy=` list |
| `calls_code` | unique `(tenant_id, code)` | — (code uniqueness) |
| `srq_assignee` | `(tenant_id, assignee_user_id, status, due_date, id)` | Supply `sourcing_requests` section; `?assigneeUserId&status` |
| `srq_requester` | `(tenant_id, requested_by, status, due_date, id)` | Demand `sourcing_requests_open`; `?requestedBy` |
| `srq_demand` | `(tenant_id, demand_id, status)` | Demand journey panel; cancel on exit |
| `srq_code`, `proposals_code`, `visits_code`, `deals_code` | unique `(tenant_id, code)` | `{idOrCode}` resolution |
| `proposals_demand` | `(tenant_id, demand_id, created_at desc, id)` | `GET /v1/proposals?demandId` |
| `proposals_creator` | `(tenant_id, created_by, created_at desc, id)` | `?createdBy`; default list for the caller |
| `proposal_options_proposal` | unique `(tenant_id, proposal_id, position)` | Load options |
| `proposal_links_token` | unique `(token_hash)` | Public page lookup `where token_hash = sha256($token)` (token is globally unique; tenant comes from the row) |
| `proposal_links_active` | `(tenant_id, proposal_id) where revoked_at is null` | Revoke previous link; show active link |
| `proposal_link_opens_link` | `(tenant_id, link_id, opened_at desc)` | Open history; retention purge by `opened_at` |
| `visits_demand` | `(tenant_id, demand_id, scheduled_at, id)` | `?demandId` |
| `visits_offer` | GIN `(tenant_id, offer_ids)` | `?offerId`; offer derived status |
| `visits_scheduled` | `(tenant_id, status, scheduled_at, id)` | `?from&to&status`; site_visits_this_week |
| `deals_open_followup` | `(tenant_id, follow_up_date, id) where stage not in ('Closed','Cancelled')` | `?followUpDue=true`; follow-up-reminders job |
| `deals_demand` | `(tenant_id, demand_id, stage)` | One open deal per demand; `?demandId` |
| `deals_offer` | `(tenant_id, offer_id, stage)` | One open deal per single-unit offer; retire guard; `?offerId` |
| `deals_updated` | `(tenant_id, stage, updated_at desc, id)` | Closed/cancelled lists |
| `deal_events_deal` | `(tenant_id, deal_id, at)` | Stage history |
| `lease_renewals_due` | `(tenant_id, status, due_on, id)` | lease-renewal-scan (`status='scheduled' and due_on <= $today`); list |
| `notifications_user` | `(tenant_id, user_id, created_at desc, id)` | `GET /v1/notifications` |
| `notifications_unread` | `(tenant_id, user_id) where read_at is null` | Unread count; `unreadOnly=true` |
| `notifications_dedupe` | unique `(tenant_id, user_id, dedupe_key) where read_at is null and dedupe_key is not null` | Throttle (e.g. one unread "new matches for DEM-x" per demand) |
| `watchlist_tasks_open` | `(tenant_id, status, deadline_date nulls last, id)` | Watchlist list, deadlines first |
| `watchlist_tasks_assignee` | `(tenant_id, assignee_user_id, status, due_date, id)` | `watchlist_tasks` section |
| `capacities_user` | unique `(tenant_id, user_id)` | Daily plan; `GET /v1/capacities/{userId}` |
| `capacities_team` | `(tenant_id, team, user_id)` | `GET /v1/capacities?team`; least-loaded assignment |
| `demand_gap_cell` | unique `(tenant_id, segment, deal_type, micromarket)` | Ranker lookup per offer |
| `source_quality_type` | unique `(tenant_id, source_type)` | Ranker lookup |
| `outbox_unpublished` | `(occurred_at, id) where published_at is null` | Relay: `for update skip locked limit 500` (all tenants; relay is tenant-agnostic) |
| `outbox_published` | `(published_at) where published_at is not null` | Purge published rows after 7 days |
| `processed_events_at` | `(processed_at)` | Purge after 30 days |
| `idempotency_expires` | `(expires_at)` | Purge after 24 h |
| `merge_log_merge` | `(tenant_id, merge_id)` | Undo a merge |
| `offer_journey_pkey`, `demand_journey_pkey`, `life_curve` | `id` / above | Subject state reads; `/internal/v1/subject-states` uses `(tenant_id, updated_at, id)` on `offer_journey` and `demand_journey` (index `*_updated`) |

No query in journeys is unbounded: lists are cursor-paginated (max 100), jobs use keyset batches of ≤ 1,000, and
fan-out reads (e.g. "all open matches of an offer") are capped (≤ 500; beyond that the work is split into queued
continuations).

## 4. Business rules and algorithms

### 4.1 Life curve (BRD §4.5, PRD §4.1, D-12, US-11)

**4.1.1 Category key.** Evaluated from the projection; the first matching rule wins.

| # | Offer rule | Key | Fresh / Ageing / Stale (last day) |
|---|---|---|---|
| 1 | segment = Industrial (any deal_type) | `offer.industrial` | 45 / 90 / 120 |
| 2 | segment = Land, or deal_type = JV | `offer.land_jv` | 60 / 120 / 180 |
| 3 | deal_type = Pagdi | `offer.sale_secondary` | 45 / 90 / 120 |
| 4 | Lease, segment = Residential (or unknown) | `offer.lease_residential` | 14 / 30 / 45 |
| 5 | Lease, segment = Commercial | `offer.lease_commercial` | 30 / 60 / 90 |
| 6 | Sale, market = Primary | `offer.sale_primary` | 30 / 60 / 90 |
| 7 | Sale, market = Secondary or unknown | `offer.sale_secondary` | 45 / 90 / 120 |

| # | Demand rule (evaluated per deal_type in `deal_types`) | Key | Fresh / Ageing / Stale |
|---|---|---|---|
| 1 | segment = Industrial | `demand.industrial` | 45 / 90 / 120 |
| 2 | segment = Land, or deal_type = JV | `demand.land_jv` | 60 / 120 / 180 |
| 3 | deal_type = Pagdi | `demand.sale_secondary_any` | 45 / 90 / 150 |
| 4 | Lease, Residential (or unknown) | `demand.lease_residential` | 14 / 21 / 30 |
| 5 | Lease, Commercial | `demand.lease_commercial` | 30 / 60 / 90 |
| 6 | Sale, market = Primary | `demand.sale_primary` | 30 / 60 / 120 |
| 7 | Sale, market = Secondary, Any or unknown | `demand.sale_secondary_any` | 45 / 90 / 150 |

A demand with several deal_types takes the key with the **shortest thresholds** (smallest Stale limit), per **R-12**. Thresholds live in `settings(kind='life_curve_thresholds')`, seeded with the values above, Admin-editable
(`PUT /v1/settings/life-curve-thresholds`; validation fresh < ageing < stale).

**4.1.2 Clock.** All dates are IST.
- `last_confirmed_date` = date of `last_confirmed_at` (calls with outcome `confirmed`, meetings, completed visits,
  deal follow-ups, qualification, and price sheets for project offers). Sightings, touches and re-uploads only move
  `last_seen_on` (AC2).
- `clock_floor`: `captured_on` by default; for a **project configuration** (Sale, Primary with `project_id`) the date of
  the latest price sheet (`price_sheet.applied.v1` `sheetDate`, or `priceSheetDate` in the offer facts). A new sheet
  is a confirmation for every configuration of the project (`offer.confirmed.v1` how = `price_sheet`).
- **Upcoming** (possession_status = Available From and `available_from` > today + 60): `clock_starts_on =
  available_from − upcomingLeadDays (60)`. Before that date the curve shows stage Fresh, day 0 and does not run;
  on that date `clock_floor = clock_starts_on` (AS-S5 "clock starts 2 Dec").
- `clock_date = max(last_confirmed_date, clock_floor)`; `day_count = max(0, today − clock_date)`.
- `stage` = Fresh if day ≤ fresh, Ageing if ≤ ageing, Stale if ≤ stale, else Expired. A **Dormant** demand is
  `Paused` (no counting) until reactivated. Closed/Inactive offers and Closed/Lost/Invalid demands are **frozen**
  (`frozen = true`, `next_change_on = null`) and never evaluated again unless reopened (deal cancel, reactivation).
- `next_change_on` = `clock_date + (limit of current stage + 1)`, or `clock_starts_on` while Upcoming, or null when
  Expired/Paused/frozen. The nightly run only touches rows with `next_change_on ≤ today`.

**4.1.3 Confirmation (event-driven, in the request transaction).** Reset `last_confirmed_at`, recompute day/stage/
`next_change_on`, clear `availability_unknown`, close open `reconfirm` / `reconfirm_due` queue items, write
`offer.confirmed.v1` / `demand.confirmed.v1` and, if the stage changed, `lifecycle.stage_changed.v1`
(e.g. Stale → Fresh), all via the outbox. Downstream actions (listings upgrade ceiling, crm-engine resumes) follow
within ≤ 2 min (relay + drain), inside NFR-9's 5 minutes.

**4.1.4 Stage actions** (applied in the same transaction that changes the stage; each writes
`lifecycle.stage_changed.v1` with `from`, `to`, `day`).

| New stage | Offer | Demand |
|---|---|---|
| Fresh | none | none |
| Ageing | `should_call` item, reason `reconfirm` (+ageingReconfirmBoost). Project configuration: reason `request_price_sheet` (AS-S6) | `reconfirm_due` item for the owner (AS-D3 day 31) |
| Stale | reconfirm item moves up (reason `stale_public` + stalePublicBoost when `publication_level` = Public, from `publication.changed.v1`). listings downgrades Public → Anonymous and crm-engine flags `reconfirm` from the event | crm-engine stops new suggestions (from the event); `reconfirm_due` stays |
| Expired | `availability_unknown = true`; item stays. listings unpublishes, crm-engine excludes (from the event) | Automatic **Dormant** exit (§4.2.4): `exit_type='Dormant'`, reason `life_curve_expired`, revisit = today + dormantRevisitDays (60, A-41); emits `demand.exited.v1` then `lifecycle.stage_changed.v1` Expired → Paused |
| Paused | — | set by Dormant; cleared by reactivation (→ Fresh, day 0) |

**4.1.5 Nightly run** (`POST /internal/v1/jobs/life-curve-nightly`, pg_cron 02:00 IST, re-called every minute until
done; must finish by 04:00 IST, NFR-9):
1. Per tenant, keyset over `life_curve_due` (`next_change_on ≤ today`), batches of 1,000 rows, one transaction per batch.
2. For each row: recompute the stage; apply §4.1.4 actions; write outbox rows; set the new `next_change_on`.
3. **Upcoming → Available**: offers with Commercial = Upcoming and `available_from ≤ today` move to Available
   (`offer.commercial_status_changed.v1`), in the same pass (they are in the due set because `next_change_on =
   clock_starts_on ≤ available_from`).
4. The job records its cursor in `job_runs` and returns `done=false` until the due set is empty; a second call on the
   same date after `done=true` is a no-op (idempotent).

### 4.2 Commercial axis and exits (BRD §4.4, §6.1)

**4.2.1 Derivation rule.** Offers and demands take part in many engagements at once (many-to-many matching), so the
Commercial status is **derived** from live engagements rather than moved step by step. It is recomputed in the same
transaction after any engagement change and an event is written only when the value changes.

Offer (unless Closed or Inactive, which are terminal until compensated):
```
In process   if an open deal on the offer exists
Site visit   elif a completed visit (outcome ≠ no-show) with a Confirmed match of a live demand includes it
In proposal  elif a Sent proposal with a live option (Confirmed match) includes it
Matched      elif any Confirmed match (single or bundle) includes it
Upcoming     elif possession_status = Available From and available_from > today
Available    otherwise
```
Demand (unless exited or Closed):
```
In process       if it has an open deal
Site visit       elif it has a completed visit (outcome ≠ client no-show)
Proposal shared  elif it has a Sent proposal
Matched          elif it has a Confirmed match
Sourcing         elif it has an Open / In progress sourcing request
Active           elif qualified
Contacted        elif first_contacted_at is set
New              otherwise
```
Because the rule recomputes from facts, **backwards moves** fall out naturally (BRD "matches and deals can move
backwards"): a rejected/closed match, a cancelled deal or a cancelled visit lowers the status to the next applicable
level (floor Available / Active). "Sourcing is skipped when the CRM already holds a match" is the ordering above.

**4.2.2 Offer transitions and triggers**

| From → To | Trigger | Guard |
|---|---|---|
| (none) → Upcoming / Available | `offer.created.v1` | Upcoming if possession_status = Available From and future date |
| Upcoming → Available | nightly on `available_from`, or call `confirmed` with `availableNow=true` | — |
| Available ↔ Matched ↔ In proposal ↔ Site visit ↔ In process | derivation rule on match / proposal / visit / deal changes | — |
| In process → Closed | deal Closed (§4.7) | single-unit offer; a multi-unit project configuration stays live (records reduces units) |
| any live → Inactive | retire (call `already_gone` / `unwilling`, or `POST …/retire`) | 409 if an open deal exists |
| Closed → derived | deal cancelled after close (Manager) | compensation |
| Inactive → derived (usually Available) | call outcome `confirmed` on an Inactive offer (**R-12**) | life curve reset; `offer.commercial_status_changed.v1` |
| any → (voided) | `offer.voided.v1` (review said it is not supply) | all open items cancelled, curve frozen, no Commercial event (consumers act on the void event) |

**4.2.3 Demand transitions and triggers**

| From → To | Trigger |
|---|---|
| (none) → New | `demand.created.v1` (+ `to_contact` item) |
| New → Contacted | first call with outcome `confirmed` (+ `to_qualify` item) |
| Contacted → Active | `POST …/qualify` (all 4 checklist items true) → `demand.qualified.v1` |
| Active → Sourcing | sourcing request created (unless a Confirmed match exists) |
| … → Matched / Proposal shared / Site visit / In process | derivation rule |
| In process → Closed | deal Closed |
| any non-Closed → exit | `POST …/exit` or automatic Dormant (Expired) |
| Dormant → Active (or derived) | `POST …/reactivate` or a `confirmed` demand call on a Dormant demand → `demand.reactivated.v1` |
| Lost / Invalid → Active | `POST …/reactivate` by Admin/Manager (exit override) |

**4.2.4 Exits (C-16, US-26).** One transaction:
- Guard: no open deal (409 `exit-blocked-by-open-deal`).
- Set `exit_*` fields: Lost needs `reasonCode` (+ optional `competingTerms`); Dormant uses `revisitDate` (default
  today + 60); Invalid needs `reasonCode` (+ optional `flagPerson`).
- Life curve: Dormant → Paused (`paused_until = revisit_date`); Lost/Invalid → frozen.
- Cancel open sourcing requests (status Cancelled) and close all open queue items of the demand.
- Notify owners of offers in **Confirmed** matches of this demand ("DEM-x exited: Lost").
- Outbox: `demand.exited.v1`, `lifecycle.stage_changed.v1`, `audit.recorded.v1`.
- crm-engine releases matches on the event (`match.closed.v1` reason `demand_exited`); listings takes down the demand post.
- `demand.exited.v1` carries `reason`, `competingTerms` (business terms only), `competingPriceInr`, `flagPerson` and
  `personId`; records consumes it to store competing terms as market data (Lost) and to flag the person (Invalid).

**4.2.5 Reactivation.** Clears `exit_*`, unfreezes the life curve with a confirmation (day 0, Fresh), re-derives the
status (normally Active), emits `demand.reactivated.v1` (+ `demand.status_changed.v1`, `lifecycle.stage_changed.v1`,
`demand.confirmed.v1`). crm-engine re-matches on the event.

### 4.3 Queues (PRD §4.2, §4.3, D-10, US-12, US-19)

**4.3.1 Sections.** Every section is a set of rows in `queue_items` (one open row per section and subject).

| Team | Section | Created when | Closed when | Order |
|---|---|---|---|---|
| supply | `must_call` | enquiry on the offer (`enquiry`); new match on an offer not yet Contacted, or any newly Confirmed match (`match`); offer created with `sourcedForDemandId` (`sourced_for`, priority 1) | call logged on the offer; offer retired/closed | priority desc, due_at asc (overdue first) |
| supply | `should_call` | new capture (`new_capture`), Ageing/Stale/Expired reconfirm (`reconfirm`, `stale_public`), project sheet (`request_price_sheet`) | call logged; stage back to Fresh; retire/close | rank desc |
| supply | `sourcing_requests` | SRQ assigned | SRQ Fulfilled/Cancelled | due_date asc |
| supply | `watchlist_tasks` | `watchlist_item.created.v1` | task Done/Cancelled | deadline asc |
| demand | `to_contact` | demand created; 3rd no-answer (`unreachable`) | first `confirmed` call; exit | due_at asc (created + 24 h) |
| demand | `to_qualify` | first `confirmed` call | qualified; exit | due_at asc |
| demand | `reconfirm_due` | demand Ageing/Stale | confirmation; exit | due_at asc |
| demand | `needs_sourcing` | `demand.matching_completed.v1` with `matchCount = 0` and `bundleCount = 0` for a qualified demand | first match arrives; SRQ raised; exit | due_at asc |
| demand | `in_sourcing` | status Sourcing | status leaves Sourcing | due_at = SRQ due |
| demand | `sourcing_requests_open` | SRQ raised by me | SRQ closed | due_date asc |
| demand | `open_matches` | ≥ 1 Suggested match on a qualified demand (one item per demand, count in summary) | no Suggested matches left | due_at asc |
| demand | `proposals_out` | proposal Sent | feedback recorded on every option; exit | sent_at asc |
| demand | `site_visits_this_week` | visit Scheduled | visit Completed/Cancelled | scheduled_at asc |
| demand | `deals_follow_up` | deal opened | deal Closed/Cancelled | follow_up_date asc (overdue first, R13) |
| demand | `dormant_revisits` | Dormant with `revisit_date ≤ today` (dormant-revisit job) | reactivated or exited again | revisit_date asc |

Items for subjects with `outside_launch_area = true` are never created (CR-006 Z-7). Non-Property scopes never enter
queues (they have no offer/demand).

**4.3.2 Must call due time.** `due_at = event occurredAt + mustCallDueHours (24)` (BRD §5.2: within 24 h of the enquiry
upload). `overdue = due_at < now()`; overdue items render red and sort first within their priority.

**4.3.3 Should call rank** (weights = `settings(kind='queue_weights')`, Admin-editable):
```
F  freshness     = max(0, 1 − daysSince(last_seen_on) / freshnessHorizonDays)                 (default horizon 60)
G  demand gap    = clamp(gap(cell) / demandGapCap, 0, 1)                                       (default cap 20)
                   cell = (segment, deal_type, micromarket); gap = open_demand − matching_supply
S  source quality= source_quality.score for the offer's source_type                             (default 0.5)
                   score = (verified_or_matched_90d + 2.5) / (captured_90d + 5)   (smoothed share)
P  price band    = 1.0 if price ∈ [p25, p75] of open-demand budgets in the cell, 0.5 if ∈ [p10, p90], 0.1 otherwise,
                   0.3 if the offer has no price; price = sale_price_inr_min (Sale, Pagdi) or rent_monthly_inr_min (Lease);
                   JV → 0.5
rank = 100 × (wF·F + wG·G + wS·S + wP·P) / (wF + wG + wS + wP) + boost
boost = stalePublicBoost (15) if Stale and Public; ageingReconfirmBoost (5) if Ageing reconfirm; 0 otherwise
defaults: wF 0.25, wG 0.35, wS 0.20, wP 0.20
```
`open_demand` counts demands that are not exited/Closed, not Expired, inside the launch area, whose `deal_types`
contain the cell deal_type and whose `micromarkets` contain the cell micromarket; `matching_supply` counts offers in
the cell with Commercial ∈ {Upcoming, Available} and stage ≠ Expired. `demand-gap-refresh` recomputes every cell
nightly; event handlers also adjust the affected cell's counts incrementally and mark items in that cell
`rank_dirty`. `rank-refresh` (every 5 min) recomputes dirty ranks. Rank factors are stored in `rank_factors` and
shown as the reason (US-12 AC2: "new · demand gap 12").

**4.3.4 Daily list** (D-10). For a user on date d:
`shouldSlots = max(0, capacity − openMustCall − callsLoggedToday)`; today's list = all open `must_call` items + the
top `shouldSlots` open `should_call` items (excluding items with `next_call_date > d`). `plannedToday` is computed on
read (`GET /v1/queues/me`), so capacity changes apply immediately. Capacity default 40 (A-36); a user without a
capacity row gets 40 on first read.

**4.3.5 Assignment.** Offer items → `offer_view.owner_user_id`; demand items → `demand_view.owner_user_id`; SRQ items →
the SRQ assignee; watchlist tasks → the task assignee. When the owner is unknown or inactive, the item goes to the
**least-loaded** active user of the team role (`staff_users` from `user.changed.v1`: Supply agent / Demand agent;
lowest open count in `queue_counters`, tie → lowest user id) (assumption JA-4). When `user.changed.v1` deactivates a
user, their open items are reassigned the same way (system actor, R-7) and Managers are notified.

**4.3.6 Queue counts for dashboards (R-18).** Every counter change sets `queue_counters.changed_at`. The
`queue-counts-flush` job (every minute) emits one `queue.counts_changed.v1` per user whose counters changed since
`emitted_at` (all section counts in one event), so insight builds the queue tiles without synchronous calls. Managers can reassign in bulk (`POST /v1/queue-items/reassign`, ≤ 100 items).

### 4.4 Call outcomes and the 3-attempt rule (C-08, US-12 AC3, A-37)

| Subject | Outcome | Effect (one transaction) | Events |
|---|---|---|---|
| offer | `confirmed` | Life curve reset (§4.1.3); `availableNow` → Upcoming → Available; an **Inactive offer is reactivated** (R-12, status re-derived); close the queue item; reset attempts | `offer.confirmed.v1` (how = channel); `lifecycle.stage_changed.v1` and `offer.commercial_status_changed.v1` when they change |
| offer | `no_answer` | attempts + 1; `next_call_date` = given or next day; item stays open. 3rd consecutive → item closed (`unreachable`), `personUnreachable = true` | `call.logged.v1` (records flags the person unreachable) |
| offer | `already_gone` | Retire → Inactive (reason `already_gone`, `knownPriceInr` → records market data), close items | `offer.retired.v1`, `offer.commercial_status_changed.v1` |
| offer | `unwilling` | Retire → Inactive (reason `unwilling`: never published, kept for intelligence) | `offer.retired.v1`, `offer.commercial_status_changed.v1` |
| demand | `confirmed` | Life curve reset; New → Contacted (+ `to_qualify` item); Dormant → reactivated | `demand.confirmed.v1`; `demand.status_changed.v1` / `demand.reactivated.v1` when applicable |
| demand | `no_answer` | attempts + 1; 3rd consecutive → `demand_journey.unreachable = true`, item moves to `to_contact` with reason `unreachable`; the agent then exits as Invalid (`reasonCode = unreachable`, AS-D4). No automatic exit (assumption JA-5). | — |
| demand | `already_gone`, `unwilling` | 400 `outcome-not-allowed` (use exit) | — |

Every call writes `call.logged.v1` (callId, subject, personId, outcome, attempt, `personUnreachable`, calledBy) in the
same transaction. "Consecutive" is counted per queue item and per person (`person_state.consecutive_no_answer`); any answered call
resets both. The `personId` comes from the call card (web knows who was dialled); without it only the item counter is
kept. Fact edits made on the same card (price, availability, areas, an extra offer on the property) go from web to
records in parallel (HLD §5.2); journeys never edits facts.

### 4.5 Qualification and sourcing (C-09, C-11, US-20, US-22)
- Qualify: requires the four checklist items; sets `qualified_at`, derived status → Active, confirms the life curve,
  emits `demand.qualified.v1`; crm-engine runs the inventory check and answers with `demand.matching_completed.v1`;
  `matchCount = 0` and `bundleCount = 0` → `needs_sourcing` item and a notification to the owner.
- Sourcing request: demand must be qualified, not exited; creates SRQ (Open), queue items for the assignee
  (`sourcing_requests`) and the requester (`sourcing_requests_open`), notification to the assignee; emits
  `sourcing_request.created.v1` and `demand.sourcing_started.v1` (`postAnonymously` drives the anonymous demand post
  in listings). Offers created by records with `sourcedForDemandId` = this demand are appended to `offer_ids`
  (from `offer.created.v1`), get a top-priority `must_call` item and notify the requester. The SRQ is Fulfilled by the
  assignee or requester (PATCH); Cancelled on exit or when the demand is voided. Every status change emits
  `sourcing_request.updated.v1` (status mapped to the event's lowercase values: `open`, `in_progress`, `fulfilled`, `cancelled`).

### 4.6 Proposals (C-13, US-23, D-11)
1. `POST /v1/proposals`: every option must be a **Confirmed** match of the demand in `match_view` (409
   `match-not-confirmed`). Status `Preparing`; a work item `build_snapshot` is queued on `q_journeys_work`.
2. **Snapshot** (async worker): records owns the property/offer content, so the worker calls records' **existing GET
   endpoints** (`GET /v1/offers/{id}`, `GET /v1/properties/{id}` incl. building name and photos) with a service token
   minted by web (R-2); it copies up to 30 photos per option into bucket `journeys-proposals/{tenant}/{proposalId}/`.
   The 11 Estates MahaRERA number is owned by listings (publication settings) and read from listings
   `GET /v1/publication-settings` with a service token (also when rendering the PDF). **Validation strips anything that is not on an allow-list** (no owner/broker
   names, phones, emails, unit or wing). Status → `Ready` (or `Failed` after 3 attempts, with a notification).
3. **PDF** (`POST …/pdf`): queues `render_pdf`; the worker renders from the snapshot and stores
   `journeys-proposals/{tenant}/{proposalId}/{code}.pdf`; `GET …/pdf` returns a 5-minute signed URL.
4. **Share link** (`POST …/share-link`): 32 random bytes, base64url (43 chars); stores `sha256(token)` only; default and
   maximum expiry 14 days (A-40); creating a new link revokes the previous one. `GET /p/{token}` (via web's public route,
   no staff auth) looks up the hash, rejects expired/revoked with 410, records the open (count, time, salted IP hash),
   notifies the creator on the first open, and returns the snapshot with 10-minute signed photo URLs.
   Headers: `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`.
5. **Mark sent** logs `sent_at` + channel (the system sends nothing, BRD out of scope), creates `proposals_out`, derives
   offers → In proposal and demand → Proposal shared, emits `proposal.sent.v1` (matchIds of the options).
6. Options can be edited only before Sent (PATCH rebuilds the snapshot → Preparing).

### 4.7 Site visits and deals (C-14, C-15, US-24, US-25, US-27)
**Visits.** Scheduled → Completed | Cancelled. Offers must be in a live match with the demand (409
`offer-not-matched`). Completion resets the life curve of the demand (unless `Client no-show`) and of each visited
offer (unless `Owner no-show`), derives statuses, emits `site_visit.completed.v1`, `offer.confirmed.v1` (how=visit)
per offer, `demand.confirmed.v1` (how=visit).

**Deal state machine.**
```
Negotiation → Documentation → Stamp duty & registration → Closed        (forward only; skipping forward allowed)
     └──────────────┴────────────────────┴──────────→ Cancelled         (POST …/cancel, any open stage)
Closed ──(Admin/Manager: token refunded after close)──→ Cancelled
```
- Open (`POST /v1/deals`): one open deal per demand; one per offer unless the offer is a multi-unit project
  configuration (`unit_count > 1` → `multi_unit = true`). `nextAction` and `followUpDate ≥ today` required (DB check +
  400 `follow-up-required`). Emits `deal.opened.v1`; offer and demand → In process.
- Every PATCH while open must carry `nextAction` + `followUpDate` (R13). Overdue deals sort first in `deals_follow_up`.
  Every stage, terms or follow-up change emits `deal.updated.v1` (stage, followUpDate, overdue); the 08:00 job emits it
  again with `overdue = true` for deals that became overdue.
  `POST …/follow-ups` logs the follow-up (deal_events), sets the next one and confirms both life curves
  (how = `deal_follow_up`, artifact: "follow ups every 2 days reset the life curve").
- **Close** (PATCH `stage=Closed`, requires `closingPriceInr`; Lease requires `agreedTerms.leaseMonths`) — one
  transaction (HLD §7 "strong, same owner"):
  1. deal Closed (`closed_at`), deal_events row;
  2. offer → Closed (single-unit) and life curve frozen; multi-unit: offer re-derived (stays live);
  3. demand → Closed, life curve frozen, all open queue items of both closed;
  4. if Lease and `leaseMonths = 11`: `lease_renewals` row with `lease_start_date = agreedTerms.leaseStartDate ??
     closed_at::date`, `due_on = start + 10 months`, `available_from = start + 11 months`;
  5. notification to the offer owner;
  6. outbox: `deal.closed.v1` (closingPriceInr, dealType, leaseMonths, `unitsBooked` for project configurations → records
     reduces the unit count), `deal.updated.v1`, `offer.commercial_status_changed.v1`,
     `demand.status_changed.v1`, `audit.recorded.v1`.
  Then (async, the saga in HLD §5.4): crm-engine closes the offer's other matches (`match.closed.v1`
  leased/sold_to_another_client) → journeys notifies each affected demand owner and re-derives those demands (they
  "return to matching"); listings unpublishes; records stores the closing price as market data.
- **Cancel** (compensation, US-25 AC1): deal Cancelled (kept), cancel reason recorded; offer and demand re-derived
  (floor Available / Active; a closed offer/demand is unfrozen and its stage recomputed from the last confirmation); scheduled lease renewal
  cancelled; emits `deal.cancelled.v1` + status events. crm-engine reopens matches it closed for this deal; listings
  recomputes; records voids the market data point.

**Lease renewal (US-16).** `lease-renewal-scan` (05:00 IST) emits `lease_renewal.due.v1` (propertyId,
previousOfferId, availableFrom) for `status='scheduled' and due_on ≤ today`, sets `emitted`. records creates the
Upcoming offer, which arrives as `offer.created.v1` (possession_status Available From) → Commercial Upcoming,
life curve starts 60 days before (§4.1.2).

### 4.8 Notifications (FR-NTF-1)
Work notifications only (R-6: upload, export and user notifications belong to web; the UI merges both lists).
In-app, stored in `notifications`, kept 90 days. Titles use codes and generated labels only. Throttling by
`dedupe_key` (e.g. `match_suggested:<demandId>`): while an unread notification with the same key exists, the new one
updates its title ("3 new matches for DEM-000127") instead of inserting. Triggers: match suggested (demand owner),
match confirmed (offer owner), match closed with leased/sold reason (demand owner), price-above-budget flag (demand
owner), SRQ assigned/fulfilled, enquiry (offer owner), offer closed, demand exited (offer owners), deal follow-up
overdue (08:00 job), proposal first open, visit scheduled (attendees), Dormant revisit due, watchlist task assigned.

### 4.9 Watchlist tasks (D-14, US-36 AC2)
`watchlist_item.created.v1` → one task (Open), assignee = least-loaded supply agent, `due_date = deadline − 7 days` if
the deadline is ≥ 7 days away, else today + 2 (assumption JA-6), plus a `watchlist_tasks` queue item. Managers
assign/cancel (PATCH); Supply agents, Managers and Admins complete it (`watchlist_task.completed.v1`).

### 4.10 Sagas and compensations (HLD §7)

| Saga | journeys' step | Compensation handled by journeys |
|---|---|---|
| Deal close | local transaction (§4.7) + `deal.closed.v1` | `POST …/cancel` → `deal.cancelled.v1`, offer → Available, demand → Active, renewal cancelled |
| Merge | re-point rows on `records.merged.v1` (§4.11) | `records.merge_undone.v1` → restore from `merge_log` |
| Demand exit | `demand.exited.v1` | reactivation → `demand.reactivated.v1` |
| Sourced supply | Must call item for the new offer | offer already gone → retire → `offer.retired.v1` (crm-engine drops the match) |
| Call outcome (two writes from web) | journeys write is independent and idempotent (Idempotency-Key) | none needed; web retries the failed half (HLD §7) |

### 4.11 Merges
`records.merged.v1` with aggregateType `offer` or `demand`: in one transaction, write before-images to `merge_log`,
then re-point `queue_items`, `calls`, `life_curve`, `offer_journey` / `demand_journey`, `sourcing_requests`,
`proposal_options.offer_ids`, `site_visits`, `deals`, `lease_renewals`, `subject_contacts` from each merged id to the
survivor. Conflicts: the survivor keeps the latest `last_confirmed_at`, the most advanced derived status, the sum of
signals; duplicate open queue items collapse into one (earliest `due_at`). Merged projection rows get `merged_into`.
`person`: `person_state` and `subject_contacts` are merged. `property`: no-op. `records.merge_undone.v1` replays the
before-images (rows changed since the merge keep their newer fields where the before-image is older; conflicts are
logged for review).

### 4.12 Assumptions (journeys)
| # | Assumption |
|---|---|
| JA-1 | (now R-12) A multi-deal demand uses the shortest thresholds among its deal types. |
| JA-2 | Industrial precedence over Land/JV and Pagdi when several category rules apply (D-12 "Industrial, any deal"). |
| JA-3 | Must call on match: any newly Confirmed match, and a Suggested match only when the offer is not yet Contacted (PRD §4.2 + US-29/A-42). |
| JA-4 | Items without a known owner go to the least-loaded team member with a capacity row. |
| JA-5 | Three unanswered calls never exit a demand automatically; the agent confirms Invalid (AS-D4). |
| JA-6 | Watchlist task due date = deadline − 7 days (or today + 2 when the deadline is closer). |
| JA-7 | An enquiry on a project (no offerId) creates one Must call item on the project's oldest live configuration offer. |
| JA-8 | `available_from` for month/year precision = first day of the period (the life curve starts earlier, never later). |
| JA-9 | Offer Commercial status is derived from its most advanced live engagement across all demands (§4.2.1). |
| JA-10 | A Closed deal can be cancelled only by Admin/Manager (token refunded after registration). |
| JA-11 | (now R-15) Proposal snapshots, copied photos and PDFs are kept 24 months. |
| JA-12 | Automatic actions (nightly run, auto-Dormant, reassignment on deactivation) use the system actor `00000000-0000-0000-0000-000000000001` in audit entries and `changedBy` (R-7). |

## 5. Events

Payloads and consumers are exactly those in `contracts/asyncapi/events.yaml`. Every event carries the envelope in
conventions §5; `aggregateVersion` comes from `aggregate_versions`.

### 5.1 Produced

| Event | aggregateType / id | Trigger |
|---|---|---|
| `offer.confirmed.v1` | offer / offerId | Call/meeting `confirmed` on an offer; visit completed (per visited offer); deal follow-up; `price_sheet.applied.v1` (how = `price_sheet`, per configuration) |
| `demand.confirmed.v1` | demand / demandId | Demand call `confirmed`; qualification; visit completed; deal follow-up; reactivation |
| `lifecycle.stage_changed.v1` | offer or demand / subjectId | Any stage change: confirmation, nightly run, Dormant (→ Paused), reactivation (Paused → Fresh), deal cancel when the unfrozen stage differs. Deal close does not emit (the curve is frozen, stage unchanged) |
| `offer.commercial_status_changed.v1` | offer / offerId | Every change of the derived Commercial status, incl. creation (`from` absent → Upcoming/Available), retire, reactivation (R-12), close, cancel |
| `demand.qualified.v1` | demand | `POST …/qualify` |
| `demand.status_changed.v1` | demand | Every change of the derived demand status, incl. creation (→ New) |
| `demand.exited.v1` | demand | `POST …/exit`; automatic Dormant on Expired. Carries `reason`, `competingTerms`, `competingPriceInr`, `flagPerson`, `personId`, `revisitDate` |
| `demand.reactivated.v1` | demand | `POST …/reactivate`; `confirmed` call on a Dormant demand |
| `demand.sourcing_started.v1` | demand | Sourcing request created |
| `sourcing_request.created.v1` | sourcing_request | Sourcing request created |
| `sourcing_request.updated.v1` | sourcing_request | Status change (PATCH, exit, void) |
| `proposal.sent.v1` | proposal | `POST …/mark-sent` |
| `proposal.feedback_recorded.v1` | proposal | `POST …/feedback` (verdicts `liked`, `rejected`, `visit_requested` per matchId; feeds crm-engine M6) |
| `site_visit.scheduled.v1` | site_visit | `POST /v1/site-visits` |
| `site_visit.completed.v1` | site_visit | `POST …/complete` |
| `deal.opened.v1` | deal | `POST /v1/deals` |
| `deal.updated.v1` | deal | Open, stage/terms/follow-up change, close, cancel; follow-up-reminders (overdue = true) |
| `deal.closed.v1` | deal | PATCH stage = Closed (incl. `unitsBooked`) |
| `deal.cancelled.v1` | deal | `POST …/cancel` |
| `offer.retired.v1` | offer | Call `already_gone` / `unwilling`; `POST …/retire` |
| `call.logged.v1` | call | Every `POST /v1/calls` (with `attempt`, `personUnreachable`) |
| `lease_renewal.due.v1` | lease_renewal | lease-renewal-scan, `due_on ≤ today` |
| `watchlist_task.completed.v1` | watchlist_task | `POST …/complete` |
| `queue.counts_changed.v1` | user / userId | queue-counts-flush, at most once per minute per user (R-18) |
| `audit.recorded.v1` | varies | Exit, deal close/cancel, share-link create/revoke, reassign, capacity/threshold/weight changes, retire; `actorUserId` = system actor for automatic actions (R-7) |

### 5.2 Consumed (queue `q_journeys`)

Each message: dedupe on `eventId` (`processed_events`, same transaction as the effect); projection updates apply only
if `aggregateVersion` is newer than the stored version for that kind of data (`facts_version` for full-facts events,
`stage_version`, `publication_version`, `source_version`, `flag_version`). journeys now receives the full offer and
demand fact streams, so a version gap in `facts_version` is healed by the next full-facts event; if a row still has no
facts after 10 minutes it is re-read from records' GET API with a web-issued service token (R-2).

| Event (producer) | Handling |
|---|---|
| `offer.created.v1` (records) | Upsert `offer_view` (incl. `lastSeenDate`, `priceSheetDate`, `contactPersonIds` → `subject_contacts`). Create `offer_journey` (Upcoming/Available) + `life_curve`; `should_call` `new_capture` item (or `must_call` `sourced_for`, priority 1, when `sourcedForDemandId` is set — also append to that demand's open SRQ and notify the requester); update demand-gap cell. Skip queues if `outsideLaunchArea`. Emits `offer.commercial_status_changed.v1`. |
| `offer.updated.v1` (records) | Replace facts if newer; recompute category key, `available_from`, Upcoming clock, `last_seen_on`; move demand-gap cells; mark rank dirty. A category change recomputes stage and `next_change_on` (may emit `lifecycle.stage_changed.v1`). |
| `offer.price_changed.v1` (records) | Update price fields from typed `current`; mark rank dirty (price band). |
| `price_sheet.applied.v1` (records) | For each configuration of the project (`changedOfferIds`, else all live configurations): `clock_floor = sheetDate`, confirmation how = `price_sheet`, close `request_price_sheet` items. |
| `offer.record_stage_changed.v1` (records) | Update `record_stage`, `has_real_photos` if `stage_version` < v. Reaching Contacted or beyond clears the "not yet Contacted" Must call condition; updates source-quality counters. |
| `offer.voided.v1` (records) | Mark voided; cancel open queue items, freeze the life curve; no Commercial event. |
| `demand.created.v1` (records) | Upsert `demand_view`; create `demand_journey` (New), `life_curve`, `to_contact` item for the owner (due +24 h); update demand-gap cells. Emits `demand.status_changed.v1`. |
| `demand.updated.v1` (records) | Replace facts if newer (`moveInFrom`, `moveInBy`, deal types …); recompute category key (R-12) and demand-gap cells. |
| `demand.voided.v1` (records) | Mark voided; cancel queue items and open SRQs (`sourcing_request.updated.v1`); freeze the curve. |
| `demand.touch_added.v1` (records) | `touch_count + 1`, `last_seen_on = today` (no life-curve reset); notify the owner ("second touch via Digi"). |
| `enquiry.received.v1` (records) | If `offerId` (or `projectId`, JA-7): `enquiry_count + 1`, upsert `must_call` item reason `enquiry`, `reasonRef = ENQ-…`, `due_at = receivedAt + 24 h`; notify the offer owner. |
| `records.merged.v1` / `records.merge_undone.v1` (records) | §4.11. |
| `person.flagged.v1` / `person.flag_removed.v1` (records) | Update `person_state.flags` (if `flag_version` < v). `invalid` / `unwilling`: close open offer items of subjects linked through `subject_contacts` / `contact_person_ids`; removal re-opens nothing automatically (the next reconfirm cycle picks the subject up). |
| `watchlist_item.created.v1` (records) | Create the watchlist task + queue item (§4.9). |
| `publication.changed.v1` (listings) | `subjectType = offer`: set `publication_level` if newer; Stale + Public → `stale_public` boost; rank dirty. Other subject types ignored. |
| `user.changed.v1` (web) | Upsert `staff_users`; deactivation → reassign open items (§4.3.5); role change moves the capacity row's team. |
| `match.suggested.v1` (crm-engine) | Upsert `match_view` if `source_version` < v (a Confirmed match keeps its status; only score/flags change). Offer not yet Contacted → `must_call` (reason `match`). Qualified demand → `open_matches` item; clears `needs_sourcing`. Throttled notification to the demand owner. |
| `match.confirmed.v1` (crm-engine) | `match_view.status = Confirmed`; derive offer(s) and demand (Matched); `must_call` for each offer (JA-3); notify offer owner(s). |
| `match.rejected.v1` (crm-engine) | Status Rejected; re-derive (may move back to Active / Available); close `open_matches` if none left. |
| `match.closed.v1` (crm-engine) | Status Closed + reason (incl. `superseded`, `offer_expired`, `deal_closed`, `demand_closed`, `voided`); re-derive; leased/sold_to_another_client → notify the demand owner. |
| `match.reopened.v1` (crm-engine) | Status back to its reopened state (Suggested, or Confirmed for the cancelled deal's own match as sent by crm-engine); re-derive; notify the demand owner. |
| `match.flagged.v1` (crm-engine) | Add or (`cleared = true`) remove the flag; new `price_above_budget` → notify the demand owner (AS-S6). |
| `demand.matching_completed.v1` (crm-engine) | Inventory check done: `matchCount + bundleCount = 0` on a qualified demand → `needs_sourcing` item + notification; otherwise close `needs_sourcing`. |

## 6. Error codes

Common codes from conventions §4 apply (`validation-failed`, `unauthenticated`, `forbidden`, `not-found`, `conflict`,
`idempotency-key-reused`, `version-mismatch`, `rate-limited`, `internal`, `dependency-unavailable`). Service codes:

| Code | HTTP | When |
|---|---|---|
| `invalid-transition` | 409 | Action not allowed from the current Commercial status / stage (e.g. retire a Closed offer, qualify an exited demand, PATCH a deal backwards) |
| `exit-blocked-by-open-deal` | 409 | Exit or retire while a deal is open |
| `deal-already-open` | 409 | Second open deal for the demand, or for a single-unit offer |
| `match-not-confirmed` | 409 | Proposal option / deal matchId is not a Confirmed match of the demand |
| `offer-not-matched` | 409 | Visit offer not in a live match with the demand |
| `proposal-not-ready` | 409 | PDF / share link while the snapshot is Preparing or Failed |
| `proposal-already-sent` | 409 | PATCH options or mark-sent twice with different data |
| `outside-launch-area` | 409 | Journey action on a subject flagged outside MMR (Z-7) |
| `qualification-incomplete` | 400 | Qualify with any checklist item false |
| `outcome-not-allowed` | 400 | `already_gone` / `unwilling` on a demand |
| `follow-up-required` | 400 | Open deal change without `nextAction` + `followUpDate ≥ today` |
| `closing-terms-required` | 400 | Close without `closingPriceInr` (or `leaseMonths` for Lease) |
| `invalid-thresholds` | 400 | Thresholds not strictly increasing, or weights all zero |
| `unknown-section` / `unknown-job` / `unknown-queue` | 404 | Path enum value not recognised |
| `link-not-found` | 404 | Share token unknown |
| `link-expired` | 410 | Share token expired or revoked |
| `not-owner` | 403 | Role allowed but the resource belongs to someone else where ownership matters (SRQ status by non-assignee, capacity of another user) |
| `cron-secret-invalid` | 401 | Missing/wrong `X-Cron-Secret` |
| `job-in-progress` | 409 | A job call while the previous call for the same job and date still holds its lock |
| `snapshot-failed` | 503 | records or listings GET endpoints unavailable after retries (async; surfaced as proposal status Failed) |

## 7. PII fields and retention

journeys holds **no contact identity** (names, phones, emails) of its own. Person ids are pseudonymous references to
records. Free-text fields may contain personal data typed by staff and are treated as PII: never logged (log
allow-list), never put in events, returned only to authenticated staff.

| Table.column | Class | Retention |
|---|---|---|
| `calls.notes` | PII (free text) | 24 months after the subject's last journeys activity (NFR-18), then set to null; the call row (outcome, dates) is kept |
| `sourcing_requests.notes`, `proposals.cover_note`, `proposal_options.feedback_note`, `site_visits.notes`, `deal_events.note`, `deals.cancel_reason`, `deals.agreed_terms.otherTerms`, `demand_journey.exit_reason`, `demand_journey.competing_terms`, `demand_journey.qualification.decisionMakerNote`, `watchlist_tasks.outcome` | PII possible | same rule: nulled 24 months after last activity |
| `proposals.snapshot` + copied photos + PDF | Confidential (building names; never contacts, unit or wing) | Kept 24 months (R-15), then deleted; proposal row kept |
| `staff_users.display_name` | Staff PII (conventions §9) | Until `user.changed.v1` deactivation + 24 months |
| `proposal_link_opens.ip_hash` | Pseudonymous (salted SHA-256; salt rotated monthly) | 90 days |
| `notifications` | No PII (codes/labels) | 90 days |
| `person_state`, `subject_contacts` | Pseudonymous ids | 24 months after the last call or link (no person purge event yet, gap G-6) |
| `outbox` (published) / `processed_events` / `idempotency_keys` | No PII | 7 days / 30 days / 24 h |

`retention-purge` (weekly) applies these rules in keyset batches. Tenant deletion drops all rows for the tenant.

## 8. Performance notes

| Target | Design |
|---|---|
| **NFR-2** p95 < 300 ms (sync APIs) | Every request touches ≤ ~10 rows by PK or a covering index; one transaction with outbox inserts; **no cross-service calls on the request path** (snapshot, PDF and projection re-reads are async). Idempotency check is one unique-index lookup. Pool: journeys' Supavisor budget from the capacity plan (transaction mode). |
| **NFR-8** My queue ≤ 1 s | `GET /v1/queues/me` reads `queue_counters` (≤ 15 rows) + capacity + today's call count (index range). A section page is one index range scan (`queue_open_due` / `queue_open_rank`) with `limit ≤ 100` plus a PK join to projections for the summary line. Counters are updated in the same transaction as the item (aggregated per drain batch during bulk loads) and reconciled nightly. |
| **NFR-9** life curve ≤ 5 min / nightly by 04:00 IST | Confirmations apply in-request; downstream effects via relay (≤ 1 min) + consumer drain (≤ 1 min). Nightly touches only `next_change_on ≤ today` rows: at 5M subjects roughly 1–3% change per day (≤ 150k rows) → ~150 batches of 1,000 at ~1–2 s each, spread over repeated 55 s job calls — well under 2 h. |
| Bulk uploads (NFR-5) | A 100k-row upload yields ~100k `offer.created.v1`: the drain applies them in batches of 100 with multi-row upserts; demand-gap and counters are aggregated per batch; ranks are marked dirty and recomputed by `rank-refresh`. Throughput ≈ 1,000–2,000 events/min per drain invocation; several invocations run in parallel (pgmq visibility timeout). |
| Pilot (§8.4) | ≤ 200k records, ≤ 20k rows per file, Vercel Hobby limits: job and drain calls stop at a 50 s budget and continue next minute; PDF rendering runs in the drain with one proposal per call. Storage estimate at 200k subjects: projections + life curves + queue items ≈ 150–250 MB incl. indexes, which is a large share of the 500 MB free database (see Q-J6). |

## 9. Endpoint summary

Auth: staff = `staffViaWeb`, service = `serviceToken`, cron = `cronSecret`, share token = path token. Roles: Adm =
Admin, Mgr = Manager, Dem = Demand agent, Sup = Supply agent, Op = Data operator, all = all five. Rate limits are
enforced at web (conventions §4); internal routes are limited by the scheduler.

| Method | Path | Auth | Roles | Idempotency | Paginated | Rate limit | Timeout | Emits |
|---|---|---|---|---|---|---|---|---|
| GET | `/v1/queues/me` | staff | Adm, Mgr, Dem, Sup | safe | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/queues/me/sections/{section}` | staff | Adm, Mgr, Dem, Sup | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/queues/users/{userId}` | staff | Adm, Mgr | safe | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/queues/users/{userId}/sections/{section}` | staff | Adm, Mgr | safe | yes | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/queue-items/reassign` | staff | Adm, Mgr | Idempotency-Key | — | 20/s/user (web) | 2000 ms | audit.recorded |
| GET | `/v1/capacities` | staff | Adm, Mgr | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/capacities/{userId}` | staff | Adm, Mgr, Dem, Sup | safe | — | 20/s/user (web) | 2000 ms | — |
| PUT | `/v1/capacities/{userId}` | staff | Adm, Mgr | If-Match | — | 20/s/user (web) | 2000 ms | audit.recorded |
| POST | `/v1/calls` | staff | Adm, Mgr, Dem, Sup | Idempotency-Key | — | 20/s/user (web) | 2000 ms | call.logged, offer.confirmed, demand.confirmed, lifecycle.stage_changed, offer.commercial_status_changed, demand.status_changed, demand.reactivated, offer.retired |
| GET | `/v1/calls` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/life-curves/{subjectType}/{subjectId}` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/offers/{idOrCode}/journey` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/offers/{idOrCode}/retire` | staff | Adm, Mgr, Sup | Idempotency-Key | — | 20/s/user (web) | 2000 ms | offer.retired, offer.commercial_status_changed, audit.recorded |
| GET | `/v1/demands/{idOrCode}/journey` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/demands/{idOrCode}/qualify` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | demand.qualified, demand.status_changed, demand.confirmed, lifecycle.stage_changed |
| POST | `/v1/demands/{idOrCode}/exit` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | demand.exited, lifecycle.stage_changed, sourcing_request.updated, audit.recorded |
| POST | `/v1/demands/{idOrCode}/reactivate` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | demand.reactivated, demand.status_changed, lifecycle.stage_changed, demand.confirmed, audit.recorded |
| POST | `/v1/sourcing-requests` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | sourcing_request.created, demand.sourcing_started, demand.status_changed |
| GET | `/v1/sourcing-requests` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/sourcing-requests/{idOrCode}` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| PATCH | `/v1/sourcing-requests/{idOrCode}` | staff | Adm, Mgr, Dem, Sup | If-Match | — | 20/s/user (web) | 2000 ms | sourcing_request.updated, demand.status_changed |
| POST | `/v1/proposals` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/proposals` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/proposals/{idOrCode}` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| PATCH | `/v1/proposals/{idOrCode}` | staff | Adm, Mgr, Dem | If-Match | — | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/proposals/{idOrCode}/pdf` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/proposals/{idOrCode}/pdf` | staff | Adm, Mgr, Dem | safe | — | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/proposals/{idOrCode}/share-link` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | audit.recorded |
| DELETE | `/v1/proposals/{idOrCode}/share-link` | staff | Adm, Mgr, Dem | DELETE is idempotent | — | 20/s/user (web) | 2000 ms | audit.recorded |
| POST | `/v1/proposals/{idOrCode}/mark-sent` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | proposal.sent, offer.commercial_status_changed, demand.status_changed |
| POST | `/v1/proposals/{idOrCode}/feedback` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | proposal.feedback_recorded |
| GET | `/p/{token}` | share token | — | safe | — | 30/min per IP and 120/min per token (enforced at web edge) | 2000 ms | — |
| POST | `/v1/site-visits` | staff | Adm, Mgr, Dem, Sup | Idempotency-Key | — | 20/s/user (web) | 2000 ms | site_visit.scheduled |
| GET | `/v1/site-visits` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/site-visits/{idOrCode}` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| PATCH | `/v1/site-visits/{idOrCode}` | staff | Adm, Mgr, Dem, Sup | If-Match | — | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/site-visits/{idOrCode}/complete` | staff | Adm, Mgr, Dem, Sup | Idempotency-Key | — | 20/s/user (web) | 2000 ms | site_visit.completed, offer.confirmed, demand.confirmed, lifecycle.stage_changed, offer.commercial_status_changed, demand.status_changed |
| POST | `/v1/deals` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | deal.opened, deal.updated, offer.commercial_status_changed, demand.status_changed |
| GET | `/v1/deals` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/deals/{idOrCode}` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| PATCH | `/v1/deals/{idOrCode}` | staff | Adm, Mgr, Dem | If-Match | — | 20/s/user (web) | 2000 ms | deal.updated, deal.closed, offer.commercial_status_changed, demand.status_changed, audit.recorded |
| POST | `/v1/deals/{idOrCode}/cancel` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | deal.cancelled, deal.updated, offer.commercial_status_changed, demand.status_changed, lifecycle.stage_changed, audit.recorded |
| POST | `/v1/deals/{idOrCode}/follow-ups` | staff | Adm, Mgr, Dem, Sup | Idempotency-Key | — | 20/s/user (web) | 2000 ms | deal.updated, demand.confirmed, offer.confirmed, lifecycle.stage_changed |
| GET | `/v1/lease-renewals` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/notifications` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/notifications/unread-count` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/notifications/mark-read` | staff | all | Idempotency-Key | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/watchlist-tasks` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| PATCH | `/v1/watchlist-tasks/{taskId}` | staff | Adm, Mgr | If-Match | — | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/watchlist-tasks/{taskId}/complete` | staff | Adm, Mgr, Sup | Idempotency-Key | — | 20/s/user (web) | 2000 ms | watchlist_task.completed |
| GET | `/v1/settings/life-curve-thresholds` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| PUT | `/v1/settings/life-curve-thresholds` | staff | Adm | If-Match | — | 20/s/user (web) | 2000 ms | audit.recorded |
| GET | `/v1/settings/queue-weights` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| PUT | `/v1/settings/queue-weights` | staff | Adm | If-Match | — | 20/s/user (web) | 2000 ms | audit.recorded |
| GET | `/internal/v1/subject-states` | service | — | safe | yes | 10/s per calling service | 2000 ms | — |
| POST | `/internal/v1/relay` | cron | — | re-runnable | — | pg_cron 1/min | 10000 ms | — |
| POST | `/internal/v1/drain/{queue}` | cron | — | re-runnable | — | pg_cron 1/min | 55000 ms | offer.commercial_status_changed, demand.status_changed, lifecycle.stage_changed, sourcing_request.updated |
| POST | `/internal/v1/jobs/{name}` | cron | — | re-runnable | — | pg_cron 1/min | 55000 ms | queue.counts_changed, deal.updated, lifecycle.stage_changed, demand.exited, offer.commercial_status_changed, lease_renewal.due |
| GET | `/health/live` | none | — | safe | — | unlimited (platform probe) | 500 ms | — |
| GET | `/health/ready` | none | — | safe | — | unlimited (platform probe) | 1000 ms | — |

Total: **60 operations** (53 under `/v1`, 1 public page, 4 internal, 2 health).

## 10. Contract gaps and open questions

Closed by events v0.2 and conventions §10: G-1 (fact streams), G-2 (`publication.changed.v1`), G-3 (`priceSheetDate`,
`lastSeenDate`, `price_sheet.applied.v1`), G-4 (`call.logged.v1`), G-5 (`demand.exited.v1` fields, records consumer),
G-7 (`demand.matching_completed.v1`), G-8 (records' existing GET endpoints + listings `GET /v1/publication-settings`),
G-9 (`match.closed.v1` reasons, `match.reopened.v1`), G-10 (`unitsBooked`), G-11 (`sourcing_request.updated.v1`,
`deal.updated.v1`, `queue.counts_changed.v1`), G-12 (R-19). Q-J1 → R-12, Q-J2 → R-12, Q-J5 → R-15.

Still open:

| # | Gap / question | Impact | Proposal / default |
|---|---|---|---|
| G-6 | No person purge event (NFR-18) | journeys cannot drop pseudonymous person links when records purges a person | `person.purged.v1` (records → journeys, crm-engine, insight); until then links expire 24 months after last use |
| G-13 | `proposal.feedback_recorded.v1` verdicts are `liked` / `rejected` / `visit_requested`; the PRD feedback card had no fixed list | API now uses the event values; "maybe" is not recordable | Confirm the verdict list with the demand team |
| G-14 | Dependency: listings must expose `GET /v1/publication-settings` accepting a journeys service token; records' `GET /v1/properties/{id}` must return the building name to service callers | PDF / snapshot build | Verify in the listings and records LLDs |
| Q-J3 | Must call for Confirmed matches on already-Contacted offers (PRD §4.2 vs US-29) | Call volume | Yes (JA-3) |
| Q-J4 | Watchlist task due date rule | — | JA-6 |
| Q-J6 | Pilot DB budget: journeys projections could use 150–250 MB of the 500 MB free database at 200k records | Pilot storage | Capacity plan to set per-schema budgets |
| Q-J7 | Supply agents on deals: follow-up notes only? | Permissions | Yes (PRD §2.3) |

## Amendments: CR-011 and CR-012 (approved 2026-09-30)
- Proposal feedback `maybe` (neutral). Notification kinds `queue_reassigned`, `proposal_failed`, `demand_touch` replace the stand-in kinds.
- Consume `record.note_imported.v1`: fetch the text from intake's note endpoint (service token), store it as a note marked
  "imported from upload <code>", deduped per (upload, row).
