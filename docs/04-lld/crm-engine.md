# 04 — LLD: `crm-engine` (matching)

| | |
|---|---|
| Service | S4 `crm-engine` — CRM Engine (HLD §2) |
| Version | 0.2 (draft; aligned to events v0.2 and conventions §10) |
| Date | 2026-09-24 |
| Based on | BRD v0.6.1 §7, PRD v0.6 §4.5 / US-28 / US-29 / A-38, HLD v0.2 (approved), `docs/04-lld/conventions.md` (incl. §10 R-1…R-22), `contracts/asyncapi/events.yaml` v0.2.0 |
| Contract | `contracts/openapi/crm-engine.yaml` |
| Status | IN PROGRESS (Stage 4) |

This document follows `conventions.md` with no deviations.

---

## 1. Purpose and scope

crm-engine continuously pairs demand with supply, many to many, and ranks the pairs (BRD §7, PRD §4.5). It owns:

- a **PII-free matchable projection** of offers and demands (only the fields matching needs), built from events;
- **matches** (single offer or bundle), **bundles**, **date-aware exclusions**, **flags**, **feedback** (confirm/reject
  with reason codes, M6) and **weights** (versioned tunables);
- the incremental matching pipeline and a periodic re-score.

Matches are suggestions: nobody is contacted automatically (BRD A-5). crm-engine does not own the life curve, the
Commercial axis or queues (journeys), facts (records) or publication (listings). It stores **no names, phones,
emails, building names, wing/unit/floor or free text** (HLD §3.1 "PII-free by design").

## 2. Internal module layout

```
services/crm-engine/
  src/domain/                      pure logic, no I/O
    matchable/                     OfferMx, DemandMx, liveness rules, AvailableFrom normalisation
    micromarket/                   Hierarchy (path, descendants), proximity, adjacency
    filters/                       HardFilter chain (§4.1), each returns pass | fail(reason) | exclude(reason)
    scoring/                       Factor functions (§4.2), Scorer (weights → 0..100), Flags (§4.4)
    bundles/                       BundleFinder (§4.3), BundleRules (≤3 offers, co-location, segment)
    lifecycle/                     Match state machine (§4.6), close/reopen propagation, top-N policy, rejection memory
  src/application/
    commands/                      ConfirmMatch, RejectMatch, CreateBundle, RequestRun, PutWeights
    queries/                       ListDemandMatches, ListOfferMatches, GetMatch, ExplainMatch, ListExclusions, GetRun
    handlers/                      one per consumed event (§5.2): update projection → mark dirty
    pipeline/                      RescoreSubject (demand-side / offer-side), CellBatcher, FullRescore
    ports/                         MxRepository, MatchRepository, ExclusionRepository, WeightsRepository,
                                   HierarchyRepository, OutboxPort, IdempotencyStore, WorkQueuePort (pgmq),
                                   RecordsReferencePort (micromarkets), Clock (IST), JobCursorStore
  src/adapters/
    http/                          handlers from contracts/openapi/crm-engine.yaml; auth; RFC 7807; idempotency
    db/                            schema `crm_engine`, role `crm_engine_svc`, Supavisor transaction mode
    messaging/                     outbox, relay, pgmq drain (q_crm_engine, q_crm_engine_rescore) + DLQs
    records/                       GET /v1/micromarkets (hierarchy + adjacency, R-13) and projection re-reads, with a
                                   service token minted by web (R-2, verified via web JWKS)
  src/main.ts                      composition root
  migrations/                      forward-only SQL (needs extension btree_gin)
  tests/unit/                      filters, factor functions (table-driven from PRD/BRD examples), bundle finder, state machine
  tests/integration/               repositories, candidate queries (EXPLAIN checks: index used), drain idempotency, tenant isolation
  tests/contract/                  OpenAPI + AsyncAPI conformance; a test that fails if any column/field is on the PII deny-list
  tests/scenarios/                 AS-D1 (bundle), AS-D2 (sourced, INV-00611 dropped), AS-S1 (close propagation),
                                   AS-S5 (Available too late), AS-S6 (price above budget)
```

## 3. Data schema

Schema `crm_engine`, role `crm_engine_svc`. Common columns (`tenant_id`, `created_at`, `updated_at`, `version` on
mutable aggregates) as in conventions §6; every index starts with `tenant_id`. **No column in this schema holds
contact PII or free text** (enforced by a schema test).

### 3.1 Code sequences
```sql
create table code_sequences (
  tenant_id uuid not null, prefix text not null check (prefix in ('MAT','BND')), next_value bigint not null default 1,
  primary key (tenant_id, prefix)
);
```
Codes: `MAT-0000`, `BND-0000` (zero padded, width grows).

### 3.2 Matchable projection (PII-free)

