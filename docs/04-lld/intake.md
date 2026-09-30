# 04 — LLD: `intake` service (S1)

| | |
|---|---|
| Version | 0.2 (draft; aligned to events v0.2 and conventions §10) |
| Date | 2026-09-24 |
| Based on | HLD v0.2 §2 S1, §5.1, §6, ADR-0004/0005/0008; PRD v0.6 US-01…03, US-07a, US-10, D-15, D-16, §8.4, Appendix C; BRD v0.6.1 §4.2, §4.7; CR-006 |
| Contract | [`contracts/openapi/intake.yaml`](../../contracts/openapi/intake.yaml) (30 operations) · events: [`contracts/asyncapi/events.yaml`](../../contracts/asyncapi/events.yaml) |
| Shared rules | [`conventions.md`](conventions.md) incl. §10 reconciliation decisions R-1…R-22 (they override this document); events catalogue v0.2 |
| Status | IN PROGRESS (Stage 4) |

---

## 1. Purpose and scope

intake turns **uploaded files** (and, for quick add, **typed free text**) into validated, classified candidate rows in the
standard vocabulary, and hands them to records. It never creates business records itself.

| In scope | Refs |
|---|---|
| Upload lifecycle: signed upload URL, inspection, strict/mapping mode detection, mapping + templates, start, chunked processing, progress, report, rejected rows | US-01, US-02, D-15, ADR-0005 |
| Row validation against the controlled vocabulary (strict mode) and legacy-term translation (mapping mode) | BRD §4.2, §4.7, FR-ING-3 |
| Classification: rules first, redacted Hugging Face model for leftovers only | US-10, ADR-0004 |
| Idempotent master re-uploads (upsert key `record_id` + content hash), `migration_map` sheet parsing | US-07a, CR-006 Z-5 |
| Review reason codes, classification review queue (grouped), resolution | US-07a AC5, C-05, CR-006 Z-6 |
| Pilot anonymise-on-import switch | PRD §8.4, CR-006 Z-9 |
| Free-text parse for quick add prefill (no storage) | US-04 AC2, C-06 |

Out of scope (owned elsewhere): dedup, merges, record creation, source ads and splits (records); source freshness tiles
(insight, from `upload.*` events); uncertain-merge and price-gap review (records `/v1/merge-candidates`, `/v1/second-sources`).

---

## 2. Internal module layout

Language/runtime are confirmed in Stage 6; the layout assumes TypeScript on Vercel Functions (Node.js), HLD §10.

```
services/intake/
  src/
    domain/                      # pure: no framework, SDK, SQL or I/O imports
      upload/        Upload (aggregate + status machine), ChunkPlan, BatchNumbering, UploadCounts
      schema/        StandardSchema (the 89 Appendix C columns), HeaderMatcher → IntakeMode, TargetField
      validation/    RowValidator (types, controlled values, cross-field rules), RowError, Severity
      translation/   LegacyTermTranslator (BRD §4.2 "absorbs" + §16 legacy terms), TranslationResult
      classification/RulesClassifier (side phrases, scope cues, BHK/area/price/locality extractors),
                     ModelOutputValidator, ReasonCodeDeriver, ClassificationResult
      identity/      ExternalRefPolicy, ContentHasher (canonical JSON → sha256)
      anonymisation/ Anonymiser (pure; takes an injected keyed-hash function)
      migration/     MigrationMapParser, MigrationEntry
      review/        ReviewItem (+ resolution rules)
      ports.ts       domain-level ports: VocabularySnapshot, KeyedHash, Clock, IdGenerator
    application/                 # use cases; depend only on ports
      ports.ts       UploadRepository, ChunkRepository, RawRowRepository, RowErrorRepository, FingerprintRepository,
                     TemplateRepository, ReviewItemRepository, MigrationMapRepository, VocabularyRepository,
                     FileStore (signed URLs, streaming read/write, delete), SpreadsheetReader (streaming rows per sheet),
                     ModelClassifier (redacted text only), Redactor, Outbox, WorkQueue, UnitOfWork, CodeIssuer,
                     VocabularySource (records API), IdempotencyStore, TenantPolicy (pilot mode, chunk size, concurrency)
      uploads/       CreateUpload, InspectUpload, PatchUpload, SetMapping, StartUpload, CancelUpload, GetProgress,
                     ListRowErrors, GetRejectedRowsLink, GetMigrationMap
      processing/    SplitUpload, ProcessChunk, FinalizeUpload, ServeBatchRows, ServeMigrationMap
      templates/     Create/Get/List/Replace/DeleteTemplate
      review/        ListReviewItems, GetReviewSummary, ResolveReviewItem, BulkResolveReviewItems
      parse/         ParseFreeText
      vocabulary/    ApplyVocabularyRelease (consumer of vocabulary.released.v1)
      jobs/          RetentionPurge, ExpireIdempotencyKeys, ReapChunkLeases, DeleteProcessedFiles
    adapters/
      http/          route handlers generated from intake.yaml (request validation at the edge), auth middleware
                     (service token verify, role + tenant re-check), RFC 7807 mapper, correlation-id middleware
      db/            Postgres repositories (Supavisor transaction mode, no prepared statements), UnitOfWork
      storage/       Supabase Storage FileStore (buckets intake-uploads, intake-rejected)
      spreadsheet/   streaming xlsx reader, xls reader, CSV line reader
      model/         HuggingFaceModelClassifier (2 s timeout, no retry, circuit breaker, concurrency cap)
      queue/         pgmq WorkQueue + outbox relay + drain dispatcher (libs/outbox)
      records/       VocabularySource (GET records /v1/vocabulary with a service token)
    main.ts          composition root: reads env/secrets, builds adapters, injects them into use cases, exports handlers
  migrations/        forward-only SQL (expand → migrate → contract), 0001_init.sql …
  tests/
    unit/            domain: validator, translator, reason codes, hasher, anonymiser, header matcher, batch numbering
    integration/     adapters against local Supabase: repositories, pgmq, storage, xlsx/csv readers
    contract/        OpenAPI conformance (every route), AsyncAPI payload conformance for produced events
    tenancy/         tenant A cannot read or write tenant B (NFR-15)
    fixtures/        PII-free synthetic extractor master (89 cols), mapping-mode samples, migration_map sample
  Dockerfile  README.md
```

Shared infrastructure from `libs/` (no domain models): logging (PII allow-list), tracing, outbox + relay + drain,
idempotency middleware, service-token verification, **redaction** (ADR-0004), RFC 7807 helpers, pooled DB client with
per-role semaphore.

---

## 3. Data schema (schema `intake`, role `intake_svc`)

