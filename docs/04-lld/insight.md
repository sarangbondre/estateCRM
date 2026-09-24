# 04 — LLD: insight (S6, chat, dashboards, exports)

| | |
|---|---|
| Version | 0.2 (draft; aligned to events v0.2 and conventions §10 R-1…R-22) |
| Date | 2026-09-24 |
| Based on | BRD v0.6.1 (§8, §9 Module B chat), PRD v0.6 (§2, §5 R-CHAT-1..3, C-02/C-03/C-20, US-30..US-32, D-3, D-8, D-9, NFR-7/8/13/14, §8.4, Appendix A), HLD v0.2 (S6, §5.5, §8), ADR-0004/0007/0008, `conventions.md` |
| Contract | `contracts/openapi/insight.yaml` (20 operations); events per `contracts/asyncapi/events.yaml` **v0.2** |
| Status | IN PROGRESS (Stage 4) |

## 1. Purpose and scope
insight answers questions about the business. It owns:
- a denormalised, **PII-free analytics read model** fed by domain events;
- chat conversations (redacted text only);
- the **query-plan catalogue**;
- dashboards (demand, supply, other scopes, data quality);
- background Excel exports.

It is **read-only** towards the business. It never changes another service's data. Proposed changes are returned as
cards that the UI sends, through web, to the owning service (R-CHAT-1, ADR-0007).

**AI rule** (ADR-0004), "the model plans, the service executes":
- A Hugging Face open-weight model sees only the **redacted** question plus the catalogue and vocabulary.
- It returns a JSON plan. It never sees records and never writes facts into the answer.
- Answers are composed **only from query results** and always show "How I got this".

Out of scope:
- executing actions;
- the life curve, queues and matching logic;
- contact data (fetched from records only at export time).

## 2. Internal module layout
```
services/insight/
  src/domain/                          # pure, no I/O
    readmodel/projectors/*.ts          # one reducer per consumed event → row upserts + rollup deltas
    readmodel/rollupKeys.ts            # dimension tuple for rm_offer_rollup / rm_demand_rollup
    plans/catalogue.ts                 # typed PlanTemplate definitions (seeded into plan_template)
    plans/validator.ts                 # validate(plan, template, vocabulary, role) → ok | errors[]
    plans/termTranslator.ts            # legacy terms → stored values (vocabulary "absorbs" table)
    plans/keywordParser.ts             # fallback: text → plan (no model)
    plans/describe.ts                  # plan → plain-English "How I got this"
    answers/composer.ts                # (template kind, result) → answer text (deterministic templates)
    answers/indianFormat.ts            # ₹ lakh/crore, sq ft, dates
    cards/actionCatalogue.ts           # cardType → {targetService, operationId, method, pathTemplate, payloadSchema, roles}
    cards/cardBuilder.ts               # model action intent → ProposedActionCard | Notice
    dashboards/definitions.ts          # sections/tiles per BRD §8 → rollup/daily-fact queries + drill-down plans
    exports/policy.ts                  # row cap, contact-column roles, file naming
    labels/labelGenerator.ts           # same BRD §4.2 rules as listings (duplicated on purpose, no shared domain code)
  src/application/
    ports/ Planner (model), Redactor (libs), ReadModelQuery, ReadModelWriter, ConversationRepo, PlanTemplateRepo,
           ExportRepo, FileStore, ContactsReader (records), VocabularyCache, UsageMeter, Outbox, IdempotencyStore,
           Clock, StreamWriter
    AskQuestion (orchestrates redact → plan → validate → execute → compose → stream)
    RunQuery, GetDashboard, CreateExport, RunExportJob, ExpireExports, ApplyEvent, ReconcileRollups,
    ListConversations, CreateConversation, DeleteConversation, ListMessages, GetPlanCatalogue
  src/adapters/
    http/        Next.js route handlers; SSE writer (text/event-stream, no buffering, 15 s abort)
    hf/          Hugging Face client: OpenAI-compatible chat completions with JSON-schema output; timeout, retry, breaker
    db/          SQL compiler (plan → parameterised SQL over a column allow-list), repositories
    messaging/   drains q_insight (domain events) and q_insight_exports (jobs); outbox relay
    storage/     Supabase Storage bucket insight-exports (private)
    records/     ContactsReader (service token; batch contact fetch for exports)
    xlsx/        streaming workbook writer (exceljs WorkbookWriter)
    composition.ts
  migrations/  tests/  Dockerfile  README.md
```
`libs/redaction` is shared infrastructure (ADR-0004): phone, e-mail, URL, name-near-contact-phrase and unit-number
masking, with its own test set.

## 3. Data schema (schema `insight`, role `insight_svc`)
Conventions:
- Every table has `tenant_id uuid not null`, `created_at`, `updated_at`. The PK is `(tenant_id, id)`.
- Read-model rows use the **owner's id** as `id`.
- Types: `bigint` INR, `numeric(12,2)` sq ft, `numeric(3,1)` BHK.
- **No contact PII anywhere in this schema.** Staff are referenced by user id only.

### 3.1 Read model: base tables
**`rm_offer`**

| Columns | Filled by |
|---|---|
| id, code, property_id, project_id, deal_type, market, segment, property_types text[], property_type_primary, bhk_min/max, area_sqft_min/max, area_basis, land_area_sqft, sale_price_inr_min/max, rent_monthly_inr_min/max, deposit_inr, current_rent_inr, locality, micromarket, city, outside_launch_area, tenancy_status, sale_mode, possession_status, possession_date, possession_sort date, furnishing, unit_count, source_type, owner_user_id, sourced_for_demand_id, photo_count, has_real_photos | offer.created / offer.updated / offer.price_changed / photo.added |
| record_stage, verified_at, verified_by | offer.record_stage_changed (verified_at = occurredAt and verified_by = `changedBy` when `to` ∈ {Verified, Qualified} the first time) |
| void_reason | offer.voided (voided offers leave counts and rollups) |
| photo_count adjustments | photo.added / photo.removed |
| commercial_status, closed_at, closing_price_inr, retired_reason | offer.commercial_status_changed, deal.closed, deal.cancelled, offer.retired |
| life_stage, life_day, last_confirmed_at, confirmed_how | lifecycle.stage_changed (subjectType offer), offer.confirmed |
| publication_level, public_id | publication.changed (subjectType offer) |
| enquiry_count, match_suggested_count, match_confirmed_count | enquiry.received, match.* |
| merged_into_id | records.merged / merge_undone |
| created_at_src, records_version, journeys_version, crm_version, listings_version | envelope |

