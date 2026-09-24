# 04 — LLD: Shared conventions (all services)

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-09-24 |
| Based on | BRD v0.6.1, PRD v0.6, HLD v0.2 (approved), CLAUDE.md §3 |
| Status | IN PROGRESS (Stage 4) |

Every contract (`contracts/openapi/*.yaml`, `contracts/asyncapi/events.yaml`) and every service LLD (`docs/04-lld/<service>.md`)
follows these rules. Service documents only list their deviations, and there should be none.

## 1. Services and prefixes
| Service | Vercel project | DB schema / role | Public ID prefixes it issues |
|---|---|---|---|
| web (edge BFF) | `web` | `web` / `web_svc` | — (users: UUID) |
| intake | `intake` | `intake` / `intake_svc` | `UPL-` (uploads) |
| records | `records` | `records` / `records_svc` | `PRP-`, `PRJ-`, `INV-`, `DEM-`, `PER-`, `ENQ-`, `BIZ-`, `CAP-`, `EQP-`, `WCH-`, `AD-` (source ad) |
| journeys | `journeys` | `journeys` / `journeys_svc` | `SRQ-`, `PROP-`, `VIS-`, `DEAL-`, `CALL-` |
| crm-engine | `crm-engine` | `crm_engine` / `crm_engine_svc` | `MAT-`, `BND-` (bundle) |
| listings | `listings` | `listings` / `listings_svc` | `L-` (public listing id, opaque) |
| insight | `insight` | `insight` / `insight_svc` | `EXP-` (export), `CONV-` |

## 2. Identifiers
- **Primary key:** `id uuid` (UUIDv7, time-ordered) on every table. It's used in APIs and events.
- **Display code:** `code text` (e.g. `INV-00452`, `DEM-000127`). Issued by the owning service from a per-tenant sequence, unique per
  tenant, and shown in the UI and chat. APIs accept either `id` or `code` in path parameters (`/v1/offers/{idOrCode}`).
- **Extractor IDs:** `record_id` (12-hex) is stored as `external_ref` with `external_source = 'extractor'`. It's unique per tenant
  and used as the upsert key (PRD US-07a).
- **Listings public ID:** opaque, non-guessable, and never the internal id or code (`L-` + 10 base32 characters).

## 3. Tenancy
- Every table has `tenant_id uuid not null`. It's the first column of every index, and every query filters on it.
- The tenant comes from the JWT claim `tid`. Phase 1 has one tenant (11 Estates).
- An automated test per service proves that a request for tenant A can never read or write tenant B (PRD NFR-15).

## 4. HTTP APIs
| Topic | Rule |
|---|---|
| Base path | `/v1/...`, versioned in the path. A breaking change means `/v2`, and both run until clients move. |
| Format | JSON, UTF-8, `camelCase` fields in APIs. The DB uses `snake_case`. Vocabulary **values** use the exact BRD spelling (`"Sale"`, `"Semi Furnished"`). |
| Money | Integer INR (no paise). Field names end in `Inr` (`salePriceInrMin`). |
| Area | Number, sq ft. Field names end in `Sqft`. `areaBasis` = `Carpet` \| `Builtup` \| `Saleable` \| `null`. |
| Dates | ISO 8601. `date` = `YYYY-MM-DD`. `date-time` = UTC with `Z`. Month-precision `possessionDate` is allowed as `YYYY-MM` or `YYYY`. |
| Blank vs unknown | Unknown = field **absent or `null`**. Never `"Unknown"` (BRD §4.2). |
| Auth: staff | `Authorization: Bearer <Supabase JWT>`, validated by web. Web forwards a **service token** (below) plus `X-User-Id`, `X-User-Role`, `X-Tenant-Id`. Services **re-check** role and tenant for their own resources. |
| Auth: service to service | Short-lived JWT (5 min) signed by web's key, with `aud=<service>`, `sub=<caller>`, `tid`. Each service verifies the signature, audience and expiry. This is used only for projection rebuilds and scheduler calls. |
| Auth: scheduler | pg_cron → pg_net calls `POST /internal/v1/{relay,drain/<queue>,jobs/<name>}` with `X-Cron-Secret` (per-service secret). Not exposed through web. |
| Auth: website | `X-Api-Key` (listings public API only). Keys are stored hashed. |
| Correlation | `X-Correlation-Id` is accepted or generated at web and propagated on every hop and into every event (`correlationId`). It's logged on every line. |
| Idempotency | Every mutating `POST` accepts `Idempotency-Key` (UUID, 24 h window, per user and route). A replay returns the original status and body. A same key with a different body → `409 idempotency-key-reused`. `PUT`, `PATCH` and `DELETE` are idempotent by design. `PATCH` bodies are JSON Merge Patch and may carry `If-Match: <version>` (optimistic concurrency via a row `version` → `412` on mismatch). |
| Pagination | Cursor based: `?limit=` (default 25, **max 100**) and `?cursor=` (opaque). Response `{ "items": [...], "nextCursor": "…" \| null }`. Stable sort on `(sortKey, id)`. There are no offset or total counts on large lists. Counts come from dashboards. |
| Filtering | Stored-field filters only (`?dealType=Lease&segment=Commercial`). Labels are never filterable (BRD §4.2). |
| Errors | **RFC 7807** `application/problem+json`: `type` (`https://errors.11estates.in/<code>`), `title`, `status`, `detail`, `code` (stable, kebab-case), `correlationId`, optional `errors[]` (field, code, message) for validation. Codes are listed per service. |
| Common error codes | `validation-failed` (400), `unauthenticated` (401), `forbidden` (403), `not-found` (404), `conflict` (409), `idempotency-key-reused` (409), `version-mismatch` (412), `payload-too-large` (413), `unsupported-media-type` (415), `rate-limited` (429, `Retry-After`), `internal` (500), `dependency-unavailable` (503) |
| Timeouts | Server budget **2 s** for sync endpoints unless stated (CLAUDE.md §3.5). Web → service calls: 2 s timeout, 1 retry on idempotent methods only, exponential backoff with jitter (100–400 ms), and a circuit breaker per downstream (opens at 50% errors over 20 calls, half-open after 30 s). |
| Rate limits | Per user at web: 20 req/s burst 40. Chat: 1 concurrent stream and 30 messages/min. Uploads: 5 per hour per user. Listings public API: 50 req/s burst 100 per key. Limits are enforced at web with a **Postgres token-bucket table** in the `web` schema (no extra vendor). |
| Health | `GET /health/live` (process up) and `GET /health/ready` (DB reachable, migrations at the expected version). No auth; no PII. |