```sql
create table offer_mx (                        -- id = records offer id
  id uuid primary key, tenant_id uuid not null, code text not null,
  property_id uuid not null, project_id uuid,
  building_key text,                           -- buildingKey from offer facts: opaque hash, never the building name
  deal_type text not null, market text, segment text, property_types text[] not null default '{}',
  bhk_min numeric(3,1), bhk_max numeric(3,1),
  area_sqft_min numeric, area_sqft_max numeric, area_basis text, land_area_sqft numeric,
  sale_price_inr_min bigint, sale_price_inr_max bigint, rent_monthly_inr_min bigint, rent_monthly_inr_max bigint,
  deposit_inr bigint, current_rent_inr bigint,
  price_key bigint,                            -- derived: sale_price_inr_min for Sale/Pagdi, rent_monthly_inr_min for Lease
  micromarket text, locality text, mm_path text[] not null default '{}',   -- node ids: own node + ancestors up to micromarket
  zone text, outside_launch_area boolean not null default false,
  tenancy_status text, sale_mode text, possession_status text, possession_date_raw text,
  tenure text, agreement_form text, is_jodi boolean, parking int, amenities text[] not null default '{}',
  floor_band text, total_floors int, price_sheet_date date, last_seen_date date,
  available_from date, available_to date,      -- period bounds: '2027-02' → 2027-02-01 .. 2027-02-28; Ready/null → null
  furnishing text, unit_count int, record_stage text,
  life_stage text not null default 'Fresh', commercial_status text not null default 'Available',
  is_matchable boolean generated always as (
    not outside_launch_area and life_stage <> 'Expired' and commercial_status not in ('Closed','Inactive')
    and merged_into is null and not voided) stored,
  voided boolean not null default false,        -- offer.voided.v1
  facts_version int not null default 0, price_version int not null default 0,
  life_version int not null default 0, commercial_version int not null default 0,
  merged_into uuid,
  unique (tenant_id, code)
);
create table demand_mx (                       -- id = records demand id
  id uuid primary key, tenant_id uuid not null, code text not null,
  deal_types text[] not null, market text, segment text, property_types text[] not null default '{}',
  bhk_min numeric(3,1), bhk_max numeric(3,1), area_sqft_min numeric, area_sqft_max numeric, area_basis text,
  budget_inr_min bigint, budget_inr_max bigint, rent_monthly_inr_min bigint, rent_monthly_inr_max bigint,
  micromarkets text[] not null default '{}', localities text[] not null default '{}',
  mm_expanded text[] not null default '{}',    -- listed nodes + all descendants + parent micromarket of listed localities
  move_in_from date, move_in_by date, stated_tags jsonb not null default '{}',   -- controlled values only (tenancy_status, sale_mode, furnishing, …)
  outside_launch_area boolean not null default false, record_stage text,
  qualified boolean not null default false, owner_user_id uuid,   -- staff id, not contact PII
  life_stage text not null default 'Fresh', commercial_status text not null default 'New', exit_type text,
  is_matchable boolean generated always as (
    not outside_launch_area and exit_type is null and commercial_status <> 'Closed'
    and life_stage not in ('Expired','Paused') and merged_into is null and not voided) stored,
  accepts_new boolean generated always as (
    not outside_launch_area and exit_type is null and commercial_status <> 'Closed'
    and life_stage not in ('Stale','Expired','Paused') and merged_into is null and not voided) stored,
  voided boolean not null default false,        -- demand.voided.v1
  facts_version int not null default 0, life_version int not null default 0,
  status_version int not null default 0, merged_into uuid,
  unique (tenant_id, code)
);
create table micromarket_nodes (               -- copy of records' hierarchy (reference data, no PII)
  id uuid primary key, tenant_id uuid not null, node_key text not null,
  level text not null check (level in ('zone','micromarket','locality','sub_locality')),
  name text not null, parent_key text, path text[] not null,          -- ancestors incl. self
  adjacent_keys text[] not null default '{}',                          -- Admin-maintained adjacency (R-13)
  release_version integer not null,                                    -- micromarkets.updated.v1 version unique (tenant_id, node_key)
);
create table vocabulary_cache (
  id uuid primary key, tenant_id uuid not null, version text not null, checksum text not null,
  body jsonb not null, active boolean not null default false, unique (tenant_id, version)
);
```

### 3.3 Matching state

```sql
create table matches (
  id uuid primary key, tenant_id uuid not null, code text not null,
  demand_id uuid not null, offer_ids uuid[] not null,                 -- sorted ascending
  offer_set_key text not null,                                        -- sorted ids joined with ','
  is_bundle boolean not null default false, bundle_id uuid,
  score smallint not null check (score between 0 and 100), rank smallint,
  factors jsonb not null,                                             -- [{factor, weight, value, points, applicable}]
  flags text[] not null default '{}',
  status text not null check (status in ('Suggested','Confirmed','Rejected','Closed')),
  closed_reason text, closed_by_deal_id uuid, prior_status text,      -- for compensation (deal cancelled)
  rejected_reason text, rejected_score smallint, rejected_facts_version int,
  origin text not null check (origin in ('engine','user')),
  weights_version int not null, confirmed_by uuid, confirmed_at timestamptz,
  version int not null default 1,
  unique (tenant_id, code), unique (tenant_id, demand_id, offer_set_key)
);
create table match_offers (                    -- one row per offer in a match (single: 1, bundle: 2–3)
  id uuid primary key, tenant_id uuid not null, match_id uuid not null references matches(id),
  offer_id uuid not null, demand_id uuid not null, status text not null,   -- denormalised from matches for filtering
  unique (tenant_id, match_id, offer_id)
);
create table bundles (
  id uuid primary key, tenant_id uuid not null, code text not null, demand_id uuid not null,
  offer_ids uuid[] not null, grouping text not null check (grouping in ('same_building','same_micromarket','adjacent_micromarket')),
  combined_area_sqft numeric not null, combined_price_inr bigint, combined_rent_monthly_inr bigint,
  origin text not null check (origin in ('engine','user')), created_by uuid,
  unique (tenant_id, code)
);
create table exclusions (
  id uuid primary key, tenant_id uuid not null, demand_id uuid not null, offer_id uuid not null,
  reason text not null check (reason in ('available_too_late','offer_expired','offer_inactive','demand_stale')),
  available_from date, move_in_by date, computed_at timestamptz not null,
  unique (tenant_id, demand_id, offer_id)
);
create table feedback (                        -- M6: share of suggestions confirmed; tuning input
  id uuid primary key, tenant_id uuid not null, match_id uuid not null, demand_id uuid not null,
  action text not null check (action in ('confirmed','rejected','client_liked','client_rejected','client_visit_requested')),
  source text not null check (source in ('staff','proposal')),       -- proposal = proposal.feedback_recorded.v1
  reason_code text,                                                   -- code only, no free text
  score smallint not null, factors jsonb not null, weights_version int not null,
  by_user uuid not null, at timestamptz not null
);
create table weights (
  id uuid primary key, tenant_id uuid not null, version int not null, body jsonb not null,   -- Weights schema
  active boolean not null default false, created_by uuid, unique (tenant_id, version)
);
create table matching_runs (
  id uuid primary key, tenant_id uuid not null, scope text not null check (scope in ('demand','offer','full')),
  subject_id uuid, trigger text not null, status text not null check (status in ('queued','running','done','failed')),
  candidates int, suggested int, closed int, excluded int, error text,
  started_at timestamptz, finished_at timestamptz
);
create table rescore_pending (                 -- dedupes work before it is sent to pgmq q_crm_engine_rescore
  id uuid primary key, tenant_id uuid not null,
  subject_type text not null check (subject_type in ('offer','demand')), subject_id uuid not null,
  reasons text[] not null, run_id uuid, enqueued_at timestamptz not null,
  unique (tenant_id, subject_type, subject_id)
);
```