| Index | Serves |
|---|---|
| PK (tenant_id, id) | projector upserts |
| UNIQUE (tenant_id, code) | resolving codes in chat ("INV-00452"), action-card path params |
| (tenant_id, deal_type, segment, micromarket, commercial_status) | list/count offers by classification + locality (Appendix A Q1, Q2, Q9) |
| (tenant_id, life_stage, publication_level, updated_at) | "Public offers that turned Stale this week" (Q6); supply life-curve drill-down |
| (tenant_id, commercial_status, possession_sort) WHERE commercial_status = 'Upcoming' | "Upcoming offers available in the next 60 days" (Q12) |
| (tenant_id, verified_by, verified_at) | "offers each supply agent verified this week" (Q10, from `changedBy`) |
| (tenant_id, project_id) WHERE project_id IS NOT NULL | project configurations |
| (tenant_id, created_at_src DESC, id DESC) | default list order + cursor |
| GIN (tenant_id, property_types) (btree_gin) | property_type filter |

**`rm_demand`**: id, code, deal_types text[], deal_type_primary, market, segment, property_types text[],
property_type_primary, bhk_min/max, area_sqft_min/max, area_basis, budget_inr_min/max, rent_monthly_inr_min/max,
micromarkets text[], localities text[], move_in_by, stated_tags jsonb, outside_launch_area, record_stage, source_type
(first touch), owner_user_id, commercial_status, sourcing_since, exit_type, exit_reason, revisit_date, qualified_at,
life_stage, life_day, last_confirmed_at, publication_level, touch_count, match counts, merged_into_id, versions.
- Filled by: demand.created, demand.updated, demand.touch_added, demand.confirmed, demand.qualified,
  demand.status_changed, demand.exited, demand.reactivated, demand.sourcing_started, lifecycle.stage_changed
  (subjectType demand), publication.changed (demand_post), match.* (incl. match.reopened), demand.matching_completed,
  demand.voided, records.merged.
- Indexes:
  - PK; UNIQUE (tenant_id, code);
  - (tenant_id, commercial_status, sourcing_since): "demands in Sourcing > 7 days" (Q7);
  - (tenant_id, segment, deal_type_primary, commercial_status): classification grid drill-down, "open demand vs supply" (Q3);
  - GIN (tenant_id, micromarkets): micromarket filter;
  - (tenant_id, source_type, qualified_at): "source type with most qualified demand last month" (Q8);
  - (tenant_id, owner_user_id, commercial_status): "my" demand lists;
  - (tenant_id, exit_type, updated_at): exits this month.

**Other base tables:**

| Table | Key columns | Events | Indexes (query) |
|---|---|---|---|
| `rm_touch` | id (touchId), demand_id, source_type, capture_mode, is_first_touch, occurred_at | demand.touch_added, demand.created (first touch) | (tenant_id, demand_id); (tenant_id, source_type, occurred_at) → demand by source |
| `rm_enquiry` | id, code, offer_id, project_id, demand_id, campaign_ref, received_at | enquiry.received | (tenant_id, offer_id); (tenant_id, received_at) → enquiries per period |
| `rm_match` | id, code, demand_id, offer_ids uuid[], is_bundle, score, flags text[], status, close_reason, reject_reason, suggested_at, confirmed_at, closed_at | match.suggested/confirmed/rejected/closed/flagged | (tenant_id, demand_id, status); GIN (tenant_id, offer_ids); (tenant_id, is_bundle, status, suggested_at) → "bundles suggested for office demand > 5,000 sq ft" (Q11, joined to rm_demand by id) |
| `rm_deal` | id, code, demand_id, offer_id, status (open/closed/cancelled), stage, follow_up_date, overdue, opened_at, closed_at, closing_price_inr, deal_type, lease_months, units_booked, cancel_reason + denormalised offer segment/property_type_primary/micromarket/locality/area | deal.opened/updated/closed/cancelled (offer dims copied from rm_offer at apply time) | (tenant_id, status, closed_at); (tenant_id, segment, micromarket, closed_at) → closed-price stats (Q4); (tenant_id, status, follow_up_date) → "In process with follow-up due" |
| `rm_market_price` | id, source (closed_by_us / retired_known), offer_id, deal_type, segment, property_type_primary, micromarket, locality, area_sqft, price_inr, rent_monthly_inr, occurred_at, void | deal.closed (source closed_by_us), offer.retired knownPriceInr, deal.cancelled (void = true) | (tenant_id, deal_type, segment, property_type_primary, micromarket, occurred_at) → avg/median price (Q4) |
| `rm_sourcing_request` | id, code, demand_id, assignee_user_id, due_date, priority, status, created_at | sourcing_request.created/updated | (tenant_id, status, due_date) → "Sourcing requests open"; (tenant_id, assignee_user_id, due_date) |
| `rm_proposal` | id, demand_id, match_ids uuid[], sent_at, feedback jsonb (matchId → verdict) | proposal.sent, proposal.feedback_recorded | (tenant_id, demand_id); (tenant_id, sent_at) → "Proposals out" |
| `rm_site_visit` | id, demand_id, offer_ids uuid[], scheduled_for, preferred_offer_id, completed_at | site_visit.scheduled/completed | (tenant_id, scheduled_for) → "Site visits this week"; (tenant_id, completed_at) |
| `rm_call` | id, subject_type, subject_id, outcome, attempt, person_unreachable, called_by, occurred_at (no person data) | call.logged | (tenant_id, called_by, occurred_at) → calls per agent |
| `rm_project` | id, code, name, rera_number, locality, micromarket, city, possession_date, offer_ids uuid[], latest_sheet_date | project.created/updated, price_sheet.applied | UNIQUE (tenant_id, code); (tenant_id, micromarket) → project stock and questions (AS-S6) |
| `rm_queue_counts` | user_id, counts jsonb (section → count), updated_at | queue.counts_changed (R-18) | PK (tenant_id, user_id) → team queue tiles (SUM over users) |
| `rm_user` | user_id, role, active (no name or e-mail: the UI resolves names via web) | user.changed | PK (tenant_id, user_id); (tenant_id, role, active) → "per agent" groupings |
| `rm_upload` | id, code, mode, source_type, source_detail, row_count, accepted, rejected, needs_review, unchanged, rejection_reasons jsonb (code → count), status, anonymised, uploaded_by, started_at, finished_at, fail_reason | upload.started/completed/failed | (tenant_id, source_type, started_at) → uploads per source, time since last upload |
| `rm_review_item` | id, upload_id, reason_code, status (open/resolved), action, resolved_by, created_at, resolved_at | review_item.created/resolved | (tenant_id, status, reason_code) → review queue by review_reason |
| `rm_merge_candidate` | id, kind (uncertain_merge / possible_repeat / price_gap), aggregate_type, raised_at | merge_candidate.raised | (tenant_id, kind, raised_at) → uncertain merges, price gaps |
| `rm_row_stat` | upload_id, record_scope, side, review_reason_code, needs_review, source_name, possible_repeat, count | rows.classified (aggregated per batch, **no row content**) | (tenant_id, upload_id); (tenant_id, review_reason_code, created_at) → side checks ("side_defaulted" per run), review by reason |
| `rm_desk_item` | id, code, record_scope, deal_types text[], side, sector, participant_role, linked_property_id, status, assignee_user_id | desk_item.created/updated | (tenant_id, record_scope, side, sector); (tenant_id, record_scope, participant_role) → "Other scopes" dashboard |
| `rm_watchlist_item` | id, code, signal_type, deadline_date, task_open boolean | watchlist_item.created, watchlist_task.completed | (tenant_id, deadline_date) WHERE task_open → "deadlines in 14 days" |
| `rm_person_flag` | id, person_id, flag, active, occurred_at | person.flagged, person.flag_removed | (tenant_id, flag, active, occurred_at) |