## 5. Events
- **Envelope** (every event):

```json
{
  "eventId": "uuid-v7",
  "eventType": "offer.created.v1",
  "schemaVersion": 1,
  "occurredAt": "2026-09-24T10:15:00Z",
  "correlationId": "…",
  "producer": "records",
  "tenantId": "uuid",
  "aggregateType": "offer",
  "aggregateId": "uuid",
  "aggregateVersion": 7,
  "data": { }
}
```

- **Name:** `<entity>.<past-tense-verb>.v<N>`.
- **Delivery:** at least once. **Ordering:** per aggregate, by `aggregateVersion`. Consumers ignore an event whose
  `aggregateVersion` is ≤ the version they've already applied, and re-read the owner's API if they detect a gap (only for projections).
- **Transport** (ADR-0003): the producer's `outbox` table (same transaction) → relay → one pgmq queue per consumer
  (`q_<consumer>`) → consumer drain → `processed_events(event_id)` dedupe → after 5 failures, `q_<consumer>_dlq` + an alarm.
- **Payload rules:** events carry **IDs, codes and business fields needed by consumers. They never carry contact PII**
  (names, phones, emails, raw text). A consumer that needs PII calls the owner's API. Schema changes are **additive only**.
- **Batching:** `rows.classified.v1` carries ≤ 500 rows. All other events carry one aggregate.

## 6. Database
- Postgres 15+ (Supabase). One schema and one login role per service (ADR-0006). Grants only on the service's own schema,
  plus `pgmq` queue functions for its own queues. PostgREST is disabled for service schemas.
- Every table has `id uuid pk`, `tenant_id uuid not null`, `created_at timestamptz`, `updated_at timestamptz`, and
  `version int` (optimistic concurrency) on mutable aggregates.
- Every service has an `outbox` (id, tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload jsonb,
  occurred_at, published_at null) and a `processed_events` (event_id pk, consumer, processed_at) table.
- Migrations live in `services/<svc>/migrations`, are forward-only, and follow expand → migrate → contract. Never rename or
  drop in one deploy.
- **Every query path has an index.** Each LLD lists every index with the query it serves. There are no unbounded queries;
  every list is paginated or capped.
- **PII columns** are marked `-- PII` in the schema and listed per LLD. They're never logged. Where a column is searched
  by value, a salted-hash lookup column is used (e.g. `phone_hash`) so lookups don't need a full scan of plaintext.
- Connection: through the **Supavisor pooler** (transaction mode). Per-role pool caps come from the capacity plan.

## 7. Observability
- Structured JSON logs: `ts`, `level`, `service`, `correlationId`, `tenantId`, `userId`, `route`, `status`, `durationMs`,
  `eventType` (consumers). **No PII**: loggers use an allow-list of fields.
- Tracing: OpenTelemetry. Spans cross HTTP and events (trace context in the event envelope `traceparent`, an optional field).
- RED metrics per route and per consumer. Alarms: 5xx rate > 2% over 5 min, p95 above target over 10 min, DLQ depth > 0,
  relay lag > 5 min.

## 8. Controlled vocabulary in code
- records publishes vocabulary releases (`vocabulary.released.v1`, version `v0.6`). Other services cache the release and
  validate enums against it.
- Contracts declare vocabulary fields as `string` with `x-vocabulary: <field>` (not a hard-coded enum), so a release
  doesn't need a contract version change. Values are validated at runtime against the cached release.
- Exceptions (fixed by the contract): `side`, `recordScope`, `publicationLevel`, status-axis stages.