Common columns on every table unless stated: `id uuid` (UUIDv7, PK), `tenant_id uuid not null`, `created_at timestamptz not null
default now()`, `updated_at timestamptz not null default now()`. Mutable aggregates add `version int not null default 1`.
`-- PII` marks personal data (never logged). All timestamps UTC.

### 3.1 `uploads`
| Column | Type | Null | Notes |
|---|---|---|---|
| code | text | no | `UPL-000123`, from `code_sequences` |
| file_name | text | no | as given by the browser |
| content_type | text | no | csv / xls / xlsx MIME |
| size_bytes | bigint | no | ≤ 52,428,800 |
| storage_path | text | no | `intake-uploads/{tenant}/{id}/source` |
| sha256 | text | yes | set by inspection |
| sheet_names | text[] | yes | all sheets |
| sheet_name | text | yes | sheet to load (default `Leads`, else the first sheet) |
| header | text[] | yes | header cells only, never data cells |
| header_fingerprint | text | yes | sha256 of the sorted normalised headers |
| mode | text | yes | check in (`strict`,`mapping`) |
| status | text | no | check in (`awaiting_file`,`inspecting`,`awaiting_mapping`,`ready`,`awaiting_duplicate_confirmation`,`queued`,`processing`,`completed`,`failed`,`cancelled`) |
| stage | text | yes | `parsing`/`normalising`/`classifying`/`emitting` |
| source_type | text | no | `Channel`/`Digi`/`Direct` |
| source_detail | text | yes | |
| template_id | uuid | yes | FK → templates.id |
| column_map | jsonb | yes | sourceHeader → target field |
| suggested_mapping | jsonb | yes | from template fingerprint + header synonyms |
| constants | jsonb | yes | mapping-mode constants (sourceType, sourceName, …) |
| anonymise | boolean | no | pilot switch (§4.9) |
| import_crm_notes | boolean | no | default false (CR-006 Z-8 one-time import) |
| reprocess_unchanged | boolean | no | default false (§4.7) |
| vocabulary_version | text | yes | pinned at start |
| has_migration_map | boolean | no | default false |
| migration_entries | int | no | default 0 |
| duplicate_of_upload_id | uuid | yes | FK → uploads.id |
| chunk_size | int | yes | 500 pilot / 2,000 paid, fixed at start |
| chunk_count, chunks_done, chunks_failed | int | yes/no/no | counters (done/failed default 0) |
| batch_count, batches_emitted | int | yes/no | |
| rows_read, rows_accepted, rows_rejected, rows_needs_review, rows_unchanged, rows_unclassified | int | no | default 0; updated in chunk transactions |
| rejected_file_path | text | yes | `intake-rejected/{tenant}/{id}.csv` |
| rejected_file_ready_at | timestamptz | yes | |
| failure_reason | text | yes | `too_many_rows`, `chunk_failed`, `unreadable_file`, `cancelled`, … |
| uploaded_by | uuid | no | user id (X-User-Id) |
| started_at, completed_at | timestamptz | yes | |
| source_file_deleted_at | timestamptz | yes | |
| purge_after | timestamptz | yes | completed_at + retention (§7) |
| version | int | no | |

| Index / constraint | Serves |
|---|---|
| PK (id) | `GET /v1/uploads/{uuid}`, all internal lookups by id |
| UNIQUE (tenant_id, code) | `GET /v1/uploads/{code}` |
| (tenant_id, created_at desc, id desc) | `GET /v1/uploads` default order + cursor `(created_at,id) < ($c)` |
| (tenant_id, status, created_at desc, id desc) | `GET /v1/uploads?status=` |
| (tenant_id, uploaded_by, created_at desc, id desc) | `GET /v1/uploads?uploadedBy=` |
| (tenant_id, source_type, created_at desc, id desc) | `GET /v1/uploads?sourceType=` |
| (tenant_id, mode, created_at desc, id desc) | `GET /v1/uploads?mode=` |
| (tenant_id, sha256) WHERE status = 'completed' | duplicate detection at inspection: `WHERE tenant_id=$1 AND sha256=$2 AND status='completed' LIMIT 1` |
| (tenant_id, purge_after) WHERE purge_after IS NOT NULL | retention-purge and delete-processed-files jobs |

### 3.2 `upload_chunks`
| Column | Type | Null | Notes |
|---|---|---|---|
| upload_id | uuid | no | FK → uploads.id |
| chunk_no | int | no | 1-based |
| row_from, row_to | int | no | 1-based data row numbers (header excluded) |
| chunk_file_path | text | no | `intake-uploads/{tenant}/{upload}/chunks/{n}.ndjson` (anonymised if the switch is on) |
| status | text | no | `queued`/`leased`/`done`/`failed` |
| attempts | int | no | default 0 |
| leased_until | timestamptz | yes | lease = visibility timeout (120 s pilot / 330 s paid) |
| rows_accepted, rows_rejected, rows_unchanged, rows_needs_review | int | no | default 0 (report detail) |
| error_code | text | yes | last failure |
| started_at, finished_at | timestamptz | yes | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, upload_id, chunk_no) | chunk idempotency key (ADR-0005); `SELECT … WHERE upload_id=$ AND chunk_no=$ FOR UPDATE` |
| (tenant_id, status, leased_until) WHERE status = 'leased' | concurrency semaphore `SELECT count(*) … WHERE tenant_id=$ AND status='leased' AND leased_until > now()`; reap-chunk-leases job |
| (tenant_id, upload_id, status) | progress (`chunksDone/Failed`) and finalize checks |

### 3.3 `raw_rows` (partitioned by month on `partition_month`)
Raw rows are kept unchanged (US-01 AC5). `partition_month = date_trunc('month', uploads.started_at)` so all rows of an
upload live in one partition and retention drops whole partitions.

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | `rowId` in events and APIs; PK is (id, partition_month) |
| partition_month | date | no | partition key |
| upload_id | uuid | no | FK → uploads.id |
| chunk_no | int | no | |
| batch_no | int | yes | set only when the row is emitted (§4.6) |
| row_no | int | no | data row number in the sheet |
| sheet_name | text | yes | |
| original | jsonb | no | header → cell text exactly as read (after anonymisation when on) -- PII |
| normalised | jsonb | yes | Appendix C target fields after validation/translation (IntakeRow shape) -- PII |
| external_source | text | no | `extractor` (record_id present) or `upload` |
| external_ref | text | no | §4.5 |
| parent_external_ref | text | yes | parent_record_id |
| content_hash | text | no | §4.5 |
| outcome | text | no | `accepted`/`rejected`/`unchanged` |
| needs_review | boolean | no | |
| review_reason_text | text | yes | extractor text, kept verbatim |
| reason_codes | text[] | yes | all derived codes |
| primary_reason_code | text | yes | the one in the event (§4.8) |
| detail_code | text | yes | intake cause (§4.8) |
| record_scope, side, market, segment | text | yes | classification (for review context / filters) |
| deal_types, property_types | text[] | yes | |
| used_model | boolean | no | default false |
| anonymised | boolean | no | |