### 3.2 Read model: rollups (dashboards ≤ 2 s at 5M records)
**`rm_offer_rollup`**
- Dimension columns: segment, deal_type, market, property_type_primary, micromarket, owner_user_id, source_type,
  life_stage, commercial_status, record_stage, publication_level, outside_launch_area, sale_mode, tenancy_status.
- Plus `dims_hash bytea` and `n bigint`.
- It's maintained **incrementally in the projector transaction**: −1 on the old tuple, +1 on the new one, keyed by
  `dims_hash`. Merged offers leave the rollup.
- Indexes:
  - UNIQUE (tenant_id, dims_hash): delta upsert;
  - (tenant_id, segment, deal_type, market): classification grids and dashboard filters.

  With ≤ ~50k distinct tuples, a filtered SUM is ≤ 50 ms.

**`rm_demand_rollup`**: the same design for demand (deal_type_primary, commercial_status, exit_type, …).

**`rm_daily_fact`**: day date, metric text, and dimensions (segment, deal_type, market, source_type,
owner_user_id, micromarket, reason), `n bigint`.
- Metrics include: `offer_created`, `offer_verified`, `offer_published_public`, `demand_created`,
  `demand_qualified`, `demand_exit_lost|dormant|invalid`, `match_suggested|confirmed`, `deal_opened|closed`,
  `records_merged`, `upload_rows_*`, `watchlist_created`.
- It's used for period tiles ("this month"). `offer_verified` and `calls_logged` are keyed by the actor (`changedBy`, `calledBy`).
- Indexes:
  - UNIQUE (tenant_id, day, metric, dims_hash): delta upsert;
  - (tenant_id, metric, day): a period SUM per tile.

**`rm_state`**: `last_event_at` per tenant (the "data as of" shown on answers and dashboards) and `lag_seconds`.

The `rollup-reconcile` job rebuilds the rollups from the base tables nightly and corrects any drift.

### 3.3 Chat
**`conversation`**: id, code (CONV-…), user_id, title (redacted), message_count, last_message_at, deleted_at.
Indexes:
- (tenant_id, user_id, last_message_at DESC, id DESC) WHERE deleted_at IS NULL: sidebar list;
- UNIQUE (tenant_id, code);
- (tenant_id, deleted_at) WHERE deleted_at IS NOT NULL: purge job.

**`message`**:

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | |
| conversation_id | uuid | no | |
| role | text | no | user / assistant |
| redacted_text | text | no | the user's text **after redaction** (placeholders), or the assistant's composed text (PII-free) |
| redaction_counts | jsonb | no | e.g. `{"PHONE":1,"NAME":1}`: counts only |
| plan | jsonb | yes | validated QueryPlan |
| how_i_got_this | jsonb | yes | |
| cards | jsonb | no | cards as streamed but **with placeholders** (never rehydrated values) |
| outcome | text | yes | answered / action_proposed / clarify / refused / error |
| fallback_used | boolean | no | |
| model | text | yes | model id used |
| timings | jsonb | yes | redactMs, planMs, queryMs, firstTokenMs, totalMs |
| idempotency_key | uuid | yes | links a replay to the stored message |