### 3.4 Infrastructure tables
`outbox`, `aggregate_versions` (per match aggregate), `processed_events`, `idempotency_keys`, `job_runs`,
`merge_log` — same definitions as in the journeys LLD §3.4 (conventions §6).

### 3.5 Indexes

| Index | Columns / kind | Query it serves |
|---|---|---|
| `offer_mx_code`, `demand_mx_code` | unique `(tenant_id, code)` | `{idOrCode}` resolution |
| `offer_mx_candidates` | GIN `(tenant_id, segment, deal_type, property_types, mm_path)` (btree_gin) `where is_matchable` | Demand-side candidates: `where tenant_id=$t and is_matchable and segment=$seg and deal_type = any($dealTypes) and property_types && $types and mm_path && $mmExpanded limit 5000` |
| `offer_mx_price` | `(tenant_id, segment, deal_type, price_key) where is_matchable` | Candidate narrowing when the GIN query hits the 5,000 cap: adds `price_key <= $budgetMax × (1 + priceOverBudgetZeroPct)` |
| `offer_mx_bundle` | `(tenant_id, segment, micromarket, deal_type, area_sqft_max desc) where is_matchable` | Bundle finder: largest candidate offers per micromarket (and per `building_key`, below) |
| `offer_mx_building` | `(tenant_id, building_key) where building_key is not null and is_matchable` | Same-building bundles |
| `demand_mx_candidates` | GIN `(tenant_id, segment, deal_types, property_types, mm_expanded)` `where is_matchable` | Offer-side candidates: `where tenant_id=$t and is_matchable and segment=$seg and deal_types @> array[$dealType] and property_types && $types and mm_expanded && $mmPath limit 5000` |
| `demand_mx_time` | `(tenant_id, move_in_by) where is_matchable and move_in_by is not null` | Nightly time-sensitive re-score (`move_in_by <= today + 90`) |
| `demand_mx_keyset` | `(tenant_id, id) where is_matchable` | Full re-score keyset batches |
| `matches_demand` | `(tenant_id, demand_id, status, score desc, id)` | `GET /v1/demands/{id}/matches` (status filter, score order); top-N maintenance; demand exit/close |
| `matches_code` | unique `(tenant_id, code)` | `/v1/matches/{idOrCode}` |
| `matches_pair` | unique `(tenant_id, demand_id, offer_set_key)` | Upsert target for a (demand, offer set) pair |
| `matches_deal` | `(tenant_id, closed_by_deal_id) where closed_by_deal_id is not null` | `deal.cancelled.v1` → reopen matches closed by that deal |
| `matches_updated` | `(tenant_id, updated_at, id)` | `/internal/v1/matches` rebuild feed |
| `match_offers_offer` | `(tenant_id, offer_id, status, match_id)` | `GET /v1/offers/{id}/matches`; close/flag propagation when an offer changes |
| `match_offers_match` | unique `(tenant_id, match_id, offer_id)` | Load offers of a match |
| `bundles_demand` | `(tenant_id, demand_id)` | Existing-bundle check; `GET /v1/bundles/{id}` via code index `bundles_code` |
| `exclusions_demand` | `(tenant_id, demand_id, computed_at desc, id)` | `GET /v1/demands/{id}/exclusions` |
| `exclusions_offer` | `(tenant_id, offer_id)` | Clear exclusions when an offer's date or status changes |
| `feedback_match` | `(tenant_id, match_id, at)` | Feedback history; M6 reporting by `(tenant_id, at)` via `feedback_at` |
| `weights_active` | unique `(tenant_id) where active` | Current weights |
| `runs_subject` | `(tenant_id, subject_id, started_at desc)` | Idempotent re-run (existing queued/running run); `GET /v1/matching-runs/{id}` by PK |
| `rescore_pending_subject` | unique `(tenant_id, subject_type, subject_id)` | Dedupe dirty subjects |
| `mm_nodes_key` | unique `(tenant_id, node_key)` | Hierarchy lookups (cached in memory per invocation, keyed by release version) |
| outbox / processed_events / idempotency / job_runs / merge_log | as journeys §3.5 | relay, purge, undo |

## 4. Business rules and algorithms

### 4.1 Hard filters (PRD §4.5, BRD §7) — evaluated in this order; the first failure stops