| Index / constraint | Serves |
|---|---|
| PK (id, partition_month) | row lookup by id (review item detail) |
| UNIQUE (tenant_id, upload_id, row_no, partition_month) | idempotent chunk retry: `INSERT … ON CONFLICT DO NOTHING` |
| (tenant_id, upload_id, batch_no, row_no) WHERE outcome = 'accepted' | `GET /internal/v1/uploads/{id}/rows?batch=` → `WHERE tenant_id=$ AND upload_id=$ AND batch_no=$ AND outcome='accepted' ORDER BY row_no` (≤ 500 rows) |
| (tenant_id, upload_id, outcome, row_no) | finalize: build rejected-rows file `WHERE outcome='rejected' ORDER BY row_no` (streamed with a cursor, 1,000 at a time) |
| (tenant_id, external_source, external_ref, partition_month desc) | lineage / support lookup of the latest raw row for a ref (review context) |

### 3.4 `row_errors`
| Column | Type | Null | Notes |
|---|---|---|---|
| upload_id | uuid | no | |
| row_id | uuid | yes | null for migration_map sheet errors |
| row_no | int | no | |
| sheet_name | text | yes | |
| field | text | no | Appendix C name |
| severity | text | no | `error` (row rejected) / `warning` (value dropped, row loaded) |
| code | text | no | enum in `RowError.code` (contract) |
| value | text | yes | offending value; **null when the field is a PII field** (contact_name, phones, emails, whatsapp_phone, other_contact, raw_text, sender_*, text_variants, crm_notes) |
| message | text | no | "deal_type 'Rent Out' is not in the controlled list" |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, upload_id, row_no, field, code) | idempotent insert on chunk retry |
| (tenant_id, upload_id, row_no, id) | `GET /v1/uploads/{id}/row-errors` in row order + cursor |
| (tenant_id, upload_id, field, code, row_no) | `?field=&code=` filters; per-field rejected-value counts for the report |

### 3.5 `row_fingerprints` (upsert key memory, US-07a)
| Column | Type | Null | Notes |
|---|---|---|---|
| tenant_id | uuid | no | PK part |
| external_source | text | no | PK part |
| external_ref | text | no | PK part |
| content_hash | text | no | last emitted hash |
| last_upload_id | uuid | no | |
| last_row_id | uuid | no | |
| updated_at | timestamptz | no | (no `id`: natural PK; deliberate) |

| Index / constraint | Serves |
|---|---|
| PK (tenant_id, external_source, external_ref) | per chunk: `SELECT external_ref, content_hash … WHERE tenant_id=$ AND external_source=$ AND external_ref = ANY($refs)`; upsert after emission; migration re-key |

### 3.6 `templates`
| Column | Type | Null | Notes |
|---|---|---|---|
| name | text | no | |
| source_type | text | no | |
| source_detail | text | yes | |
| headers | text[] | no | |
| header_fingerprint | text | no | |
| column_map | jsonb | no | |
| constants | jsonb | yes | |
| created_by | uuid | no | |
| deleted_at | timestamptz | yes | soft delete |
| version | int | no | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, lower(name)) WHERE deleted_at IS NULL | 409 template-name-taken |
| (tenant_id, header_fingerprint) WHERE deleted_at IS NULL | inspection: suggest a template; `GET /v1/templates?headerFingerprint=` |
| (tenant_id, lower(name), id) WHERE deleted_at IS NULL | `GET /v1/templates` ordered by name + cursor |
| (tenant_id, source_type, lower(name), id) WHERE deleted_at IS NULL | `GET /v1/templates?sourceType=` |

### 3.7 `review_items`
| Column | Type | Null | Notes |
|---|---|---|---|
| upload_id | uuid | no | |
| row_id | uuid | no | |
| row_no | int | no | |
| external_ref | text | no | |
| reason_code | text | no | `side_defaulted`/`deal_type_missing`/`side_unclear`/`property_type_missing`/`value_not_translatable`/`model_unavailable`/`low_confidence`/`other` (catalogue v0.2) |
| detail_code | text | no | `extractor_flag`, `value_not_translatable`, `model_unavailable`, `low_confidence`, `redaction_uncertain`, `side_missing`, `scope_unclear` |
| review_reason_text | text | yes | extractor text |
| current | jsonb | no | classification as loaded |
| suggested | jsonb | yes | model/rules suggestion |
| context | jsonb | no | locality, city, price/area text, side_evidence, **redacted** raw text -- PII-sensitive (treated as PII) |
| status | text | no | `open`/`resolved`/`skipped` |
| resolution | jsonb | yes | action (`set`/`confirm`/`discard`) + final classification |
| note | text | yes | |
| resolved_by | uuid | yes | |
| resolved_at | timestamptz | yes | |
| vocabulary_version | text | no | pinned version used to validate the resolution |
| version | int | no | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, row_id) | one item per row; `ON CONFLICT DO NOTHING` on chunk retry |
| (tenant_id, status, reason_code, created_at, id) | `GET /v1/review-items?reasonCode=&status=` oldest first + cursor; summary `GROUP BY reason_code WHERE status='open'` (index-only) |
| (tenant_id, upload_id, status, reason_code, created_at, id) | `?uploadId=` list and per-upload summary |
| (tenant_id, status, detail_code, created_at, id) | `?detailCode=` |

### 3.8 `migration_map_entries` (CR-006 Z-5)
| Column | Type | Null | Notes |
|---|---|---|---|
| upload_id | uuid | no | |
| entry_no | int | no | sheet row order |
| old_ref | text | no | `old_ad_id` (12-hex) |
| new_refs | text[] | no | `new_record_ids` split on `|` or `,` |
| action | text | no | `kept`/`merged`/`split` |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, upload_id, entry_no) | idempotent insert at split; `GET …/migration-map` and internal feed in entry order + cursor |
| (tenant_id, upload_id, action, entry_no) | `?action=` filter and per-action counts |