Indexes:
- (tenant_id, conversation_id, created_at, id): message list;
- UNIQUE (tenant_id, conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL: stream replay.

**`plan_template`**: the query-plan catalogue. Seeded by migrations from `domain/plans/catalogue.ts`; changes ship
with code.
- Columns: plan_id, version, kind, description, allowed_filters jsonb, allowed_group_by text[], allowed_metrics text[],
  allowed_sort text[], base_table, max_rows, roles text[], enabled, catalogue_version.
- Indexes: UNIQUE (tenant_id, plan_id, version); (tenant_id, enabled). Global rows use the nil tenant.

**Catalogue v1** (covers PRD Appendix A):

| plan_id | kind | Base | Examples |
|---|---|---|---|
| list_offers / count_offers / group_offers | list / count / group | rm_offer | Q1, Q2, Q6, Q9, Q12, Q13 (supply side) |
| list_demands / count_demands / group_demands | list / count / group | rm_demand | Q7, Q13 (demand side), Q3 |
| supply_demand_gap | group | rm_offer_rollup + rm_demand_rollup | Q3 |
| closed_price_stats | stats (avg, median, min, max, count) | rm_market_price | Q4 |
| list_matches / list_bundles | list | rm_match ⨝ rm_demand | Q11 |
| list_deals | list | rm_deal | deals this month |
| source_quality | group | rm_demand, rm_touch, rm_offer | Q8 |
| agent_activity | group | rm_daily_fact | Q10 |
| upload_quality | group | rm_upload, rm_row_stat | data-quality questions |
| list_my_followups | list | rm_deal (follow_up_date, overdue; `me`) | Q5 "my follow-ups overdue today" |
| open_my_queue | navigate (P-01, journeys `GET /v1/queues/me`) | — | "/queue" |
| open_record | navigate (P-02..P-05) | — | "open DEM-000127" |
| export_list | export | wraps any list plan | Q9 "as an Excel file" |

### 3.4 Exports and plumbing
**`export_job`**:

| Column | Type | Null | Notes |
|---|---|---|---|
| id, code | uuid, text | no | EXP-… |
| requested_by, requester_role | uuid, text | no | |
| plan | jsonb | no | validated list plan |
| include_contacts | boolean | no | |
| status | text | no | queued / running / completed / failed / expired |
| estimated_rows, row_count | integer | yes | |
| file_path, file_bytes | text, bigint | yes | `insight-exports/<tenant>/<code>.xlsx` |
| source_message_id | uuid | yes | |
| attempts, error_code | int, text | | |
| completed_at, expires_at | timestamptz | yes | expires = completed + 24 h |

Indexes:
- (tenant_id, requested_by, created_at DESC, id DESC): `GET /v1/exports` (own);
- (tenant_id, created_at DESC, id DESC): Admin list;
- UNIQUE (tenant_id, code);
- (tenant_id, status, expires_at) WHERE status = 'completed': `export-expire`;
- (tenant_id, requested_by, created_at): the 10-per-hour check.

**`hf_usage`**: day, calls, input_tokens, output_tokens, errors, timeouts, credits_exhausted_until timestamptz.
Index: UNIQUE (tenant_id, day). The fallback check reads the current row, cached for 30 s.

**Plumbing** (as conventions):
- `outbox`, `processed_events`, `idempotency_key` (UNIQUE (tenant_id, user_id, route, key));
- `vocabulary_release` (values, absorbs table, micromarket hierarchy + aliases; UNIQUE (tenant_id) WHERE active);
- `job_checkpoint`.

**Tenancy:**
- The tenant comes from the service token `tid` (staff) or the event envelope `tenantId` (consumers).
- The SQL compiler always injects `tenant_id = $1` as the first predicate. Plans can't reference tenant_id.
- The NFR-15 test includes chat plans and exports.

## 4. Business rules and algorithms

### 4.1 Chat pipeline (AskQuestion)
```
receive (web already enforced 1 stream + 30/min) → validate body → load conversation (owner = caller)
→ 1 redact → 2 rules shortcut → 3 plan (model | fallback) → 4 validate → 5 execute → 6 compose → 7 stream → 8 store
```
1. **Redact** (`libs/redaction`):
   - Placeholders replace:
     - phones (Indian mobile/landline, spaced or obfuscated) → `⟨PHONE_n⟩`;
     - e-mails → `⟨EMAIL_n⟩`;
     - URLs → `⟨URL_n⟩`;
     - a person name next to a contact phrase ("from Rakesh", "Mr Shah", "call Sanjay", "owner Priya") → `⟨NAME_n⟩`;
     - unit/wing/flat numbers → `⟨UNIT_n⟩`;
     - any 12-hex extractor `record_id` stays (not PII).
   - Localities, micromarkets, vocabulary values and display codes (INV-…, DEM-…) are on an allow-list and are never
     masked.
   - The placeholder → value map lives **only in request memory**. It's used to refill action-card payloads streamed
     to the same user, and it's never stored or logged.
2. **Rules shortcut:**
   - "/" quick actions ("/queue", "/add demand", "/review", "/dashboard") map straight to a Navigate or Action card with
     no model call.
   - A bare display code ("DEM-000127") → `open_record`.
3. **Plan:**
   - The model returns one JSON object: `{kind: plan|action|navigate|refusal|clarify, planId?, params?, cardType?,
     slots?, question?}`.
   - If the model is unavailable, the keyword parser (§4.5) produces the plan.
4. **Validate** (§4.3). Invalid → keyword parser once. Still invalid → a `clarify` notice with suggestions.
5. **Execute:** compile the plan to parameterised SQL over the template's column allow-list.
   - `statement_timeout = 1500 ms`.
   - Lists: `LIMIT 25` inline, plus a capped count (`count(*)` over `LIMIT 10001` → "10,000+").
   - More than 25 rows → a TableCard with "Open in panel" (`POST /v1/queries` with a cursor) and an Excel button.
6. **Compose** (§4.4) → `plan` event, then `token` events (≈ 40-character chunks), then `card` events, then `done`.
7. **Store:** the redacted user message and the assistant message (text, plan, cards with placeholders, timings) in one
   transaction after `done`.
   - If the stream breaks, the message is stored with outcome `error`.
   - An idempotent replay streams the stored message (contract `x-idempotency`).

### 4.2 Hugging Face call
- **Endpoint:**
  - Phase 1a: HF **Inference Providers** router (OpenAI-compatible `/v1/chat/completions`) with free credits.
  - Paid: a **dedicated Inference Endpoint** (private, no data retention; region per data-hosting §7.4).
  - Config: `HF_BASE_URL`, `HF_MODEL`, `HF_TOKEN` (Vercel encrypted env).
- **Model:**
  - Candidates: `Qwen/Qwen2.5-7B-Instruct` (reliable JSON-schema output), with `meta-llama/Llama-3.1-8B-Instruct` as
    the alternative.
  - Fixed after the **M7 benchmark** (PRD Appendix A, ≥ 85% correct plans; each question has an expected plan).
    A Stage 7 task records the result.
- **Request:** `temperature 0`, `max_tokens 400`, `response_format: json_schema` (the union of plan/action/navigate/
  refusal/clarify schemas).
  - System prompt:
    - the rules ("never answer from your own knowledge; only choose a plan; refuse anything not about 11 Estates data");
    - the compact catalogue (plan ids, allowed fields, ops);
    - vocabulary values;
    - today's date in IST;
    - the caller's role;
    - the optional context code.
  - User message: the **redacted** question and the last 2 redacted turns (for follow-ups like "only Fresh ones").
- **Budget:** the whole model phase has **2.5 s**.
  - Connect + response timeout: 2.0 s.
  - One retry only if the first attempt failed in < 1 s (connection reset, 5xx).
  - Circuit breaker: 50% failures over 20 calls → open 30 s.
- **Concurrency cap:** 5 (pilot) / 20 (paid), via a per-instance semaphore plus the `hf_usage` counters.
- **Credits:**
  - HTTP 402, or a provider "quota" error → `credits_exhausted_until` = the 1st of next month 00:00 IST.
  - HTTP 429 → +60 s.
  - While set, the model is skipped and the fallback is used.
  - `/health/ready` reports `checks.model = degraded`.
- The model output is **untrusted input**. It's parsed with a JSON schema; anything else → fallback.

### 4.3 Plan validation
1. `planId` exists, is enabled, and the caller's role is in `roles`.
2. Every filter `field` is in `allowed_filters` and every `op` is allowed. `groupBy`, `metrics` and `sort` are from
   the allowed lists. `limit ≤ max_rows`.
3. Vocabulary fields:
   - Values must be in the active release.
   - Legacy terms are translated first ("rent", "leave and license" → Lease; "resale" → Sale + market Secondary;
     "new project" → Sale + Primary; "gala" → property_type Gala, segment Industrial) and listed in
     `howIGotThis.translatedTerms`.
   - **Labels are never accepted as values** ("For Rent" → Lease via the translator only).
4. Locality/micromarket names are resolved through the hierarchy and its aliases (e.g. "Chakala" is inside Andheri East).
   An unknown name → clarify ("I don't know the locality ⟨…⟩").
5. **Placeholders** (`⟨PHONE_1⟩` …) are not allowed as filter values, because the read model has no contacts. The
   answer is a Navigate card to the records person lookup (quick-add phone lookup), done in the UI.
6. Numbers: prices in INR integers (the model is told to convert "3 Cr" → 30000000; it's cross-checked against the
   keyword parser's extraction when both exist). Areas in sq ft. BHK in 0.5 steps.
7. `period` presets are resolved in IST. `me: true` → `owner_user_id = caller`.

### 4.4 Answer composition (grounded, no model text)
- Deterministic templates per kind:
  - **count:** "There are {n} {labelled description}." e.g. "There are 42 **For Rent** 2 BHK Apartment offers in Andheri
    West that are Available."
  - **list:** "Here are {k} of {n} {description}." + TableCard.
  - **stats:** "Average closed rent for Office in Marol this quarter: ₹1,12,000/month across 7 closes (median ₹98,000;
    range ₹72,000–₹1,60,000)."
  - **group:** a lead sentence (top 3 groups) + TableCard.
  - **empty:** "No {description} found." + suggestions from relaxing one filter.
- Labels come from the BRD §4.2 generator. Numbers use the Indian format.
- `howIGotThis`: the plan, a plain-English description from `describe(plan)`, the filters with labels, the row count,
  `dataAsOf` (`rm_state.last_event_at`), and the catalogue and vocabulary versions.
- A model-written answer is **not** used in Phase 1. It would add hallucination risk and latency for little gain.

### 4.5 Keyword fallback (credits exhausted, timeout, invalid output)
Tokenise the redacted text, then match:
- vocabulary values and legacy terms (deal type, market, segment, property type, furnishing, sale_mode, tenancy);
- BHK (`\d(\.5)?\s*bhk`, "1 rk" → 0.5);
- price (`(under|below|upto|<)\s*₹?\s*\d+(\.\d+)?\s*(k|l|lakh|lac|cr|crore)`);
- area (`\d[\d,]*\s*(sq\.?\s*ft|sqft|square feet)`);
- life stages; "this week/month/quarter";
- localities and micromarkets (hierarchy + aliases).

Side words decide the base plan:
- demand words ("requirement", "wants", "looking for", "client needs") → demand plans;
- supply words ("available", "inventory", "offer", "listing") → offer plans;
- "match … requirement" (Q13) → `list_offers` with the stated filters, and a Notice suggesting the Matches card for
  a specific demand;
- "how many" → count; "excel", "export", "download" → export_list;
- nothing matched → the out-of-scope notice.

The answer always carries `NoticeCard{notice: model_unavailable_keyword_fallback}` and `fallbackUsed: true`.

### 4.6 Out of scope ("only answers from 11 Estates data")
- The model returns `refusal`, or no catalogue plan fits (general knowledge, the repo rate, the weather, legal advice,
  market news) → `NoticeCard{notice: out_of_scope, text: "I can only answer from 11 Estates data."}` + 3 example
  questions. The outcome is `refused`.
- A question needing data insight doesn't hold (contacts, a person's phone, building names) → a Navigate card to the
  owning panel.