| # | Filter | Rule | On failure |
|---|---|---|---|
| 1 | side / scope | Offer (Supply) vs Demand; both are Property scope (records only creates offers/demands for Property) | skip |
| 2 | launch area | neither side `outside_launch_area` (CR-006 Z-7) | skip (never candidates) |
| 3 | liveness | offer `is_matchable` (not Expired, Closed, Inactive); demand `is_matchable` (not exited/Closed/Expired/Paused). New suggestions need `accepts_new` (not Stale) | skip; Expired offer → exclusion `offer_expired` only if it passes 4–9 |
| 4 | deal_type | `offer.deal_type ∈ demand.deal_types` | skip |
| 5 | market (Sale only) | demand Any (or blank, JB-1) matches Primary and Secondary; demand Primary/Secondary needs the same; **offer market blank → compatible + flag `market_unknown`** (CR-006) | skip |
| 6 | segment / type | same segment; `offer.property_types ∩ demand.property_types ≠ ∅` | skip |
| 7 | stated deal tags | for each key the client stated that the offer carries (`tenancy_status`, `sale_mode`, `possession_status`, `tenure`, `agreement_form`, `is_jodi`): equal values; offer value blank → compatible | skip |
| 8 | micromarket | `offer.mm_path ∩ demand.mm_expanded ≠ ∅` (hierarchy counts: Chakala is inside Andheri East) | skip |
| 9 | possession window | if `demand.move_in_by` and `offer.available_from` are set: `available_from ≤ move_in_by` (period start, so month precision never excludes wrongly). `moveInFrom` does not exclude (an earlier-available offer can wait) but lowers timing | **exclusion** `available_too_late` (AS-S5) |

Filters 1–8 are applied as SQL candidate predicates where possible (segment, deal type, types, micromarket,
liveness) and re-checked in memory; only candidates that fail filter 9 (or are Expired) create exclusion rows
(≤ 50 per demand, newest kept).

### 4.2 Scoring

`score = round(100 × Σ w_f·v_f / Σ w_f)` over **applicable** factors, `v_f ∈ [0,1]`. Default weights (Admin-editable,
versioned): micromarket 0.25, price 0.25, area 0.20, bhk 0.10, timing 0.10, furnishing 0.10.

| Factor | Applicable when | Value v |
|---|---|---|
| micromarket | always | offer locality in `demand.localities` (or offer sub-locality under one) → `sameLocality` 1.0; offer micromarket in `demand.micromarkets`, or offer locality under a listed micromarket → `sameMicromarket` 0.85; overlap only through a coarser node (offer known only at micromarket level for a locality demand) → `coarserLevel` 0.6 |
| price | demand has a budget max for the deal type and deal_type ≠ JV | p = `price_key` (Sale/Pagdi: `sale_price_inr_min`, else max; Lease: `rent_monthly_inr_min`, else max); b = demand `budget_inr_max` (Sale/Pagdi) or `rent_monthly_inr_max` (Lease). p ≤ b → 1.0; p > b → `max(0, 1 − ((p − b)/b) / (priceOverBudgetZeroPct/100))` (default 20%); offer without price → 0.5 |
| area | both sides have an area | like with like: Land uses `land_area_sqft`; others `area_sqft_min/max`. tol = `areaTolerancePct` (±15%) when both bases are known and equal; `areaToleranceUnknownBasisPct` (±25%) when a basis is blank (**flag `area_basis_unknown`**, R-14) or the bases differ (JB-2). No conversion between bases (R-14). Ranges overlap → 1.0; else `max(0, 1 − gap/(tol × nearest demand bound))` |
| bhk | segment = Residential and both sides have bhk | ranges overlap → 1.0; off by 0.5 → 0.6; by 1 → 0.3; more → 0 |
| timing | demand has `move_in_by` | available (period end, or today if Ready/blank) ≤ `move_in_by − timingSoonDays` (30) → 1.0; ≤ `move_in_by` → 0.7; available earlier than `move_in_from − 90 days` → × 0.8 |
| furnishing / must-haves | demand stated `furnishing` or must-have tags (parking, amenities) | mean of: furnishing equal → 1.0, adjacent level (Furnished~Semi Furnished~Unfurnished~Bare Shell) → 0.5, otherwise 0.2, blank → 0.5; each stated must-have present → 1, absent → 0, unknown → 0.5 |

A pair is suggested only if `score ≥ minScore` (40). The factor array (weight, value, points, applicable, generated
note) is stored on the match and returned by the explanation endpoint (US-28 "score and factor breakdown").

### 4.3 Bundles (PRD §4.5, A-38, AS-D1)
- **Eligible demands:** segment Commercial or Industrial, with `area_sqft_min` set, `accepts_new`.
- **Candidates:** offers passing hard filters 1–9 for the demand **ignoring area**, same deal_type within a bundle,
  each smaller than `area_sqft_min` (an offer that meets the area alone is a single match), capped at
  `bundleCandidateCap` (30) largest per group.
- **Groups (co-location):** same `buildingKey` (`same_building`, AS-D1 adjacent Marol floors); else same micromarket
  (`same_micromarket`); else micromarkets in each other's `adjacent_keys` from records' Admin-maintained adjacency list
  (`adjacent_micromarket`, R-13).
- **Search:** for each group, enumerate combinations of 2 then 3 offers (≤ C(30,3) = 4,060 per group), keep those with
  `Σ area ≥ demand.area_sqft_min` and `Σ area ≤ area_sqft_max × (1 + areaTolerancePct)` (when a max exists) and
  `Σ price_key ≤ budget max` (price factor on the sum). Score = §4.2 with area/price on the sums and the other factors
  averaged across members. Keep the best `bundlesPerDemand` (3) bundles not dominated by a better bundle sharing
  offers; a bundle is **one match** (`is_bundle`, `offer_ids` of 2–3).
- **Manual bundles** (`POST /v1/bundles`): the same rules validated for the given offers; failures → 400 with
  `errors[]`; Supply agents may create Suggested bundles only.

### 4.4 Flags (US-28, BRD §7)
| Flag | Raised when | Cleared when |
|---|---|---|
| `price_above_budget` | offer `price_key` > demand budget max (after a price change: `offer.price_changed.v1`, AS-S6; or at scoring) | price back within budget (re-rank) |
| `reconfirm` | any offer in the match is Stale (`lifecycle.stage_changed.v1`) | offer back to Fresh/Ageing (`offer.confirmed.v1` / stage change) |
| `area_basis_unknown` | either side's `area_basis` is blank | both known |
| `market_unknown` | Sale offer with blank market | market set |