### 3.9 `vocabulary_cache` and `legacy_terms`
| Table.column | Type | Null | Notes |
|---|---|---|---|
| vocabulary_cache.version | text | no | e.g. `v0.6` |
| vocabulary_cache.checksum | text | no | verified against the event |
| vocabulary_cache.content | jsonb | no | full release (fields, recordScopes, displayLabels) |
| vocabulary_cache.status | text | no | `active`/`superseded` |
| vocabulary_cache.fetched_at | timestamptz | no | |
| legacy_terms.version | text | no | release version |
| legacy_terms.field | text | no | the source field context (`deal_type`, `property_type`, `*`) |
| legacy_terms.term_norm | text | no | lower-case, trimmed, single-spaced term |
| legacy_terms.maps | jsonb | no | target field → value(s), e.g. `{"deal_type":"Sale","market":"Secondary"}` |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, version) on vocabulary_cache | load a pinned version at chunk start |
| UNIQUE (tenant_id) WHERE status = 'active' on vocabulary_cache | active release lookup (start, parse, review) |
| PK (tenant_id, version, field, term_norm) on legacy_terms | translation lookup (loaded once per chunk into memory: `WHERE tenant_id=$ AND version=$`) |

### 3.10 Infrastructure tables
| Table | Columns | Index → query |
|---|---|---|
| `code_sequences` | tenant_id, prefix (`UPL`), next_value bigint | PK (tenant_id, prefix) → `UPDATE … SET next_value = next_value + 1 RETURNING` |
| `idempotency_keys` (per service, R-3) | tenant_id, user_id, route, key, request_hash, status_code, response_body jsonb, expires_at | PK (tenant_id, user_id, route, key) → replay lookup; (expires_at) → expire-idempotency-keys job (technical table, R-4) |
| `outbox` | per conventions §6: id, tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload jsonb, occurred_at, published_at | (occurred_at, id) WHERE published_at IS NULL → relay `… ORDER BY occurred_at LIMIT 5000 FOR UPDATE SKIP LOCKED` (technical table, exempt from tenant-first, R-4); (tenant_id, aggregate_id, aggregate_version) → debugging/replay |
| `processed_events` | per conventions §6: event_id PK, consumer, processed_at | PK → dedupe; (processed_at) → purge after 30 days |

pgmq queues owned by intake: `q_intake` (events from other services: `vocabulary.released.v1`), `q_intake_inspect`,
`q_intake_split`, `q_intake_chunks`, `q_intake_finalize`, each with `_dlq`.

---

## 4. Business rules and algorithms

### 4.1 Upload lifecycle
```
awaiting_file → (POST /inspect) inspecting → awaiting_mapping (mapping mode)
                                            → ready (strict mode)
                                            → awaiting_duplicate_confirmation (identical sha256 already completed)
ready → (POST /start) queued → processing (split done, upload.started.v1) → completed (upload.completed.v1)
                                                                          → failed (upload.failed.v1)
any state before completed → (POST /cancel) cancelled (upload.failed.v1 reason cancelled, only if processing had started)
```
- `POST /v1/uploads`: validates extension/MIME/size; applies pilot policy (§4.9); issues `UPL-` code; returns a single-use signed
  PUT URL (15 min). The file goes **browser → Storage** directly (ADR-0005).
- `POST /inspect` checks the object exists and its size equals `sizeBytes` (else 409 `file-missing` / `file-size-mismatch`),
  then queues `q_intake_inspect`. Inspection streams the file once: sha256, sheet list, header row of the load sheet,
  row-count estimate, `migration_map` / `run_log` sheet detection, mode detection (§4.2), suggested mapping, duplicate check.
- Limits: > 150,000 data rows (pilot: > 20,000, CR-005) → `failed`, reason `too_many_rows`, detected at inspection.

### 4.2 Strict vs mapping mode (D-15)
1. Normalise each header: trim, lower-case, spaces and hyphens → `_`.
2. Load sheet = `Leads` if present, else the first sheet (user may change `sheetName` before start).
3. **Strict** iff the normalised header set **equals** the 89 Appendix C column names (order ignored). Sheets `run_log`
   (ignored) and `migration_map` (applied first, §4.10) are recognised in both modes.
4. Otherwise **mapping**: `suggestedMapping` = template whose `header_fingerprint` matches (exact) → else per header:
   exact Appendix C name → synonym table (e.g. `mobile`→`phones`, `rent`→`rent_monthly_inr_min`, `lead id`→`external_id`,
   `campaign`→`campaign_ref`) → null. A file with a subset of the 89 names is mapping mode with an identity suggestion.
5. `PUT /mapping` rules: each target used at most once (except `phones`, `emails`, `free_text` which concatenate); either
   `record_scope` is mapped/constant or at least one of `raw_text`/`free_text`/`deal_type`/`property_type` is mapped so the
   classifier has input; Digi uploads must map one of `campaign_ref`/`form_ref`/`listing_ref`/`project_ref` when the header has
   a candidate column (US-01 AC2). Violations → 400 `mapping-invalid` with `errors[]`.

### 4.3 Chunking, concurrency and completion (ADR-0005)
- **Split job** (`q_intake_split`): streams the load sheet once and writes NDJSON chunk files of `chunk_size` rows
  (500 pilot / 2,000 paid, env `INTAKE_CHUNK_SIZE`), applying anonymisation (§4.9) while writing. In one transaction it inserts
  `upload_chunks`, `migration_map_entries` (§4.10), re-keys `row_fingerprints` for the migration map, sets
  `status=processing`, `chunk_count`, `rows_read`, and writes `upload.started.v1` to the outbox; then enqueues one
  `q_intake_chunks` message per chunk. If the upload is anonymised the source file is deleted right after the split.
- **Chunk worker** (`POST /internal/v1/drain/q_intake_chunks`, one chunk per invocation):
  1. Lease: `UPDATE upload_chunks SET status='leased', leased_until=now()+vt, attempts=attempts+1 WHERE … AND (status='queued' OR (status='leased' AND leased_until<now()))`.
     Semaphore: if the tenant already has `CHUNK_CONCURRENCY` live leases the message is left for later.
     `CHUNK_CONCURRENCY = min(20, intake pool cap)`: 5 (pilot), 12 (Small), 16 (Medium) (R-22).
  2. Read the chunk file; per row: parse → validate (§4.4) → translate (mapping mode) → rules classify → collect leftovers.
  3. Leftovers → redact → model in batches of 20 rows (§4.8, ADR-0004).
  4. Derive reason codes, external refs and content hashes (§4.5, §4.8); look up fingerprints for the chunk.
  5. **One write transaction** (DB connection held only here, ~0.2–0.5 s): insert raw_rows / row_errors / review_items
     (`ON CONFLICT DO NOTHING`), upsert fingerprints of emitted rows, write `rows.classified.v1` outbox rows (§4.6) and one
     `review_item.created.v1` per newly inserted review item,
     increment upload counters, mark the chunk `done`, `chunks_done += 1`. If `chunks_done + chunks_failed = chunk_count`,
     enqueue `q_intake_finalize` in the same transaction.
  6. Re-poke the drain via `pg_net` if chunks remain queued (self-chaining; pg_cron is the every-minute safety net).