### 4.7 Proposed-action cards (R-CHAT-1)
The model returns `kind: action` with a `cardType` and `slots`. `cardBuilder`:
1. Looks up `actionCatalogue[cardType]`.
2. Resolves codes to ids through the read model: the subject must exist and not be merged away.
3. Validates the slots against the payload schema subset (controlled values only).
4. Refills placeholders from the request map (the browser gets the real phone the user typed; storage keeps
   `⟨PHONE_1⟩`).
5. Sets `allowedRoles` from the catalogue. If the caller's role isn't allowed → a Notice `not_allowed_for_role`.
6. Pre-generates `idempotencyKey` and sets `expiresAt` = now + 30 min.

**insight never calls the target.** On click, the UI sends the request through web, and the owner re-checks everything.

The operationIds below match the current contracts. **method + path is authoritative**, in case the owning agents rename
an operationId while aligning.

| cardType | targetService | targetOperation | method path |
|---|---|---|---|
| C-04 Upload | intake | createUpload, startUpload | POST /v1/uploads · POST /v1/uploads/{idOrCode}/start |
| C-05 Review | intake | resolveReviewItem | POST /v1/review-items/{id}/resolve |
| C-06 Quick add | records | quickAddLookup, quickAdd | POST /v1/quick-add/lookup · POST /v1/quick-add |
| C-07 Add supply | records | addSupplyForDemand | POST /v1/demands/{idOrCode}/add-supply |
| C-08 Call outcome | journeys | logCall | POST /v1/calls |
| C-09 Qualify | journeys | qualifyDemand | POST /v1/demands/{idOrCode}/qualify |
| C-10 Matches | crm-engine | confirmMatch / rejectMatch / createBundle | POST /v1/matches/{idOrCode}/confirm · /reject · POST /v1/bundles |
| C-11 Sourcing request | journeys | createSourcingRequest | POST /v1/sourcing-requests |
| C-12 Publication | listings | setOfferPublication | PUT /v1/offers/{idOrCode}/publication |
| C-13 Proposal | journeys | createProposal, generateProposalPdf, createProposalShareLink, markProposalSent | POST /v1/proposals · POST /v1/proposals/{idOrCode}/pdf · /share-link · /mark-sent |
| C-14 Site visit | journeys | scheduleSiteVisit, completeSiteVisit | POST /v1/site-visits · POST /v1/site-visits/{idOrCode}/complete |
| C-15 Deal | journeys | openDeal / updateDeal / cancelDeal | POST /v1/deals · PATCH /v1/deals/{idOrCode} (If-Match) · POST /v1/deals/{idOrCode}/cancel |
| C-16 Exit | journeys | exitDemand | POST /v1/demands/{idOrCode}/exit |
| C-17 Close / retire | journeys | retireOffer / updateDeal | POST /v1/offers/{idOrCode}/retire · PATCH /v1/deals/{idOrCode} |
| C-18 Price sheet | records | addPriceSheet | POST /v1/projects/{idOrCode}/price-sheets |
| C-19 Confirm (bulk) | journeys | putCapacity / reassignQueueItems | PUT /v1/capacities/{userId} · POST /v1/queue-items/reassign |
| C-21 Desk item | records / journeys | patchDeskItem / completeWatchlistTask | PATCH /v1/desk-items/{idOrCode} (If-Match) · POST /v1/watchlist-tasks/{taskId}/complete |

For PATCH targets the card carries `ifMatch` (the version read from the read model when the card is built). A stale
version → 412 from the owner, and the UI re-fetches.

### 4.8 Dashboards (BRD §8, PRD US-30; ≤ 2 s p95)
Every tile has a `drillDown` QueryPlan that opens the list through `POST /v1/queries`. Filters are stored fields only:
period, segment, dealType, market, propertyType, micromarket, ownerUserId, saleMode, tenancyStatus. Labels are
generated for display only.