A new flag emits `match.flagged.v1` (`cleared = false`); removing a flag emits `match.flagged.v1` with `cleared = true`.

### 4.5 Re-scoring triggers and the pipeline

Every consumed event updates the projection in its own transaction and marks the affected subject(s) dirty in
`rescore_pending` (insert … on conflict do nothing; a new row sends one pgmq message to `q_crm_engine_rescore`).

| Trigger (event) | Dirty subject | Notes |
|---|---|---|
| `offer.created.v1`, `offer.updated.v1` | offer | offer-side run (candidate demands) |
| `offer.price_changed.v1` (typed `previous` / `current`) | offer | also raises / clears `price_above_budget` on existing matches |
| `price_sheet.applied.v1` | offers in `changedOfferIds` | price and unit changes of project configurations (AS-S6) |
| `offer.confirmed.v1`, `lifecycle.stage_changed.v1` (offer) | offer | reconfirm flag, Expired close / reopen, liveness |
| `offer.commercial_status_changed.v1` | offer | Closed/Inactive → close propagation (§4.6); Upcoming/Available → liveness |
| `offer.retired.v1` | offer | close propagation (`offer_retired`) |
| `offer.voided.v1` / `demand.voided.v1` | offer / demand | projection voided; all matches Closed `voided` |
| `demand.created.v1`, `demand.updated.v1`, `demand.confirmed.v1` | demand | demand-side run |
| `demand.qualified.v1` | demand | **inventory check**: priority demand-side run; ends with `demand.matching_completed.v1` |
| `demand.reactivated.v1` | demand | re-match; matches closed as `demand_exited` reopen (`match.reopened.v1`, `demand_reactivated`) when still valid |
| `lifecycle.stage_changed.v1` (demand), `demand.status_changed.v1`, `demand.exited.v1` | demand | Stale stops new suggestions; exit / Closed closes matches |
| `deal.opened.v1`, `proposal.sent.v1`, `site_visit.completed.v1` | — | projection only (match "in deal" guard for reject; M6 funnel) |
| `proposal.feedback_recorded.v1` | — | `feedback` rows (`source = proposal`) for M6 weight tuning; a `rejected` verdict does not reject the match |
| `deal.closed.v1` / `deal.cancelled.v1` | — | mark / reopen (§4.6) |
| `records.merged.v1` / `records.merge_undone.v1` | both | re-key (§4.7) |
| `micromarkets.updated.v1`, `vocabulary.released.v1` | all | `micromarket-refresh` job (hierarchy + adjacency, R-13), then full re-score |
| `PUT /v1/weights` | all | new version → `full-rescore` |
| nightly 03:00 IST (`full-rescore`) | time-sensitive demands | demands with `move_in_by ≤ today + 90` (timing factor moves with the date); weekly (Sunday) all live demands |

**RescoreSubject (demand D):**
1. Load D; if not `is_matchable` → close its open matches (reason by cause) and stop.
2. Candidate query (`offer_mx_candidates`, limit 5,000; if the limit is hit, re-query with `offer_mx_price` narrowing).
3. Apply filters (§4.1) → exclusions for filter 9 / Expired; score survivors (§4.2); run the bundle finder (§4.3).
4. Merge with existing matches of D in one transaction:
   - new pair with score ≥ minScore and `accepts_new` → insert Suggested (code MAT-…), emit `match.suggested.v1`;
   - existing Suggested/Confirmed → update score/factors/flags; emit `match.suggested.v1` when the score changes by ≥ 1
     (re-rank), `match.flagged.v1` for each flag raised (`cleared = false`) or removed (`cleared = true`);
   - Rejected → re-suggest only if the offer's `facts_version` > `rejected_facts_version` and the new score ≥
     `rejected_score + rejectedResuggestMinGain` (10);
   - Closed for a cause that no longer holds → `match.reopened.v1` (reason `offer_reactivated` / `demand_reactivated`).
5. **Top-N:** keep ranks 1..`topNPerDemand` (20) among open Suggested matches; a suggestion pushed below rank 20 is
   Closed with reason `superseded` (`match.closed.v1`). Confirmed matches are never demoted.
6. If the run was triggered by `demand.qualified.v1` or `POST …/matching-runs`, emit **`demand.matching_completed.v1`**
   (demandId, runId, matchCount = open single matches, bundleCount) after the transaction's outbox write. journeys uses
   it for the "no match → sourcing" decision (BRD §6).

**RescoreSubject (offer O):** symmetric, with `demand_mx_candidates`; for each candidate demand the pair is scored
and merged as above; bundles are re-evaluated only for eligible demands in O's micromarket group (bounded by the cap).

**Cell batching (bulk uploads):** the rescore drain reads up to 500 dirty subjects, groups offers by (segment,
deal_type, micromarket) and runs **one** demand candidate query per cell, scoring all offers of the cell against it.
A 20k-row pilot upload (~20k offers in a few hundred cells) needs a few hundred queries instead of 20k.

### 4.6 Match state machine and propagation

```
            ┌────────── confirm ─────────┐
 (new) → Suggested ──── reject ────→ Rejected ──(facts change + gain ≥ 10)──→ Suggested
            │                            ▲
            ▼                            │ reject (no open deal)
        Confirmed ───────────────────────┘
   Suggested / Confirmed ── auto close (offer closed/retired/expired/voided, demand exited/closed/voided,
                            deal closed, superseded, merged) ──→ Closed
   Closed ──(deal cancelled / merge undone / offer or demand reactivated)──→ reopened (prior status or Suggested)
```