## 9. PII inventory (all services)
| Field | Owned by | Stored as |
|---|---|---|
| contact_name, sender_name | records (intake raw copy) | text, PII |
| phones, whatsapp_phone, sender_phone | records (intake raw copy) | E.164 text, PII, + `phone_hash` |
| emails | records (intake raw copy) | text, PII, + `email_hash` |
| other_contact | records (intake raw copy) | text, PII |
| raw_text, text_variants | intake (raw rows), records (source ad) | text, PII (may contain contacts) |
| unit / wing / exact floor | records | text, PII-sensitive (never public) |
| building name | records | text, not public (proposals only) |
| staff name, email | web | text, PII |

Retention: personal data is purged 24 months after the last activity on all linked records (PRD NFR-18). Raw rows follow the
same rule. Audit entries are kept ≥ 1 year.

## 10. Reconciliation decisions (after the first LLD drafts, 2026-09-24)
These override anything in a service LLD that disagrees. The events catalogue is v0.2 (`contracts/asyncapi/events.yaml`).

| # | Decision |
|---|---|
| R-1 | **Listings public API rate limits are enforced by listings itself** (the website calls listings directly). web enforces staff limits only. |
| R-2 | **Service tokens:** web is the issuer. It mints tokens at `POST /internal/v1/service-tokens` (the caller authenticates with its own client secret from Vercel env) and publishes keys at `GET /.well-known/jwks.json`. All services verify against that JWKS (cached 10 min). This covers records → intake row fetch, the vocabulary fetch from records, and projection rebuilds. |
| R-3 | **Idempotency keys are stored per service** (`idempotency_keys` table in each schema). web passes `Idempotency-Key` through unchanged. |
| R-4 | **Technical tables** (`outbox`, `processed_events`, `idempotency_keys`) are exempt from "tenant_id first in every index". Their scan indexes lead with `published_at` / `event_id`. Business tables follow the rule. |
| R-5 | **Timeout exceptions** must be declared in `x-timeout-ms` with a reason. Approved: intake `POST /v1/parse` 4,000 ms; insight chat stream (first token 3 s, total 15 s); export and PDF creation are async (202). |
| R-6 | **Notifications:** web owns upload, export and user notifications (from `upload.*`, `export.*`, `user.changed`). journeys owns work notifications (matches, SRQs, handoffs, follow-ups). The UI merges both lists. |
| R-7 | **System actor:** automatic actions use the reserved user id `00000000-0000-0000-0000-000000000001` (audit, `changedBy`). |
| R-8 | **Photos with detected text are a warning, not a block** (PRD A-17). listings flags them in the publication card and excludes nothing automatically. |
| R-9 | **Unknown city:** treated as inside the launch area when `source_edition` = Mumbai, or the micromarket resolves inside MMR. Otherwise needs_review ("location unclear"). |
| R-10 | **Initial record stage** for extractor or ingested rows is **Enriched** (automatic work, BRD §4.4). Manual quick add starts at **Captured**, or Contacted when entered during a call. |
| R-11 | **Controlled values in strict mode** match after trimming and case-folding, and are stored in canonical spelling. Anything else → row rejected (`value-not-in-list`). Inverted ranges (min > max) → rejected (`range-inverted`). |
| R-12 | **Life curve for multi-deal-type demands** uses the **shortest** thresholds among its deal types. An Inactive offer **can be reactivated** by a "confirmed" call outcome. |
| R-13 | **Adjacent micromarkets** come from an adjacency list in the micromarket reference data (records, Admin-maintained; `micromarkets.updated.v1`). |
| R-14 | **Unknown area basis:** no conversion between bases. Tolerance widens from ±15% to ±25%, and the match carries the flag `area_basis_unknown`. |
| R-15 | **Retention:** proposal snapshots and audit entries are kept for 24 months (audit ≥ 1 year per PRD). Raw rows: 24 months after upload completion (30 days in the pilot). |
| R-16 | **Pilot exports are capped at 20,000 rows** (§8.4). Production cap: 100,000 rows. |
| R-17 | **Chat conversations are private to their author.** Actions taken through chat are audit-logged (`via = chat`). |
| R-18 | **Queue tiles on dashboards** come from `queue.counts_changed.v1` into the insight read model. No synchronous cross-service call. |
| R-19 | **Event names in HLD §2** (`offer.closed.v1`, `offer.upcoming_created.v1`) are superseded by `offer.commercial_status_changed.v1` + `deal.closed.v1` and `lease_renewal.due.v1` → records creates the Upcoming offer. The catalogue is authoritative. |
| R-20 | **Building-name privacy scan:** records exposes `GET /internal/v1/properties/{id}/scan-terms` (serviceToken). It returns salted hashes of the building/society name tokens, wing and unit for listings' scan. listings never stores the plain names. |
| R-21 | **Contacts for exports:** records exposes `POST /internal/v1/contacts:batch` (serviceToken, ≤ 1,000 ids). insight calls it at export time only, and every call is audit-logged. |
| R-22 | **Intake chunk workers:** `min(20, intake pool cap)`: 5 in the pilot, 12 on Small, 16 on Medium (capacity plan updated). |