| Dashboard | Section | Source |
|---|---|---|
| demand | By source (Channel/Digi/Direct, first touch), duplicates merged this week | rm_daily_fact (demand_created by source_type), records_merged |
| | Life curve (Fresh/Ageing/Stale/Expired) | rm_demand_rollup by life_stage |
| | Team queues (To contact, To qualify, Reconfirm due, In sourcing, Sourcing requests open, Open matches, Proposals out, Site visits this week, In process with follow-up due, Deals this month) | **rm_queue_counts** (`queue.counts_changed.v1`, R-18) summed over the team + rm_sourcing_request, rm_site_visit (scheduled_for), rm_deal (follow_up_date) |
| | Exits this month with reasons | rm_daily_fact (demand_exit_* by reason) |
| | Classification grid (segment × deal_type; Sale split Secondary/Primary/Any), Wants labels | rm_demand_rollup |
| supply | Stock (properties, projects, offers; duplicates linked) | rm_offer_rollup, count distinct property_id (nightly), rm_daily_fact |
| | Life curve | rm_offer_rollup by life_stage |
| | Queues and listings (Must call, Should call, Upcoming, share verified, listed Public/Anonymous) | rm_queue_counts (Must/Should call, R-18) + rm_offer_rollup (commercial_status, record_stage, publication_level) |
| | Classification grid with For labels; deal-tag filters (Auction, Tenanted) | rm_offer_rollup (sale_mode, tenancy_status dims) |
| scopes | Business/Capital by deal_type, side, sector (includes_property via linked_property_id); Archive (Equipment by side); Network (by participant_role); Watchlist (by signal_type, deadlines ≤ 14 days, open tasks) | rm_desk_item, rm_watchlist_item |
| quality | Uploads per source (accepted, rejected **with reasons** from `rejectionReasons`, duplicates, time since last upload) | rm_upload, rm_row_stat |
| | Review queue by review_reason; uncertain merges; price gaps | rm_review_item (open, by reason_code), rm_merge_candidate (by kind) |
| | Side checks (side_defaulted per run) | rm_row_stat (review_reason_code = side_defaulted) per upload |
| | Source quality (share that verify, match, close) | rm_offer by source_type × record_stage/match/closed |

- Role rule: Data operator → quality only (PRD §2.3); other dashboards → 403.
- Response `Cache-Control: private, max-age=30`.
- Server-side memo per (tenant, dashboard, filters) for 30 s.

### 4.9 Exports (US-32, A-25, R-16, R-21)
1. `POST /v1/exports`:
   a. Validate the plan (a list kind only).
   b. `estimated_rows` = capped count. The cap is **100,000 rows in production and 20,000 in the pilot** (R-16, config
      `EXPORT_MAX_ROWS`). Over the cap → 422 `export-too-large`.
   c. `includeContacts` → the role must be Admin, Manager, Demand agent or Supply agent, else 403
      `contacts-not-allowed` (Data operators: open, A-I3).
   d. 10 exports per hour per user.
   e. Insert `export_job` (queued) and enqueue on `q_insight_exports`. Return 202.
2. Job (drain `q_insight_exports`, one job per invocation):
   a. Keyset-paginate the plan query (5,000 rows per page) into a **streaming** xlsx writer.
   b. With contacts: for each page, call records `POST /internal/v1/contacts:batch` (serviceToken issued by web,
      ≤ 1,000 ids per call; records audit-logs every call, R-21). Write the contacts straight to the file. They're never
      stored in insight tables or logs.
   c. Upload to `insight-exports/<tenant>/<code>.xlsx` (private).
   d. In one transaction: status completed, `row_count`, `expires_at = now + 24 h`, and outbox rows:
      - `export.completed.v1 {exportId, code, rowCount, requestedBy, includesPii}`;
      - `audit.recorded.v1 {action: "export.created", subjectType: "export", subjectId, via: ui|chat, details}`.
        `details` is a flat string map with no PII: `{rowCount, includesPii, planId}`.
3. `GET /v1/exports/{id}`: requester or Admin only. While completed and not expired, mint a **10-minute signed URL** on
   each call.
4. `export-expire` (every 15 min): delete the file and set status expired. Later GETs → 410.
5. Failure: 3 attempts, then status failed with `error_code`, and `export.failed.v1 {exportId, code, requestedBy,
   reason}` (reason = error code, no PII). web notifies the requester (R-6).

### 4.10 Read-model projection
- Consumer `q_insight`: dedupe on `processed_events`. Per-aggregate ordering uses the stored per-producer version
  columns: an older or equal `aggregateVersion` is ignored (it still counts as processed).
- Each handler is a pure reducer (`domain/readmodel/projectors`). It returns row upserts plus rollup and daily-fact
  deltas, applied in one transaction with the `processed_events` insert.
- Events for an unknown aggregate (e.g. `match.suggested` before `demand.created`) create a stub row with only the id.
  Later events fill it (tolerates out-of-order delivery).
- Merges:
  - `records.merged` sets `merged_into_id` on the merged rows and removes them from the rollups.
  - `records.merge_undone` clears it and re-adds them.
- The event → table mapping is in §3.1–3.2 ("Filled by" / "Events" columns). `rm_state.last_event_at` =
  max(occurredAt applied).
- Batch 200 events per drain call, every minute + poke. Target lag p95 ≤ 60 s. Alarm on lag > 5 min (conventions §7).

## 5. Events

### 5.1 Produced
| Event | When | Consumers |
|---|---|---|
| `export.completed.v1` | Export file ready | web (notification) |
| `export.failed.v1` | Export failed after 3 attempts | web (notification) |
| `audit.recorded.v1` | `export.created` (details: rowCount, includesPii, planId; a flat string map with no PII) | web (audit log) |

### 5.2 Consumed (queue `q_insight`, exactly the 63 insight subscriptions in `events.yaml` v0.2)
- **intake:** `upload.started.v1`, `rows.classified.v1`, `upload.completed.v1`, `upload.failed.v1`,
  `review_item.created.v1`, `review_item.resolved.v1`.
- **records:**
  - offers and demands: `offer.created.v1`, `offer.updated.v1`, `offer.price_changed.v1`,
    `offer.record_stage_changed.v1`, `demand.created.v1`, `demand.updated.v1`, `demand.touch_added.v1`,
    `enquiry.received.v1`, `offer.voided.v1`, `demand.voided.v1`;
  - merges and people: `records.merged.v1`, `records.merge_undone.v1`, `person.flagged.v1`, `person.flag_removed.v1`;
  - reference data: `watchlist_item.created.v1`, `vocabulary.released.v1`, `micromarkets.updated.v1`;
  - photos and projects: `photo.added.v1`, `photo.removed.v1`, `project.created.v1`, `project.updated.v1`,
    `price_sheet.applied.v1`;
  - desks and review: `desk_item.created.v1`, `desk_item.updated.v1`, `merge_candidate.raised.v1`.