- Retries: a failed transaction rolls back completely; the message reappears after the visibility timeout. After 5 attempts
  the chunk is `failed` (moved to `q_intake_chunks_dlq`, alarm) and counted in `chunks_failed`.
- **Finalize** (`q_intake_finalize`): if any chunk failed → `failed` + `upload.failed.v1` (reason `chunk_failed`); batches
  already emitted stay applied (safe because re-upload is idempotent). Else builds the rejected-rows CSV (original cells + an
  `error` column) when `rows_rejected > 0`, deletes chunk files, sets `completed` and emits `upload.completed.v1` with counts and
  `rejectionReasons` (row error code → count, from `row_errors` where severity = error).

### 4.4 Validation (strict mode; mapping mode differences in §4.7)
Per row, on the pinned vocabulary release:
| Check | Strict mode outcome |
|---|---|
| Type: booleans (`TRUE/FALSE/true/false/1/0`), integers, numbers, dates (ISO or Excel serial), `possession_date` = `YYYY`/`YYYY-MM`/`YYYY-MM-DD` | error `invalid-type` / `invalid-date` → row rejected |
| `record_id` present and 12-hex | error `required-missing` / `invalid-type` |
| Same `record_id` twice in one file | second occurrence rejected, `duplicate-external-ref` |
| Controlled fields (record_scope, deal_type [pipe list], market, segment, property_type [pipe list], land_use, side, sale_mode, tenancy_status, tenure, agreement_form, possession_status, furnishing, sector, includes_property, participant_role, signal_type, land_area_unit, sale_rate_unit, party_type, source_channel, route_to, area_basis) | value compared after trimming and case-folding (R-11) and stored in the canonical BRD spelling; not in list → error `value-not-in-list` (message names field and value, BRD §4.7) |
| deal_type allowed for record_scope (BRD §4.2 table) | error `scope-deal-type-mismatch` |
| property_type belongs to segment; segment only on Property | error `segment-property-type-mismatch` |
| market present but deal_type has no Sale | error `market-on-non-sale` |
| side = None only for Market Participant / Market Signal; Supply/Demand only for the other scopes | error `side-scope-mismatch` |
| Blank side on Property/Business/Capital/Equipment | row **loaded** with needs_review = true, detail `side_missing` (BRD §4.2: blank side requires needs_review) |
| `_min` > `_max` (bhk, area, sale price, rent) | error `range-inverted` → row rejected (R-11) |
| Phone not parseable to E.164 (+91 default) | warning `invalid-phone`: value moved to `other_contact`, row loaded |
| Blank / placeholder text ("Unknown", "NA" outside land_use, "-") in non-controlled fields | stored as null (blank = unknown) |
| `lead_status`, `follow_up_date`, `crm_notes` | ignored (CR-006 Z-8); `crm_notes` kept only when `import_crm_notes` |
| needs_review = TRUE | row loaded **and** a review item created (BRD §4.7: review never blocks routing) |

### 4.5 External reference and content hash (idempotent upsert)
- `external_source='extractor'`, `external_ref=record_id` when `record_id` is present (strict mode, or mapped).
- Mapping mode without `record_id`: if `external_id` is mapped → `external_source='upload'`,
  `external_ref = <templateId or sourceType:sourceDetail slug> + ':' + external_id`; else `external_ref = 'h:' + first 24 hex of
  sha256(canonical normalised row)` (a repeat of an identical row is then naturally `unchanged`).
- `content_hash` = sha256 of canonical JSON (sorted keys, normalised values) of the normalised row **excluding** row_no,
  sheet_name, `lead_status`, `follow_up_date`, `crm_notes`. Anonymised values are deterministic, so hashes are stable.
- Per chunk: fingerprint found with the same hash and `reprocess_unchanged=false` → outcome `unchanged` (counted, not emitted).
  Otherwise `accepted`, emitted, fingerprint upserted in the same transaction as the outbox row.
- intake never deletes anything because a ref is missing from a later file (US-07a AC3).

### 4.6 Batch numbering and `rows.classified.v1`
- `batchesPerChunk = ceil(chunk_size / 500)`; accepted rows of a chunk, in row order, are cut into groups of ≤ 500;
  group k (1-based) gets `batch_no = (chunk_no − 1) × batchesPerChunk + k`. Deterministic, so a retried chunk produces the
  same batch numbers. Numbers can have gaps (a chunk with few accepted rows); consumers must not assume continuity.
- One outbox row per batch: `aggregateType='upload_batch'`, `aggregateId = UUIDv5(uploadId, batch_no)`, `aggregateVersion=1`
  (each batch is its own aggregate, so the per-aggregate "ignore older versions" rule never drops a late batch). Payload per contract:
  classification, needsReview, reviewReasonCode, repeat fields, source fields, `contentHash`, **no PII**.
- `migrationApplied` = true on **every** batch of an upload whose workbook had a `migration_map` sheet. Meaning (defined here,
  see §10 G-I4): "records must apply this upload's migration map before any of its rows".
- records pulls the full rows (PII, raw text) with `GET /internal/v1/uploads/{uploadId}/rows?batch=`, using a service token
  minted by web (`POST /internal/v1/service-tokens`, `aud=intake`, `sub=records`) and verified by intake against web's JWKS
  (`/.well-known/jwks.json`, cached 10 min) (R-2).

### 4.7 Mapping mode: translation and classification
1. Apply `column_map` and `constants`; concatenate multi-mapped `phones`/`emails`/`free_text`.
2. Types as §4.4 but **never reject for vocabulary**: unparsable number/date → null + warning.
3. Legacy-term translation per classification field using `legacy_terms` of the pinned release (BRD §4.2 "absorbs" and §16):
   e.g. `Resale` → deal_type Sale + market Secondary; `Rent Out`/`Leave and License` → Lease; `Buy`/`Purchase` → Sale + side
   Demand; `JD`/`Redevelopment` → JV; `Pagri` → Pagdi; `Pre-leased` → tenancy_status Tenanted; `Auction` (as type) →
   sale_mode Auction; `Builder` → party_type Developer; `Sale/Lease` → Sale|Lease; `2BHK Flat` → property_type Apartment +
   bhk 2; `1 RK` → Studio + bhk 0.5 (D-17); `Unknown` → null.
4. Anything still out of list → field null, needs_review, reason and detail `value_not_translatable` (D-15).
5. Rules classifier for blank classification fields using `raw_text`/`free_text`: side phrases ("required", "wanted",
   "looking for" → Demand, with the phrase as side_evidence; "available", "for sale", "on rent" → Supply); scope cues
   (running business, loan book, machinery, broker services, tender/notice); BHK, area (sq ft/sq m/sq yd/acre/gunta/bigha →
   sq ft), price (L/lakh/Cr/crore/k) extractors. Side is inferred last (BRD order).