| Event | Effect | Emits |
|---|---|---|
| Confirm (`POST …/confirm`) | Suggested → Confirmed; feedback row | `match.confirmed.v1` |
| Reject (`POST …/reject`) | Suggested/Confirmed → Rejected with reason code; 409 `match-in-deal` if an open deal uses it | `match.rejected.v1` |
| `offer.commercial_status_changed.v1` → Closed | Open matches containing O (incl. bundles) → Closed `leased_to_another_client` (Lease) or `sold_to_another_client` (Sale, Pagdi, JV); the deal's own match (from `deal.closed.v1`) → Closed `deal_closed`; `closed_by_deal_id`, `prior_status` stored | `match.closed.v1` |
| `deal.closed.v1` for a multi-unit project offer | only the deal's own match closes (`deal_closed`); the offer stays live | `match.closed.v1` |
| Demand Closed (`demand.status_changed.v1` → Closed) | D's other open matches → Closed `demand_closed` | `match.closed.v1` |
| `offer.retired.v1` | open matches containing O → Closed `offer_retired` | `match.closed.v1` |
| `demand.exited.v1` | D's open matches → Closed `demand_exited` | `match.closed.v1` |
| `offer.voided.v1` / `demand.voided.v1` | all open matches of the subject → Closed `voided` | `match.closed.v1` |
| Offer Stale | flag `reconfirm` on open matches containing O | `match.flagged.v1` |
| Offer Expired | open matches containing O → Closed `offer_expired` (`prior_status` kept) | `match.closed.v1` |
| Offer reconfirmed after Expired / Inactive offer reactivated (R-12) | matches closed `offer_expired` / `offer_retired` restored to `prior_status` if the pair still passes the filters; `reconfirm` cleared | `match.reopened.v1` (`offer_reactivated`), `match.flagged.v1` (`cleared = true`) |
| `deal.cancelled.v1` (compensation, HLD §7) | matches with `closed_by_deal_id` = deal → reopened as **Suggested** (JB-4); the deal's own match → Confirmed | `match.reopened.v1` (`deal_cancelled`) per match |

### 4.7 Merges
`records.merged.v1` (offer or demand): in one transaction, before-images to `merge_log`; replace merged ids by the
survivor in `matches.offer_ids` / `demand_id`, `match_offers`, `bundles`, `exclusions`; recompute `offer_set_key`.
When two matches collapse onto the same (demand, offer set), keep the one with the highest status (Confirmed >
Suggested > Rejected > Closed) and close the other with reason `merged` (`match.closed.v1`). Mark the survivor dirty.
`records.merge_undone.v1` restores from `merge_log` and emits `match.reopened.v1` (`merge_undone`) for restored matches.

### 4.8 Micromarket hierarchy and adjacency (R-13)
records owns the Mumbai (MMR) hierarchy (zone → micromarket → locality → sub-locality, with aliases) and the
Admin-maintained adjacency list. crm-engine keeps a copy in `micromarket_nodes`, refreshed by `micromarket-refresh`
on `micromarkets.updated.v1` (and daily) through records' `GET /v1/micromarkets` (service token minted by web, R-2;
never on a request path). `offer.mm_path` = the offer's most specific node + ancestors up to micromarket level;
`demand.mm_expanded` = listed nodes + all their descendants + the parent micromarket of each listed
locality/sub-locality (so an offer known only at micromarket level still overlaps, scored `coarserLevel`). Zones are
not used for overlap (too broad). `adjacent_keys` is used only for bundle co-location. Unknown locality strings → no
node → the pair cannot pass filter 8.

### 4.9 Assumptions (crm-engine)
| # | Assumption |
|---|---|
| JB-1 | A Sale demand with blank market is treated as Any. |
| JB-2 | Known but different area bases (e.g. carpet vs built-up) use the ±25% tolerance without the flag; no conversion (R-14). |
| JB-3 | Price is scored, never a hard filter; very expensive offers fall below `minScore` or out of the top 20. |
| JB-4 | Matches reopened by a deal cancellation return as Suggested (the agent re-confirms), except the cancelled deal's own match (Confirmed). |
| JB-5 | Suggestions are produced for every live demand (also before qualification) so that A-42 Must call works; journeys shows `open_matches` only for qualified demands. |
| JB-6 | All offers in a bundle have the same deal_type. |
| JB-7 | `moveInFrom` is soft (timing factor), `moveInBy` is hard (exclusion). |
| JB-8 | Automatic closes and reopens record the system actor `00000000-0000-0000-0000-000000000001` (R-7). |

## 5. Events

Payloads and consumers are exactly those in `contracts/asyncapi/events.yaml` v0.2.

### 5.1 Produced

| Event | aggregate | Trigger |
|---|---|---|
| `match.suggested.v1` | match | New suggestion; re-rank (score changed); bundle created |
| `match.confirmed.v1` | match | `POST …/confirm`; `POST /v1/bundles` with `confirm=true` |
| `match.rejected.v1` | match | `POST …/reject` |
| `match.closed.v1` | match | Auto close: `leased_to_another_client`, `sold_to_another_client`, `offer_retired`, `offer_expired`, `demand_exited`, `demand_closed`, `deal_closed`, `superseded`, `merged`, `voided` |
| `match.flagged.v1` | match | Flag raised (`cleared = false`) or removed (`cleared = true`): `price_above_budget`, `reconfirm`, `area_basis_unknown`, `market_unknown` |
| `match.reopened.v1` | match | `deal_cancelled`, `merge_undone`, `offer_reactivated`, `demand_reactivated` |
| `demand.matching_completed.v1` | demand | Inventory check after `demand.qualified.v1`, or a re-run from `POST …/matching-runs` |
| `audit.recorded.v1` | weights | `PUT /v1/weights` |

### 5.2 Consumed (queue `q_crm_engine`)