- **journeys:**
  - life curve and status: `offer.confirmed.v1`, `demand.confirmed.v1`, `lifecycle.stage_changed.v1`,
    `offer.commercial_status_changed.v1`, `demand.qualified.v1`, `demand.status_changed.v1`, `demand.exited.v1`,
    `demand.reactivated.v1`, `demand.sourcing_started.v1`;
  - sourcing, proposals and visits: `sourcing_request.created.v1`, `sourcing_request.updated.v1`,
    `proposal.sent.v1`, `proposal.feedback_recorded.v1`, `site_visit.scheduled.v1`, `site_visit.completed.v1`;
  - deals and offers: `deal.opened.v1`, `deal.updated.v1`, `deal.closed.v1`, `deal.cancelled.v1`,
    `offer.retired.v1`;
  - tasks, calls and queues: `watchlist_task.completed.v1`, `call.logged.v1`, `queue.counts_changed.v1`.
- **crm-engine:** `match.suggested.v1`, `match.confirmed.v1`, `match.rejected.v1`, `match.closed.v1`,
  `match.flagged.v1` (with `cleared`), `match.reopened.v1`, `demand.matching_completed.v1`.
- **listings:** `publication.changed.v1`.
- **web:** `user.changed.v1` (role and active only; `displayName` is not stored).

`q_insight_exports` is an internal work queue, not a domain event. HLD names `offer.closed.v1` and
`offer.upcoming_created.v1` are superseded (R-19).