6. Leftovers (scope, deal_type or side still blank and text present) → model (§4.8). Nothing is rejected in mapping mode except
   empty rows and `duplicate-external-ref`.

### 4.8 Redaction, model use and reason codes
- **Redaction before any AI call** (ADR-0004, `libs/redaction`): Indian phone numbers (with +91/0 prefixes, spaces, dashes),
  emails, URLs, names adjacent to contact phrases ("contact", "call", "Mr/Mrs/Ms"), unit/wing/flat numbers → placeholders
  `[PHONE_1]`, `[EMAIL_1]`, `[NAME_1]`, `[UNIT_1]`. A post-check refuses to send text still containing a run of ≥ 7 digits or an
  `@`; such rows get needs_review detail `redaction_uncertain`.
- Model call: batches of 20 redacted rows, JSON output schema limited to classification fields; 2 s timeout, no retry, circuit
  breaker per endpoint; concurrency cap 5 (pilot) / 20 (paid). Output validated against the vocabulary; invalid values dropped.
  Confidence < 0.70 → needs_review `low_confidence`. Model unavailable (breaker open, credits exhausted, timeout) →
  needs_review `model_unavailable`; processing continues.
- **Reason code derivation** (US-07a AC5, CR-006 Z-6). Split the extractor `review_reason` on `;`, lower-case, and match:
  `side defaulted` → `side_defaulted`; `deal type not stated|deal type missing` → `deal_type_missing`; `side unclear` →
  `side_unclear`; `property type not stated|property type missing` → `property_type_missing`; anything else → `other`.
  Intake-side causes (catalogue v0.2 codes): `side_missing` → `side_unclear`; a nulled deal_type → `deal_type_missing`; a nulled
  property_type → `property_type_missing`; untranslatable value → `value_not_translatable`; model skipped → `model_unavailable`;
  confidence < 0.70 → `low_confidence`; `redaction_uncertain`/`scope_unclear` → `other` (detail kept in `detail_code`).
  **Primary code** (the one in the event and on the review item) is the first present in priority order `side_unclear` >
  `deal_type_missing` > `property_type_missing` > `value_not_translatable` > `low_confidence` > `model_unavailable` >
  `side_defaulted` > `other`.
- A row with needs_review gets exactly one review item (unique on row_id).

### 4.9 Anonymise switch (pilot only, CR-006 Z-9)
- `TenantPolicy.pilotMode` (env `INTAKE_PILOT_MODE=true` until the paid-plan gate): `anonymise` defaults to true and cannot
  be turned off (409 `anonymise-required`). After the gate the switch is available per upload and defaults to false.
- Applied **at split**, so no un-anonymised cell is written anywhere except the original file (deleted immediately after the split).
- Consistent fake values from `HMAC-SHA256(tenant anonymisation key, kind + normalised value)`:
  phone → `+9100000` + 6 digits (never a valid Indian mobile), name → fixed list of first × last names indexed by the HMAC,
  email → `u<10 hex>@example.invalid`, other_contact → `contact-<8 hex>`. The same input gives the same fake in every upload, so
  records' phone-based person dedup keeps working.
- Free-text fields (raw_text, text_variants, side_evidence, business_description, extractor_notes, location_text, landmark,
  sender_name/phone) are passed through the redaction detectors, and each detected contact is replaced by its consistent fake.
  company_name, rera_number and all non-contact columns are kept.

### 4.10 `migration_map` handling (CR-006 Z-5)
- Parsed at split: columns `old_ad_id`, `new_record_ids`, `action` (`kept`/`merged`/`split`). Invalid entries → `row_errors`
  (sheet `migration_map`, code `migration-entry-invalid`) and skipped.
- intake re-keys its own `row_fingerprints` in the split transaction: `kept` → rename old→new (so an unchanged row stays
  `unchanged`); `merged`/`split` → delete the old fingerprint.
- Applying the map to records (re-key, reversible merge, re-point to split children) is **records' job**; intake exposes the
  entries (`GET /internal/v1/uploads/{id}/migration-map`) and flags batches (`migrationApplied`).

### 4.11 Review resolution
- `set` validates the classification against the upload's pinned release (scope → deal_type list, segment → property_type,
  market only with Sale, side vs scope) → 400 `classification-invalid`; `confirm` accepts `current`; `discard` says the row is not
  a real record (records voids what it created: `offer.voided.v1`/`demand.voided.v1`, reason `duplicate_discarded`). All three mark
  `resolved`, store `resolution`, and emit `review_item.resolved.v1` with `uploadId`, `action` and the **final** classification
  (current merged with the set fields).
  `skip` marks `skipped` (still listed with `status=skipped`), no event. Resolving a closed item → 409 `review-item-closed`.
- Bulk resolve (≤ 100) runs one transaction per item so one failure does not block the others; one event per resolved item.
- raw_rows are never modified by review (US-01 AC5).