Dedupe on `eventId` (`processed_events` in the same transaction). Out-of-order: each projection field group has its
own version (`facts_version`, `price_version`, `life_version`, `commercial_version`, `status_version`); an event is
applied only if its `aggregateVersion` is newer than the stored one for that group (journeys and records use separate
version counters, so offer/demand events from journeys are compared only with journeys-sourced groups). A gap in a
full-facts stream (`offer.updated.v1` v7 after v5) is applied (full facts) and the missing version is ignored.

| Event (producer) | Handling |
|---|---|
| `offer.created.v1`, `offer.updated.v1` (records) | Upsert `offer_mx` facts (incl. `buildingKey`, `tenure`, `agreementForm`, `isJodi`, `parking`, `amenities`, `floorBand`, `totalFloors`, `priceSheetDate`, `lastSeenDate`); recompute `price_key`, `available_from/to`, `mm_path`; dirty. `contactPersonIds` are **not stored** (PII-free by design) |
| `offer.price_changed.v1` (records) | Update price fields and `unit_count` from typed `current` if `price_version` older; dirty (flag check) |
| `price_sheet.applied.v1` (records) | Set `price_sheet_date` on `changedOfferIds`; dirty those offers |
| `offer.voided.v1`, `demand.voided.v1` (records) | `voided = true`; close matches `voided` |
| `demand.created.v1`, `demand.updated.v1` (records) | Upsert `demand_mx` (incl. `moveInFrom`), recompute `mm_expanded`; dirty. `contactPersonIds` not stored |
| `vocabulary.released.v1`, `micromarkets.updated.v1` (records) | Cache release; queue `micromarket-refresh` |
| `records.merged.v1`, `records.merge_undone.v1` (records) | §4.7 |
| `offer.confirmed.v1` (journeys) | clear reconfirm, reopen `offer_expired` matches; dirty |
| `demand.confirmed.v1` (journeys) | dirty (Stale → Fresh resumes suggestions via the stage event) |
| `lifecycle.stage_changed.v1` (journeys) | Update `life_stage` (offer or demand); Stale/Expired effects §4.6; dirty |
| `offer.commercial_status_changed.v1` (journeys) | Update `commercial_status`; Closed → propagation; Inactive → Available (R-12) → reopen |
| `offer.retired.v1` (journeys) | Close matches `offer_retired` |
| `demand.qualified.v1` (journeys) | `qualified = true`; priority run → `demand.matching_completed.v1` |
| `demand.status_changed.v1` (journeys) | Update `commercial_status`; Closed → close other matches `demand_closed` |
| `demand.exited.v1` (journeys) | `exit_type`; close matches `demand_exited` |
| `demand.reactivated.v1` (journeys) | clear `exit_type`; dirty; reopen still-valid matches |
| `proposal.sent.v1`, `site_visit.completed.v1`, `deal.opened.v1` (journeys) | Record engagement on the matches (guards reject while in a deal; M6 funnel) |
| `proposal.feedback_recorded.v1` (journeys) | `feedback` rows per matchId verdict (`client_liked` / `client_rejected` / `client_visit_requested`); used to tune weights (M6) |
| `deal.closed.v1` (journeys) | Mark the deal's match `deal_closed`; set `closed_by_deal_id` on matches closed by the offer close |
| `deal.cancelled.v1` (journeys) | Reopen per §4.6 |

## 6. Error codes

Common codes from conventions §4 apply. Service codes:

| Code | HTTP | When |
|---|---|---|
| `invalid-match-status` | 409 | Confirm a Rejected/Closed match; reject a Closed match |
| `match-in-deal` | 409 | Reject a match used by an open deal (from `deal.opened.v1`) |
| `demand-not-matchable` | 409 | Bundle or re-run for an exited/Closed/outside-area demand |
| `offer-not-matchable` | 409 | Bundle with an offer that is Expired, Closed, Inactive or outside the launch area |
| `bundle-too-large` | 400 | Fewer than 2 or more than `bundleMaxOffers` (3) offers |
| `bundle-segment-not-allowed` | 400 | Demand segment not Commercial/Industrial |
| `bundle-not-colocated` | 400 | Offers not in the same building or same/adjacent micromarket |
| `bundle-mixed-deal-type` | 400 | Offers with different deal_types |
| `bundle-hard-filter-failed` | 400 | An offer fails a hard filter (`errors[]` names offer and filter) |
| `bundle-area-insufficient` | 400 | Combined area below the demand's minimum |
| `weights-invalid` | 400 | All factor weights zero, or a tunable out of range |
| `unknown-queue` / `unknown-job` | 404 | Internal path value not recognised |
| `cron-secret-invalid` | 401 | Missing/wrong `X-Cron-Secret` |
| `job-in-progress` | 409 | Job call while the previous call for the same job and date holds the lock |

## 7. PII fields and retention

**crm-engine holds no PII.** The projection carries ids, codes, controlled values, numbers and dates only. Excluded by
design: contact names, phones, emails, company names, building/society names (replaced by an opaque `building_key`),
wing/unit/floor, `raw_text`, notes and any free text (reject reasons are codes; the confirm body is empty).
`owner_user_id`, `confirmed_by`, `created_by`, `by_user` are staff user ids (UUIDs), not contact data. A contract
test fails the build if a column or API field matches the PII deny-list (conventions §9).

| Data | Retention |
|---|---|
| Rejected / Closed matches, `match_offers`, bundles | 24 months after closing (M6 analysis), then deleted |
| `feedback` | 24 months |
| `exclusions` | recomputed; rows older than 90 days without refresh deleted |
| `matching_runs` | 30 days |
| `offer_mx` / `demand_mx` for merged or purged records | deleted 30 days after `merged_into` is set or a purge |
| outbox (published) / processed_events / idempotency_keys | 7 days / 30 days / 24 h |

## 8. Performance notes