## 6. Error codes
| Code | HTTP | Where | Meaning |
|---|---|---|---|
| validation-failed | 400 | all | Body or params invalid |
| unknown-vocabulary-value | 400 | dashboards, queries | Filter value not in the release (labels are rejected) |
| invalid-cursor | 400 | lists, queries | |
| unauthenticated | 401 | all | |
| forbidden | 403 | all | Role not allowed (e.g. Data operator on the supply dashboard; another user's conversation or export) |
| contacts-not-allowed | 403 | POST /v1/exports | includeContacts for a role without contact export rights |
| not-found | 404 | conversations, exports | |
| conflict / idempotency-key-reused | 409 | POST | |
| export-expired | 410 | GET export | Older than 24 h |
| payload-too-large | 413 | POST message | Text > 2,000 characters |
| plan-invalid | 422 | queries, exports | Plan fails validation (`errors[]` per field) |
| plan-not-in-catalogue | 422 | queries, exports | Unknown or disabled planId |
| export-too-large | 422 | POST export | > 100,000 rows (production) / > 20,000 (pilot, R-16) |
| rate-limited | 429 | all | web buckets, or 10 exports/hour |
| query-timeout | 503 / SSE `error` | queries, dashboards, chat | Statement timeout (1.5 s) or the 15 s stream cap |
| dependency-unavailable | 503 | exports (records contacts), vocabulary refresh | |
| internal | 500 | all | |

The model being unavailable is **not** an error: the fallback answers with a notice. An out-of-scope question is
**not** an error either: it's an SSE `card` with the `out_of_scope` notice and `done.outcome = refused`.

## 7. PII fields and retention
**Decision: the read model is PII-free. Contacts are fetched from records only at export time.**

Why:
1. The redaction boundary stays trivially provable: nothing insight stores or plans over contains contacts, so no
   prompt can leak one.
2. There's no second copy of PII to purge under NFR-18. The 24-month purge happens once, in records.
3. Events carry no contact PII (conventions §5), so a PII read model would need extra sync calls anyway.
4. Contact exports are rare and audited per export.

Cost: exports with contacts depend on records `POST /internal/v1/contacts:batch` (R-21) and take longer.

| Data | PII? | Retention |
|---|---|---|
| rm_* tables | No (ids, codes, classification, prices, areas, localities, staff user ids) | Life of the owner's record. Rows for purged records disappear via the owner's events (merge/retire); `rollup-reconcile` removes orphans |
| `message.redacted_text`, `conversation.title` | **Redacted** (placeholders). Residual risk: a name without a contact phrase may survive. Marked `-- PII-possible`, never logged. Private to the author (R-17) | 180 days after the last message, or on user delete (soft delete → purged within 24 h) |
| `message.cards` | Placeholders only (rehydrated values exist only in the SSE stream) | As messages |
| Export files (with `includeContacts`) | **Yes**: names, phones, e-mails from records | 24 h, then deleted. Private bucket; 10-minute signed URLs; audit event per export |
| `export_job` | No (plan, counts) | 1 year (audit trail of what was exported) |
| `hf_usage` | No | 13 months |
| Logs | Allow-listed fields only. The question text, the model prompt and output, and plan values are **never logged**; only planId, timings and outcome | Platform |

What leaves insight towards Hugging Face: the redacted question, the last 2 redacted turns, the catalogue, the
vocabulary values, the date and the role. **Never** read-model rows.

## 8. Performance
**Chat (NFR-7: first token ≤ 3 s, full ≤ 15 s p95)**

| Step | Budget p95 |
|---|---|
| web auth + rate limit + forward | 60 ms |
| Load conversation + last 2 turns | 30 ms |
| Redaction | 20 ms |
| Model plan (2.0 s timeout; fallback beyond) | 1,800 ms |
| Validate + compile | 20 ms |
| Query (statement_timeout 1.5 s; typical ≤ 300 ms with the §3 indexes) | 400 ms |
| Compose + first `plan`/`token` frame | 10 ms |
| **First token** | **≈ 2.3 s** (hard ceiling 3 s: a model timeout at 2.5 s switches to the fallback, answering in ≈ 0.5 s) |
| Remaining frames, store | ≤ 1 s → **total ≈ 3.5 s typical, ≤ 15 s cap** |

- **Concurrency:** 1 stream per user (web). Model calls are capped at 5 (pilot) or 20 (paid) per the HLD §8. With 30
  staff, the peak is ~10 concurrent streams, within the cap.
- **Dashboards (NFR-8 ≤ 2 s at 5M records):**
  - every tile reads a rollup (≤ 50k rows) or daily facts (≤ 366 days × dims), in parallel over ≤ 3 connections;
  - p95 target 400 ms;
  - drill-downs use the base-table indexes with LIMIT 25.
- **Queries (`POST /v1/queries`):** NFR-2 target p95 < 300 ms for indexed plans. Unindexed combinations are prevented by
  the catalogue (allowed filters ↔ indexes in §3.1). A capacity-plan test covers every catalogue plan at 5M rows.
- **Consumer throughput:** a 100k-row upload creates ~100k offer/demand events, plus `rows.classified` batches. At 200
  events per drain and ~1 s per batch, that's ≈ 8 min of lag at 1 drain/min. The drain loops while `more = true`
  (≤ 55 s per invocation), so lag stays ≤ ~10 min for a 100k-row upload (acceptable: dashboards show `dataAsOf`).
- **DB pool:** `insight_svc` pilot 3 / production 6–10 (data-hosting §5). Exports use 1 connection.
- **Exports:**
  - 100k rows × ~30 columns ≈ 10–15 MB xlsx, ≈ 60–120 s on Vercel Pro (800 s limit).
  - The pilot is capped at 20,000 rows (R-16), which fits the Hobby function limit.
- **Pilot (CR-005):** the free HF credits are small, so the fallback will be common. It's tested as a first-class path.
  Pilot volumes are ≤ 200k records, so the rollups are tiny.

## 9. Endpoint summary
| Method | Path | Auth | Roles | Idempotency | Paginated | Rate limit | Timeout | Emits |
|---|---|---|---|---|---|---|---|---|
| GET | /v1/chat/conversations | staffViaWeb | all staff (own) | safe | cursor ≤ 100 | web user 20/s | 2 s | — |
| POST | /v1/chat/conversations | staffViaWeb | all staff | Idempotency-Key | — | web user | 2 s | — |
| GET | /v1/chat/conversations/{conversationId} | staffViaWeb | owner | safe | — | web user | 2 s | — |
| DELETE | /v1/chat/conversations/{conversationId} | staffViaWeb | owner | idempotent | — | web user | 2 s | — |
| GET | /v1/chat/conversations/{conversationId}/messages | staffViaWeb | owner | safe | cursor ≤ 100 | web user | 2 s | — |
| POST | /v1/chat/conversations/{conversationId}/messages (SSE) | staffViaWeb | all staff | Idempotency-Key (stored replay) | — | 1 stream + 30/min | first token 3 s, total 15 s | — |
| GET | /v1/chat/plan-catalogue | staffViaWeb | all staff | safe | — (≤ 100) | web user | 2 s | — |
| POST | /v1/queries | staffViaWeb | all staff (template roles) | safe (read-only) | cursor ≤ 100 | web user | 2 s | — |
| GET | /v1/dashboards/demand | staffViaWeb | Admin, Mgr, Demand, Supply | safe | — | web user | 2 s | — |
| GET | /v1/dashboards/supply | staffViaWeb | Admin, Mgr, Demand, Supply | safe | — | web user | 2 s | — |
| GET | /v1/dashboards/scopes | staffViaWeb | Admin, Mgr, Demand, Supply | safe | — | web user | 2 s | — |
| GET | /v1/dashboards/quality | staffViaWeb | all staff | safe | — | web user | 2 s | — |
| POST | /v1/exports | staffViaWeb | all staff (contacts: not Data operator, A-I3 open) | Idempotency-Key | — | web user + 10/h | 2 s (async 202) | export.completed.v1 / export.failed.v1, audit.recorded.v1 |
| GET | /v1/exports | staffViaWeb | all staff (own; Admin all) | safe | cursor ≤ 100 | web user | 2 s | — |
| GET | /v1/exports/{idOrCode} | staffViaWeb | requester, Admin | safe | — | web user | 2 s | — |
| POST | /internal/v1/relay | cronSecret | scheduler | idempotent | — | — | 55 s | export.completed.v1, export.failed.v1, audit.recorded.v1 (relayed) |
| POST | /internal/v1/drain/{queue} | cronSecret | scheduler | processed_events | batch ≤ 500 | — | 55 s | export.completed.v1, export.failed.v1, audit.recorded.v1 |
| POST | /internal/v1/jobs/{name} | cronSecret | scheduler | resumable | — | — | 55 s | — |
| GET | /health/live | none | — | safe | — | — | 0.5 s | — |
| GET | /health/ready | none | — | safe | — | — | 1 s | — |

## 10. Contract gaps, assumptions, open questions

### Closed by events v0.2 and conventions §10
| Former gap | Resolution |
|---|---|
| G-I1 other scopes | `desk_item.created/updated.v1` → `rm_desk_item` |
| G-I2 verifier | `offer.record_stage_changed.v1.changedBy` |
| G-I3 review/merges/price gaps | `review_item.created.v1` + `review_item.resolved.v1`, `merge_candidate.raised.v1` |
| G-I4 rejection reasons | `upload.completed.v1.rejectionReasons` |
| G-I5 queues / deal follow-ups | `queue.counts_changed.v1` (R-18), `deal.updated.v1` |
| G-I6 contacts for exports | records `POST /internal/v1/contacts:batch` (R-21) |
| G-I7 projects | `project.created/updated.v1`, `price_sheet.applied.v1` |
| G-I8 export failure | `export.failed.v1` (produced) |
| G-I9 action-card operations | the mapping in §4.7 matches the current contracts; method + path is authoritative |
| G-I10 visits / SRQ / feedback | `site_visit.scheduled.v1`, `sourcing_request.updated.v1`, `proposal.feedback_recorded.v1` |
| G-I11 price types | `offer.price_changed.v1` prices are typed |
| G-I12 system actor | R-7 |
| OQ-I1 chat privacy | R-17: private to the author |
| OQ-I2 pilot exports | R-16: 20,000-row pilot cap |

### Remaining gaps
| # | Gap | Proposal |
|---|---|---|
| I-1 | `records.yaml` doesn't yet contain `POST /internal/v1/contacts:batch` (R-21). The records agent is aligning in parallel. | Confirm the request/response shape: ids ≤ 1,000 → `{id, contactName, phones, emails}` per offer/demand. |
| I-2 | `queue.counts_changed.v1.counts` is a free map (section → count). Tile keys need a fixed list of section names. | journeys to document the section keys (e.g. `must_call`, `should_call`, `to_contact`, …) in the event description. |
| I-3 | Market data "closed elsewhere / reported" (records market data points) still has no event. Price stats use only our closes, known prices on retire, and `demand.exited.competingPriceInr`. | Additive `market_data.recorded.v1`, if the product owner wants those in chat. |

### Assumptions
- **A-I2** Answers are composed from deterministic templates (no model-written prose) in Phase 1.
- **A-I4** Conversation retention is 180 days. Export job metadata is kept 1 year.
- **A-I5** 10 exports per user per hour.
- **A-I6** The model is fixed after the M7 benchmark. Qwen2.5-7B-Instruct is the first candidate.

### Open questions (product owner)
- **A-I3** Contact columns in exports are allowed for Admin, Manager, Demand agent and Supply agent. **May Data
  operators export contacts?** Currently no.