### 4.12 Free-text parse (`POST /v1/parse`)
Rules first (§4.7 step 5 + phone/email extraction). Only if scope/deal_type/side are still unknown is the text redacted and sent
to the model (§4.8). Contacts found by rules are returned to the caller (it is the caller's own text) and never stored or
logged; the request body is excluded from logs and traces. Result is a suggestion only; records validates on create.

### 4.13 Vocabulary release handling
Consumer of `vocabulary.released.v1` (§5.2). Uploads pin the active version at start; review resolution and parse use the
pinned/active version respectively. Releases are kept 90 days after being superseded so in-flight uploads can finish.

---

## 5. Events

Envelope, transport and dedupe per conventions §5. Every produced event is written to `outbox` in the same transaction as the
state change.

### 5.1 Produced
| Event | Trigger (transaction) | aggregate (type/id/version) | Notes |
|---|---|---|---|
| `upload.started.v1` | split job commits chunk plan | upload / uploadId / 1 | data: uploadId, code, mode, sourceType, sourceDetail, rowCount, anonymised, uploadedBy (required) |
| `rows.classified.v1` | each chunk transaction, one per ≤ 500 accepted rows | upload_batch / UUIDv5(uploadId, batch_no) / 1 | data per contract; no PII; `migrationApplied` per §4.6 |
| `upload.completed.v1` | finalize commits `completed` | upload / uploadId / 2 | counts (read, accepted, rejected, needsReview, unchanged), rejectionReasons (code → count), sourceType, sourceDetail, uploadedBy (required) |
| `upload.failed.v1` | finalize with failed chunks, inspection/split failure (`too_many_rows`, `unreadable_file`), or cancel after start | upload / uploadId / 2 | reason: `chunk_failed`, `too_many_rows`, `unreadable_file`, `cancelled`; uploadedBy (required) |
| `review_item.created.v1` | chunk transaction, one per new review item | review_item / reviewItemId / 1 | reviewItemId, uploadId, rowId, reasonCode (primary) |
| `review_item.resolved.v1` | resolve / bulk-resolve with `set`, `confirm` or `discard` | review_item / reviewItemId / item version | reviewItemId, uploadId, rowId, externalRef, action, final classification, resolvedBy |
| `audit.recorded.v1` | rejected-rows link minted | audit / new UUIDv7 / 1 | action `rejected_rows_downloaded`, details: rowCount (no values) |

The upload aggregate has only two versions (1 = started, 2 = completed/failed); batches are separate aggregates. A consumer that
sees `upload.completed.v1` before `upload.started.v1` keeps the completed state (version 2 wins).

### 5.2 Consumed
| Event | Queue | Handling | Idempotency | Out-of-order |
|---|---|---|---|---|
| `vocabulary.released.v1` (records) | `q_intake` | Fetch `GET records /v1/vocabulary?version=` (service token from web, R-2), verify `checksum`, insert `vocabulary_cache` + `legacy_terms`, mark active and supersede the previous in one transaction; bump the in-memory cache | `processed_events` on eventId; `UNIQUE (tenant_id, version)` makes a replay a no-op | Activate only if the version is newer than the active one (semantic compare); an older release is stored as `superseded` |

If records is unreachable the message is retried with backoff (5 attempts → DLQ + alarm); uploads keep using the previous
active release meanwhile.

---

## 6. Error codes (service-specific; common codes per conventions §4)

| Code | HTTP | When |
|---|---|---|
| `payload-too-large` | 413 | sizeBytes > 50 MB; parse text > 2,000 chars is `validation-failed` |
| `unsupported-media-type` | 415 | not csv/xls/xlsx, or content does not match the declared type at inspection |
| `anonymise-required` | 409 | pilot mode and anonymise=false (create or patch) |
| `upload-not-editable` | 409 | PATCH after start |
| `file-missing` | 409 | /inspect before the object is in storage |
| `file-size-mismatch` | 409 | stored object size ≠ sizeBytes |
| `mapping-not-allowed` | 409 | PUT mapping on a strict-mode upload |
| `mapping-invalid` | 400 | unknown/duplicate target, required inputs not mapped (§4.2) |
| `sheet-not-found` | 400 | sheetName not in the workbook |
| `upload-not-ready` | 409 | start before inspection/mapping, or already started |
| `duplicate-upload` | 409 | identical sha256 already completed and allowDuplicate is false |
| `upload-not-cancellable` | 409 | cancel on completed/failed/cancelled |
| `rejected-file-not-ready` | 409 | rejected-rows link requested before finalize |
| `vocabulary-unavailable` | 503 | no active release cached (start, parse) |
| `template-name-taken` | 409 | duplicate template name |
| `review-item-closed` | 409 | resolving a resolved/skipped item |
| `classification-invalid` | 400 | resolution violates the vocabulary or cross-field rules (`errors[]` per field) |
| `batch-not-found` | 404 | internal rows fetch for a batch that was not emitted or was purged |
| `rate-limited` | 429 | > 5 uploads/hour per user; > 30 parse calls/min |

Row-level codes (not HTTP) are the `RowError.code` enum: `value-not-in-list`, `invalid-type`, `invalid-date`,
`required-missing`, `range-inverted`, `invalid-phone`, `scope-deal-type-mismatch`, `segment-property-type-mismatch`,
`market-on-non-sale`, `side-scope-mismatch`, `duplicate-external-ref`, `migration-entry-invalid`, `parse-error`.

---

## 7. PII fields and retention

| Where | PII | Protection | Retention |
|---|---|---|---|
| Storage `intake-uploads/…/source` | whole file | private bucket, signed URLs (15 min) | deleted right after split when anonymised; otherwise 30 days after completion (delete-processed-files) |
| Storage chunk files | cells | private | deleted at finalize |
| Storage `intake-rejected/…csv` | original cells of rejected rows | signed link 15 min, audit event per link | 7 days |
| `raw_rows.original`, `raw_rows.normalised` | contact_name, phones, whatsapp_phone, emails, other_contact, raw_text, text_variants, sender_name, sender_phone, crm_notes, enquiry_message | never logged; only served on the internal route (service token, `no-store`) | **24 months after upload completion**, **30 days** in the pilot (R-15); partition drop |
| `review_items.context` | redacted text (may still hold a name) | treated as PII | purged with the upload's raw rows |
| `row_errors.value` | never stored for PII fields | — | with raw rows |
| `/v1/parse` request/response | typed text, extracted contacts | never stored, never logged | none |
| logs, traces, events | none | allow-list logger; events carry no PII (conventions §5) | — |

Retention follows R-15. records holds the long-lived copies (source ads, people) and applies NFR-18 itself.

---

## 8. Performance notes

| Path | Budget | How it is met |
|---|---|---|
| Sync CRUD / list routes | NFR-2 p95 < 300 ms; server budget 2 s | single-table index lookups (§3), keyset pagination (limit ≤ 100), no counts; DB time ≤ 20 ms |
| `POST /v1/uploads` | < 300 ms | one insert + one Storage signed-URL call (1 s timeout, breaker) |
| `POST /inspect`, `/start` | < 150 ms | only enqueue; heavy work in queue workers |
| `POST /v1/parse` | p95 < 300 ms when rules suffice (expected ~90%), < 2.5 s with the model; server budget 4,000 ms (approved exception R-5) | model capped at 2 s, breaker falls back to rules-only |
| `GET /internal/v1/uploads/{id}/rows` | < 300 ms | one partial-index range scan, ≤ 500 rows (~1–1.5 MB JSON) |
| Chunk processing | pilot 500 rows ≈ 7 s; paid 2,000 rows ≈ 22 s (capacity plan §3) | parse+rules ~5 ms/row, model only for ~5% of rows, one multi-row insert transaction per chunk |
| Upload end-to-end | M2: 100k rows ≤ 30 min | 50 chunks / 12 workers (Small) ≈ 5 waves × 22 s ≈ 110 s intake time; pilot 20k rows / 5 workers ≈ 56 s |

- **Chunk concurrency (R-22):** `min(20, intake pool cap)` live leases per tenant: 5 (pilot), 12 (Small), 16 (Medium), enforced
  by the lease semaphore (§4.3). With one connection per worker this never exceeds the `intake_svc` pool cap. Model concurrency
  is capped separately (5 pilot / 20 paid).
- Pool: `intake_svc` 5 (pilot) / 12 (Small) / 16 (Medium). Sync routes use ≤ 1 connection for ≤ 20 ms.
- Statement timeout 2 s on sync routes, 30 s on worker transactions.

---

## 9. Endpoint summary

Auth: staff = `staffViaWeb`, service = `serviceToken`, cron = `cronSecret`. Roles: Adm = Admin, Mgr = Manager, Dem = Demand
agent, Sup = Supply agent, Op = Data operator. Full details (schemas, errors, descriptions) are in `contracts/openapi/intake.yaml`.

| Method | Path | Auth | Roles | Idempotency | Paginated | Rate limit | Timeout | Emits |
|---|---|---|---|---|---|---|---|---|
| POST | `/v1/uploads` | staff | all | Idempotency-Key | — | 5/h user | 2 s | — |
| GET | `/v1/uploads` | staff | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/uploads/{idOrCode}` | staff | all | safe | — | 20/s user | 2 s | — |
| PATCH | `/v1/uploads/{idOrCode}` | staff | all | If-Match | — | 20/s user | 2 s | — |
| POST | `/v1/uploads/{idOrCode}/inspect` | staff | all | Idempotency-Key | — | 20/s user | 2 s | — |
| PUT | `/v1/uploads/{idOrCode}/mapping` | staff | all | PUT (+If-Match) | — | 20/s user | 2 s | — |
| POST | `/v1/uploads/{idOrCode}/start` | staff | all | Idempotency-Key | — | 20/s user | 2 s | `upload.started.v1`, `rows.classified.v1`, `review_item.created.v1`, `upload.completed.v1`, `upload.failed.v1` |
| POST | `/v1/uploads/{idOrCode}/cancel` | staff | all | Idempotency-Key | — | 20/s user | 2 s | `upload.failed.v1` |
| GET | `/v1/uploads/{idOrCode}/progress` | staff | all | safe | — | 20/s user | 2 s | — |
| GET | `/v1/uploads/{idOrCode}/row-errors` | staff | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/uploads/{idOrCode}/rejected-rows` | staff | all | safe | — | 20/s user | 2 s | `audit.recorded.v1` |
| GET | `/v1/uploads/{idOrCode}/migration-map` | staff | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/templates` | staff | all | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/templates` | staff | all | Idempotency-Key | — | 20/s user | 2 s | — |
| GET | `/v1/templates/{id}` | staff | all | safe | — | 20/s user | 2 s | — |
| PUT | `/v1/templates/{id}` | staff | all | PUT (+If-Match) | — | 20/s user | 2 s | — |
| DELETE | `/v1/templates/{id}` | staff | Adm, Mgr, Op | natural | — | 20/s user | 2 s | — |
| GET | `/v1/review-items` | staff | Adm, Mgr, Op | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/review-items/summary` | staff | Adm, Mgr, Op | safe | — | 20/s user | 2 s | — |
| GET | `/v1/review-items/{id}` | staff | Adm, Mgr, Op | safe | — | 20/s user | 2 s | — |
| POST | `/v1/review-items/{id}/resolve` | staff | Adm, Mgr, Op | Idempotency-Key | — | 20/s user | 2 s | `review_item.resolved.v1` |
| POST | `/v1/review-items/bulk-resolve` | staff | Adm, Mgr, Op | Idempotency-Key | — | 20/s user | 2 s | `review_item.resolved.v1` |
| POST | `/v1/parse` | staff | Adm, Mgr, Dem, Sup | read-only POST | — | 30 req/min per user | 4 s | — |
| GET | `/internal/v1/uploads/{uploadId}/rows` | service | — | safe | — | records drainers | 2 s | — |
| GET | `/internal/v1/uploads/{uploadId}/migration-map` | service | — | safe | yes | records drainers | 2 s | — |
| POST | `/internal/v1/relay` | cron | — | natural (see spec) | — | cron | 60 s | — |
| POST | `/internal/v1/drain/{queue}` | cron | — | natural (see spec) | — | cron | 60 s | — |
| POST | `/internal/v1/jobs/{name}` | cron | — | natural (see spec) | — | cron | 60 s | — |
| GET | `/health/live` | none | — | safe | — | none | 2 s | — |
| GET | `/health/ready` | none | — | safe | — | none | 2 s | — |

Row-level ownership re-checks: PATCH/cancel an upload and the rejected-rows link are allowed to the uploader, Admin and Manager
(and Data operator for the link); everything else follows the role column.

---

## 10. Contract gaps and open questions

`events.yaml` (v0.2), `_common.yaml` and `conventions.md` were not edited. Closed since v0.1: G-I1 (reason codes, v0.2),
G-I2/G-I3 (`uploadId`, `action` incl. `discard`), G-I5 (R-2 service tokens), G-I6 (R-5), G-I7 (R-15), G-I8 (R-22), G-I9
(`sourceDetail` on upload events), G-I10 (R-4), Q-I2 (R-11).

| # | Still open | Assumption used in this LLD | Proposed fix |
|---|---|---|---|
| G-I4 | `rows.classified.v1.migrationApplied` has no documented meaning in the catalogue | §4.6: "this upload carries a migration map that records must apply before its rows"; set on every batch | document the meaning in `gen_events.py` (or rename to `hasMigrationMap` in a v2) |
| G-I11 | `review_item.created.v1` has no `detailCode`; insight can only group by the primary reason code | fine for the C-05 groups | additive `detailCode` if dashboards need it |
| Q-I1 | Strict mode = normalised header set **equal** to the 89 names; any missing or extra column → mapping mode with an identity suggestion | as stated | confirm with Vinit |
| Q-I3 | Mapping-mode targets beyond Appendix C (`external_id`, `campaign_ref`, `form_ref`, `listing_ref`, `project_ref`, `enquiry_message`, `enquiry_received_at`, `photo_urls`, `free_text`) for Digi exports and broker sheets | added in this contract | confirm; add to PRD Appendix C via a CR if kept |
| Q-I4 | Anonymised phone format `+9100000xxxxxx` (deliberately not a valid Indian number) | as stated | confirm |

## Amendments: CR-011 and CR-012 (approved 2026-09-30)
- Upload schema: optional `building_name`, `floor` (strict mode accepts 89 or 91 columns). Both are stored on raw rows, served in
  `IntakeRow.buildingName/floor`, never public, and redacted (UNIT/NAME) before any AI call. The anonymiser leaves them as they are (not contact data).
- `crm_notes`: stored with the raw row (PII-sensitive), flagged as `IntakeRow.hasCrmNotes`, and served only by
  `GET /internal/v1/uploads/{uploadId}/rows/{rowNo}/note` (x-callers journeys). Purged with raw rows (retention).