| Target | Design |
|---|---|
| **NFR-2** p95 < 300 ms | Read APIs are single index range scans (`matches_demand`, `match_offers_offer`, `exclusions_demand`) with `limit ≤ 100`; explanation recomputes one pair in memory (< 5 ms). Confirm/reject/bundle are one small transaction (+ outbox). Re-runs are async (202). No cross-service call on any request path. |
| Matching latency (M2, HLD §5.1) | Event → projection → dirty → rescore: relay ≤ 1 min + drain ≤ 1 min + rescore. One demand-side run: candidate GIN bitmap scan (≤ 5,000 rows) + in-memory scoring (~2 ms per 1,000 pairs) + bundle search (≤ 4,060 combinations per group) + upserts of ≤ 23 matches → target p95 ≤ 500 ms. The inventory check after qualification therefore appears within ~2 minutes. |
| **NFR-9** (life curve ≤ 5 min) | Stale/Expired effects (reconfirm flag, `offer_expired` closes, stop suggestions) are applied by the `lifecycle.stage_changed.v1` handler directly (no rescore needed) within the same drain cycle. |
| Bulk (NFR-5) | Cell batching (§4.5) and the dedupe table keep work proportional to distinct subjects and cells, not events. Several rescore drains run in parallel (pgmq visibility timeout 60 s); each stops at a 50 s budget. |
| Candidate prefilter | Only `is_matchable` rows are in the partial GIN indexes; segment + deal type + property types + micromarket overlap cut the candidate set to the relevant cell(s). The 5,000 cap with price narrowing bounds the worst case (e.g. Residential Lease in a dense micromarket at 5M records). |
| Nightly re-score | Only time-sensitive demands nightly (03:00 IST, after journeys' 02:00 run); all live demands weekly; full after a weights change (throttled to one full run at a time). |
| Pilot (§8.4) | ≤ 200k records: candidate sets are small; free-plan function limits handled by the 50 s budget and continuation. Storage: `offer_mx` + `demand_mx` ≈ 300 B/row → ~60 MB at 200k, matches ≤ 20/demand. |

## 9. Endpoint summary

Auth: staff = `staffViaWeb`, service = `serviceToken`, cron = `cronSecret`. Roles: Adm = Admin, Mgr = Manager, Dem =
Demand agent, Sup = Supply agent, all = all five roles. Rate limits are enforced at web (conventions §4).

| Method | Path | Auth | Roles | Idempotency | Paginated | Rate limit | Timeout | Emits |
|---|---|---|---|---|---|---|---|---|
| GET | `/v1/demands/{idOrCode}/matches` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/offers/{idOrCode}/matches` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/matches/{idOrCode}` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/matches/{idOrCode}/explanation` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/matches/{idOrCode}/confirm` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | match.confirmed |
| POST | `/v1/matches/{idOrCode}/reject` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | match.rejected |
| POST | `/v1/bundles` | staff | Adm, Mgr, Dem, Sup | Idempotency-Key | — | 20/s/user (web) | 2000 ms | match.suggested, match.confirmed |
| GET | `/v1/bundles/{idOrCode}` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/demands/{idOrCode}/exclusions` | staff | all | safe | yes | 20/s/user (web) | 2000 ms | — |
| POST | `/v1/demands/{idOrCode}/matching-runs` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s/user (web) | 2000 ms | demand.matching_completed, match.suggested, match.closed, match.flagged |
| GET | `/v1/matching-runs/{runId}` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| GET | `/v1/weights` | staff | all | safe | — | 20/s/user (web) | 2000 ms | — |
| PUT | `/v1/weights` | staff | Adm | If-Match | — | 20/s/user (web) | 2000 ms | audit.recorded, match.suggested, match.closed |
| GET | `/internal/v1/matches` | service | — | safe | yes | 10/s per calling service | 2000 ms | — |
| POST | `/internal/v1/relay` | cron | — | re-runnable | — | pg_cron 1/min | 10000 ms | — |
| POST | `/internal/v1/drain/{queue}` | cron | — | re-runnable | — | pg_cron 1/min | 55000 ms | match.suggested, match.closed, match.flagged, match.reopened, demand.matching_completed |
| POST | `/internal/v1/jobs/{name}` | cron | — | re-runnable | — | pg_cron 1/min | 55000 ms | match.suggested, match.closed, match.flagged, match.reopened, demand.matching_completed |
| GET | `/health/live` | none | — | safe | — | unlimited (platform probe) | 500 ms | — |
| GET | `/health/ready` | none | — | safe | — | unlimited (platform probe) | 1000 ms | — |

Total: **19 operations** (13 under `/v1`, 4 internal, 2 health).

## 10. Contract gaps and open questions

Closed by events v0.2 and conventions §10: C-1 (`buildingKey` → same-building bundles), C-2 (R-13, `micromarkets.updated.v1`
+ records `GET /v1/micromarkets`), C-3 (`match.closed.v1` reasons, `match.reopened.v1`), C-4 (`match.flagged.v1`
`cleared`), C-5 (typed price change), C-6 (`tenure`, `agreementForm`, `isJodi`, parking, amenities), C-7
(`demand.matching_completed.v1`), C-8 (`moveInFrom`). Q-C1 → R-13, Q-C2 → R-14, Q-C5 → closed with `offer_expired`.

Still open:

| # | Gap / question | Default used |
|---|---|---|
| C-9 | Dependency: records' `GET /v1/micromarkets` must return `path` and `adjacentKeys` per node and accept a crm-engine service token (verify in the records LLD) | Same-micromarket bundles only if adjacency is absent |
| C-10 | Demand must-haves: DEMAND_FACTS has only `statedTags` (string map); parking/amenity must-haves need agreed keys | Keys `parking` (min count) and `amenity:<name>` inside `statedTags` |
| Q-C3 | Should suggestions be produced before a demand is qualified? | Yes (JB-5) |
| Q-C4 | Initial weights and `minScore` (M6 tuning) | §4.2 defaults; reviewed after the pilot with staff and proposal feedback |
