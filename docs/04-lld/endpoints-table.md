# Endpoint catalogue (generated from contracts/openapi)

Auth: staff = staffViaWeb (signed-in user via web), svc = serviceToken, cron = X-Cron-Secret, key = website API key, client = X-Client-Secret, token = proposal share token, none = public health.

## Summary

| Service | Operations | Public (API key) | Internal (svc/cron) |
|---|---|---|---|
| web | 17 | 0 | 4 |
| intake | 31 | 0 | 6 |
| records | 69 | 0 | 6 |
| journeys | 60 | 0 | 4 |
| crm-engine | 19 | 0 | 4 |
| listings | 25 | 6 | 3 |
| insight | 20 | 0 | 3 |
| **Total** | **241** | | |

## web (17)

| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/v1/me` | staffSession | all | safe |  | api bucket (20 req/s, burst 40 per user) | 2000 | — | Signed-in user, role, tenant, permissions, session expiry and environment flags (drives the UI) |
| DELETE | `/v1/me/session` | staffSession | all | by design |  | api bucket | 2000 | — | Sign out (revokes the Supabase refresh token, clears cookies, drops cached service tokens) |
| GET | `/v1/me/notifications` | staffSession | all | safe | yes | api bucket | 2000 | — | The caller's upload, export and user notifications (web-owned, R-6); journeys owns /v1/notifications for work notifications |
| POST | `/v1/me/notifications/read` | staffSession | all | Idempotency-Key |  | api bucket | 2000 | — | Mark notifications read (listed ids, or everything up to a time) |
| GET | `/v1/roles` | staffSession | all | safe |  | api bucket | 2000 | — | The five staff roles and their permission codes (PRD §2.3), read-only |
| GET | `/v1/users` | staffSession | all | safe | yes | api bucket | 2000 | — | Users of the tenant (Settings → Users & roles). Non-admins get a directory view (id, name, role, status) for pickers. |
| POST | `/v1/users/invitations` | staffSession | Admin | Idempotency-Key |  | api bucket; plus 20 invitations per hour per tenant | 2000 | user.changed.v1 | Invite a Google account by email with a role (Supabase Auth invite; expires in 7 days) |
| DELETE | `/v1/users/invitations/{userId}` | staffSession | Admin | by design |  | api bucket | 2000 | user.changed.v1 | Revoke a pending invitation (the user row is marked deactivated; the Supabase invite is deleted) |
| PATCH | `/v1/users/{userId}` | staffSession | Admin | If-Match |  | api bucket | 2000 | user.changed.v1 | Change role, data-operator flag, display name, or deactivate / reactivate (JSON Merge Patch) |
| GET | `/v1/audit-log` | staffSession | Admin | safe | yes | api bucket | 2000 | — | Immutable audit log (US-35), newest first; filters on stored fields |
| GET | `/.well-known/jwks.json` | none | service | safe |  | none (CDN cached, max-age=600) | 500 | — | Public keys that verify web-minted service tokens (current + previous during rotation) |
| POST | `/internal/v1/service-tokens` | serviceCredential | service | by design |  | 60 per minute per caller service | 2000 | — | Mint a service-to-service token (aud=<target>, sub=<caller>, tid, 5 min) for projection rebuilds and background jobs |
| POST | `/internal/v1/relay` | cron | scheduler | by design |  | none (scheduler only; single-flight via advisory lock) | 55000 | user.changed.v1 | Publish unpublished outbox rows (user.changed.v1) to consumer queues (pg_cron every minute + poke after commit) |
| POST | `/internal/v1/drain/{queue}` | cron | scheduler | by design |  | none (scheduler only; every minute + poke from producer relays) | 55000 | — | Consume q_web: audit.recorded.v1 → audit_log; upload.completed.v1 / upload.failed.v1 / export.completed.v1 / export.failed.v1 → notifications |
| POST | `/internal/v1/jobs/{name}` | cron | scheduler | by design |  | none (scheduler only; single-flight per job) | 55000 | — | Scheduled jobs |
| GET | `/health/live` | none | anonymous | safe |  | none | 500 | — |  |
| GET | `/health/ready` | none | anonymous | safe |  | none | 1000 | — |  |

## intake (31)

| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |
|---|---|---|---|---|---|---|---|---|---|
| POST | `/v1/uploads` | staff | all | Idempotency-Key |  | 5 uploads/hour per user (conventions §4), plus 20 req/s per user on reads | 2000 | — | Create an upload and get a signed storage URL |
| GET | `/v1/uploads` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | List uploads (newest first) |
| GET | `/v1/uploads/{idOrCode}` | staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get an upload (status, mode, counts, suggested mapping) |
| PATCH | `/v1/uploads/{idOrCode}` | staff | all | If-Match |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Change pre-start options (anonymise switch, source detail, sheet) |
| POST | `/v1/uploads/{idOrCode}/inspect` | staff | all | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Confirm the file is in storage and inspect it asynchronously |
| PUT | `/v1/uploads/{idOrCode}/mapping` | staff | all | by design |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Set the column mapping (mapping mode) and optionally save it as a template |
| POST | `/v1/uploads/{idOrCode}/start` | staff | all | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | upload.started.v1, rows.classified.v1, review_item.created.v1, upload.completed.v1, upload.failed.v1 | Start background processing |
| POST | `/v1/uploads/{idOrCode}/cancel` | staff | all | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | upload.failed.v1 | Cancel an upload that has not completed |
| GET | `/v1/uploads/{idOrCode}/progress` | staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Processing progress per stage |
| GET | `/v1/uploads/{idOrCode}/row-errors` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Row errors (rejected rows) with field, code and non-PII value |
| GET | `/v1/uploads/{idOrCode}/rejected-rows` | staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | audit.recorded.v1 | Signed link to download the rejected rows file (CSV, original values) |
| GET | `/v1/uploads/{idOrCode}/migration-map` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Parsed migration_map sheet (CR-006 Z-5) |
| GET | `/v1/templates` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | List saved mapping templates |
| POST | `/v1/templates` | staff | all | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Create a mapping template |
| GET | `/v1/templates/{id}` | staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a template |
| PUT | `/v1/templates/{id}` | staff | all | by design |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Replace a template |
| DELETE | `/v1/templates/{id}` | staff | Admin, Manager, Data operator | by design |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Delete (soft) a template |
| GET | `/v1/review-items` | staff | Admin, Manager, Data operator | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Classification review queue, filterable by reason code |
| GET | `/v1/review-items/summary` | staff | Admin, Manager, Data operator | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Open review items grouped by reason code (C-05 group headers) |
| GET | `/v1/review-items/{id}` | staff | Admin, Manager, Data operator | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get one review item with redacted context |
| POST | `/v1/review-items/{id}/resolve` | staff | Admin, Manager, Data operator | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | review_item.resolved.v1 | Resolve a review item (set / confirm / skip) |
| POST | `/v1/review-items/bulk-resolve` | staff | Admin, Manager, Data operator | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | review_item.resolved.v1 | Resolve up to 100 review items with one classification (e.g. accept defaulted side) |
| POST | `/v1/parse` | staff | Admin, Manager, Demand agent, Supply agent | by design |  | 30 req/min per user (bounds model spend; conventions §4 default otherwise) | 4000 | — | Parse typed free text into a suggested classification (quick add prefill) |
| GET | `/internal/v1/uploads/{uploadId}/rows` | svc | — | safe |  | records drainers only (≤ 8 concurrent); no user limit | 2000 | — | Rows of one emitted batch, with PII and raw text (records ingestion) |
| GET | `/internal/v1/uploads/{uploadId}/rows/{rowNo}/note` | svc | — | safe |  | journeys drainers only; no user limit | 2000 | — | The crm_notes text of one upload row (journeys note import, CR-012) |
| GET | `/internal/v1/uploads/{uploadId}/migration-map` | svc | — | safe | yes | records drainers only; no user limit | 2000 | — | Migration map entries for records to apply before any batch of this upload |
| POST | `/internal/v1/relay` | cron | — | by design |  | n/a: pg_cron/pg_net only (1 call/min per job plus pokes) | 60000 | — | Relay unpublished outbox rows to consumer pgmq queues |
| POST | `/internal/v1/drain/{queue}` | cron | — | by design |  | n/a: pg_cron/pg_net only (1 call/min per job plus pokes) | 60000 | — | Drain one of this service's pgmq queues |
| POST | `/internal/v1/jobs/{name}` | cron | — | by design |  | n/a: pg_cron/pg_net only (1 call/min per job plus pokes) | 60000 | — | Run a scheduled job |
| GET | `/health/live` | none | — | safe |  | none (health probe) | 2000 | — | Liveness (process up) |
| GET | `/health/ready` | none | — | safe |  | none (health probe) | 2000 | — | Readiness (DB reachable, migrations at expected version) |

## records (69)

| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/v1/offers` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Search offers by stored fields |
| POST | `/v1/offers` | staff | Admin, Manager, Supply agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.created.v1 | Add an offer to an existing property (US-13) |
| GET | `/v1/offers/{idOrCode}` | svc, staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get an offer |
| PATCH | `/v1/offers/{idOrCode}` | staff | Admin, Manager, Supply agent, Demand agent | If-Match |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.updated.v1, offer.price_changed.v1 | Update offer facts (prices, deal tags, units, revenue share, owner) |
| POST | `/v1/offers/{idOrCode}/record-stage` | staff | Admin, Manager, Supply agent, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.record_stage_changed.v1, offer.updated.v1 | Move the offer's Record axis |
| PUT | `/v1/offers/{idOrCode}/photos` | staff | Admin, Manager, Supply agent, Demand agent | by design |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.updated.v1 | Choose which property photos this offer uses (D-5) |
| GET | `/v1/properties` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Search properties by stored fields |
| POST | `/v1/properties` | staff | Admin, Manager, Supply agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.created.v1 | Create a property with 1–4 offers (manual supply entry) |
| POST | `/v1/properties/dedup-check` | staff | Admin, Manager, Supply agent, Demand agent | by design |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Property-level duplicate check without creating anything |
| GET | `/v1/properties/{idOrCode}` | svc, staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a property with its offers and parties |
| PATCH | `/v1/properties/{idOrCode}` | staff | Admin, Manager, Supply agent, Demand agent | If-Match |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.updated.v1 | Update property facts (areas, location, building, unit details) |
| GET | `/v1/properties/{idOrCode}/sightings` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Sightings (raw appearances) of the property and its offers |
| GET | `/v1/properties/{idOrCode}/second-sources` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Other sources advertising the same property, with price gaps |
| GET | `/v1/properties/{idOrCode}/photos` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Photos of a property (signed read URLs) |
| GET | `/v1/second-sources` | staff | Admin, Manager, Data operator, Supply agent | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Price-gap review queue (open second sources with a > 5% gap) |
| POST | `/v1/second-sources/{id}/resolve` | staff | Admin, Manager, Data operator, Supply agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.price_changed.v1, offer.updated.v1 | Accept the second source's price or dismiss the gap |
| GET | `/v1/projects` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Search projects |
| POST | `/v1/projects` | staff | Admin, Manager, Supply agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | project.created.v1 | Create a project (Sale, Primary) |
| GET | `/v1/projects/{idOrCode}` | svc, staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a project with its configuration offers |
| PATCH | `/v1/projects/{idOrCode}` | staff | Admin, Manager, Supply agent | If-Match |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | project.updated.v1, offer.updated.v1 | Update project facts (RERA, possession, amenities) |
| POST | `/v1/projects/{idOrCode}/price-sheets` | staff | Admin, Manager, Supply agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | price_sheet.applied.v1, project.updated.v1, offer.created.v1, offer.updated.v1, offer.price_changed.v1 | Apply a developer price sheet: create/update configuration offers, prices and units (US-17) |
| GET | `/v1/projects/{idOrCode}/price-sheets` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Price sheet history (newest first) |
| GET | `/v1/demands` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Search demands by stored fields |
| POST | `/v1/demands` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | demand.created.v1, demand.touch_added.v1 | Create a demand (full form; quick add uses /v1/quick-add) |
| GET | `/v1/demands/{idOrCode}` | svc, staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a demand |
| PATCH | `/v1/demands/{idOrCode}` | staff | Admin, Manager, Demand agent | If-Match |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | demand.updated.v1 | Update demand facts |
| POST | `/v1/demands/{idOrCode}/record-stage` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | demand.updated.v1 | Move the demand's Record axis |
| GET | `/v1/demands/{idOrCode}/touches` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Touches of a demand (first touch flagged) |
| POST | `/v1/demands/{idOrCode}/touches` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | demand.touch_added.v1 | Record another arrival of the same demand |
| POST | `/v1/demands/{idOrCode}/add-supply` | staff | Admin, Manager, Supply agent, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.created.v1, offer.record_stage_changed.v1 | Add supply found for a demand or SRQ (US-05, C-07) |
| GET | `/v1/people` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Search people (no contact fields) |
| POST | `/v1/people` | staff | Admin, Manager, Supply agent, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Create a person (phones deduplicated) |
| GET | `/v1/people/{idOrCode}` | svc, staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a person (masked) |
| PATCH | `/v1/people/{idOrCode}` | staff | Admin, Manager, Supply agent, Demand agent | If-Match |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Update a person (contacts write-only) |
| POST | `/v1/people/{idOrCode}/flags` | staff | Admin, Manager, Supply agent, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | person.flagged.v1, person.flag_removed.v1 | Add or remove a person flag |
| POST | `/v1/quick-add/lookup` | staff | Admin, Manager, Demand agent, Supply agent | by design |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Phone-first lookup: matching people, their open demands, offers and flags (US-04 AC1) |
| POST | `/v1/quick-add` | staff | Admin, Manager, Demand agent, Supply agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | demand.created.v1, demand.touch_added.v1, offer.created.v1, merge_candidate.raised.v1 | Quick add: create a demand or supply, or add a touch to an existing demand |
| POST | `/v1/reveals` | staff | all | Idempotency-Key |  | 60 reveals/hour per user (anti-scraping; justification: normal call work is < 40 contacts/day, D-10) | 2000 | audit.recorded.v1 | Reveal contact / unit-level fields of one subject (audit-logged, R-VIS-3) |
| GET | `/v1/enquiries` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | List enquiries |
| GET | `/v1/enquiries/{idOrCode}` | svc, staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get an enquiry (message via reveal) |
| GET | `/v1/source-ads` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | List source ads (one uploaded ad → 1..n records) |
| GET | `/v1/source-ads/{idOrCode}` | staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a source ad with its split children |
| GET | `/v1/merge-candidates` | staff | Admin, Manager, Data operator | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Uncertain-merge review queue |
| POST | `/v1/merge-candidates/{id}/dismiss` | staff | Admin, Manager, Data operator | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Mark a candidate Different or Skip |
| POST | `/v1/merges` | staff | Admin, Manager, Data operator | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | records.merged.v1, audit.recorded.v1, demand.touch_added.v1, offer.updated.v1, demand.updated.v1 | Merge records into a survivor (reversible) |
| GET | `/v1/merges/{id}` | staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a merge and what it moved |
| POST | `/v1/merges/{id}/undo` | staff | Admin, Manager | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | records.merge_undone.v1, audit.recorded.v1, offer.updated.v1, demand.updated.v1 | Undo a merge (US-09) |
| GET | `/v1/desks/{desk}` | staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Desk list view (US-36) |
| GET | `/v1/desk-items/{idOrCode}` | staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a desk item |
| PATCH | `/v1/desk-items/{idOrCode}` | staff | Admin, Manager | If-Match |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | desk_item.updated.v1 | Assign, archive or annotate a Business / Capital / Archive / Watchlist item |
| GET | `/v1/vocabulary` | svc, staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | The active controlled-vocabulary release (read-only, D-16) |
| GET | `/v1/vocabulary/versions` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Vocabulary release history |
| GET | `/v1/micromarkets` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Micromarket hierarchy (zone → micromarket → locality → sub-locality, with aliases) |
| POST | `/v1/micromarkets` | staff | Admin | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | micromarkets.updated.v1 | Add a hierarchy node (Admin, US-34) |
| PATCH | `/v1/micromarkets/{id}` | staff | Admin | If-Match |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | micromarkets.updated.v1 | Rename, re-parent, change aliases or adjacency (Admin, R-13) |
| GET | `/v1/launch-area` | svc, staff | all | safe |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Cities enabled for queues, matching and listings (CR-006 Z-7) |
| PUT | `/v1/launch-area` | staff | Admin | by design |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | offer.updated.v1, demand.updated.v1 | Replace the enabled city list (Admin) |
| POST | `/v1/photos` | staff | Admin, Manager, Supply agent, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Get a signed URL to upload a photo for a property |
| POST | `/v1/photos/{id}/attach` | staff | Admin, Manager, Supply agent, Demand agent | Idempotency-Key |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | photo.added.v1, offer.updated.v1 | Confirm the upload and attach the photo to the property (and chosen offers) |
| DELETE | `/v1/photos/{id}` | staff | Admin, Manager, Supply agent, Demand agent | by design |  | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | photo.removed.v1, offer.updated.v1 | Detach and delete a photo |
| GET | `/internal/v1/properties/{id}/scan-terms` | svc | — | safe |  | listings only; no user limit | 2000 | — | Salted hashes of building/society name tokens, wing and unit for the privacy scan (R-20) |
| GET | `/internal/v1/photos/{id}/signed-url` | svc | — | safe |  | listings only; no user limit | 2000 | — | Short-lived signed URL to read an original photo so listings can build public renditions (Stage 4 reconciliation L-2) |
| POST | `/internal/v1/contacts:batch` | svc | — | by design |  | insight export workers only; no user limit | 2000 | audit.recorded.v1 | Contacts of up to 1,000 people for an export (R-21, audited) |
| GET | `/v1/market-data` | svc, staff | all | safe | yes | 20 req/s per user, burst 40 (enforced at web, conventions §4) | 2000 | — | Market data points (closed / reported prices) |
| POST | `/internal/v1/relay` | cron | — | by design |  | n/a: pg_cron/pg_net only (1 call/min per job plus pokes) | 60000 | — | Relay unpublished outbox rows to consumer pgmq queues |
| POST | `/internal/v1/drain/{queue}` | cron | — | by design |  | n/a: pg_cron/pg_net only (1 call/min per job plus pokes) | 60000 | — | Drain one of this service's pgmq queues |
| POST | `/internal/v1/jobs/{name}` | cron | — | by design |  | n/a: pg_cron/pg_net only (1 call/min per job plus pokes) | 60000 | — | Run a scheduled job |
| GET | `/health/live` | none | — | safe |  | none (health probe) | 2000 | — | Liveness (process up) |
| GET | `/health/ready` | none | — | safe |  | none (health probe) | 2000 | — | Readiness (DB reachable, migrations at expected version) |

## journeys (60)

| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/v1/queues/me` | staff | Admin, Manager, Demand agent, Supply agent | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | My queue summary: sections with counts, capacity and today's plan (P-01, C-01) |
| GET | `/v1/queues/me/sections/{section}` | staff | Admin, Manager, Demand agent, Supply agent | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Items of one section of my queue, in computed order |
| GET | `/v1/queues/users/{userId}` | staff | Admin, Manager | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | A team member's queue summary (Manager view) |
| GET | `/v1/queues/users/{userId}/sections/{section}` | staff | Admin, Manager | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Items of one section of a team member's queue (Manager view) |
| POST | `/v1/queue-items/reassign` | staff | Admin, Manager | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | audit.recorded.v1 | Bulk reassign open queue items (≤100) to another user (C-19) |
| GET | `/v1/capacities` | staff | Admin, Manager | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Daily call capacities of all users (D-10) |
| GET | `/v1/capacities/{userId}` | staff | Admin, Manager, Demand agent, Supply agent | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | One user's daily capacity (self, or Manager/Admin for anyone) |
| PUT | `/v1/capacities/{userId}` | staff | Admin, Manager | by design |  | 20/s per user, burst 40 (token bucket at web) | 2000 | audit.recorded.v1 | Set a user's daily call capacity (default 40, A-36) |
| POST | `/v1/calls` | staff | Admin, Manager, Demand agent, Supply agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | call.logged.v1, offer.confirmed.v1, demand.confirmed.v1, lifecycle.stage_changed.v1, offer.commercial_status_changed.v1, demand.status_changed.v1, demand.reactivated.v1, offer.retired.v1 | Log a call or meeting outcome (C-08); drives life curve, attempts, retire |
| GET | `/v1/calls` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Call history for a subject or a person (P-04) |
| GET | `/v1/life-curves/{subjectType}/{subjectId}` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Life curve for an offer or demand (stage, day count, thresholds) |
| GET | `/v1/offers/{idOrCode}/journey` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Offer work state: Commercial axis, life curve, queue, signals (P-02) |
| POST | `/v1/offers/{idOrCode}/retire` | staff | Admin, Manager, Supply agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | offer.retired.v1, offer.commercial_status_changed.v1, audit.recorded.v1 | Retire an offer to Inactive (already gone / unwilling / other) (C-17, US-18) |
| GET | `/v1/demands/{idOrCode}/journey` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Demand work state: Commercial axis, exit, qualification, life curve (P-03) |
| POST | `/v1/demands/{idOrCode}/qualify` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | demand.qualified.v1, demand.status_changed.v1, demand.confirmed.v1, lifecycle.stage_changed.v1 | Mark a demand qualified (C-09); triggers the inventory check |
| POST | `/v1/demands/{idOrCode}/exit` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | demand.exited.v1, lifecycle.stage_changed.v1, sourcing_request.updated.v1, audit.recorded.v1 | Exit a demand: Lost, Dormant or Invalid (C-16, US-26) |
| POST | `/v1/demands/{idOrCode}/reactivate` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | demand.reactivated.v1, demand.status_changed.v1, lifecycle.stage_changed.v1, demand.confirmed.v1, audit.recorded.v1 | Return an exited demand to Active (Dormant revisit; Lost/Invalid = Manager override) |
| POST | `/v1/sourcing-requests` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | sourcing_request.created.v1, demand.sourcing_started.v1, demand.status_changed.v1 | Raise a sourcing request to the supply team (C-11, US-22) |
| GET | `/v1/sourcing-requests` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | List sourcing requests |
| GET | `/v1/sourcing-requests/{idOrCode}` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Get a sourcing request |
| PATCH | `/v1/sourcing-requests/{idOrCode}` | staff | Admin, Manager, Demand agent, Supply agent | If-Match |  | 20/s per user, burst 40 (token bucket at web) | 2000 | sourcing_request.updated.v1, demand.status_changed.v1 | Update status, assignee, due date or priority |
| POST | `/v1/proposals` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Create a proposal from confirmed matches (C-13, US-23) |
| GET | `/v1/proposals` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | List proposals |
| GET | `/v1/proposals/{idOrCode}` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Get a proposal |
| PATCH | `/v1/proposals/{idOrCode}` | staff | Admin, Manager, Demand agent | If-Match |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Change options or cover note (not after Sent) |
| POST | `/v1/proposals/{idOrCode}/pdf` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Queue PDF generation (async, off the request path) |
| GET | `/v1/proposals/{idOrCode}/pdf` | staff | Admin, Manager, Demand agent | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | PDF status and a 5-minute signed download URL |
| POST | `/v1/proposals/{idOrCode}/share-link` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | audit.recorded.v1 | Create (or replace) the private share link, 14-day expiry (A-40) |
| DELETE | `/v1/proposals/{idOrCode}/share-link` | staff | Admin, Manager, Demand agent | by design |  | 20/s per user, burst 40 (token bucket at web) | 2000 | audit.recorded.v1 | Revoke the active share link |
| POST | `/v1/proposals/{idOrCode}/mark-sent` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | proposal.sent.v1, offer.commercial_status_changed.v1, demand.status_changed.v1 | Mark the proposal sent (logs date and channel; the system sends nothing) |
| POST | `/v1/proposals/{idOrCode}/feedback` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | proposal.feedback_recorded.v1 | Record client feedback per option |
| GET | `/p/{token}` | none | — | safe |  | 30/min per IP and 120/min per token (enforced at web edge) | 2000 | — | Public proposal page for a share-link token (no staff auth) |
| POST | `/v1/site-visits` | staff | Admin, Manager, Demand agent, Supply agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | site_visit.scheduled.v1 | Schedule a site visit (C-14) |
| GET | `/v1/site-visits` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | List site visits |
| GET | `/v1/site-visits/{idOrCode}` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Get a site visit |
| PATCH | `/v1/site-visits/{idOrCode}` | staff | Admin, Manager, Demand agent, Supply agent | If-Match |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Reschedule, change offers/attendees or cancel |
| POST | `/v1/site-visits/{idOrCode}/complete` | staff | Admin, Manager, Demand agent, Supply agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | site_visit.completed.v1, offer.confirmed.v1, demand.confirmed.v1, lifecycle.stage_changed.v1, offer.commercial_status_changed.v1, demand.status_changed.v1 | Record the visit outcome; resets both life curves (US-24) |
| POST | `/v1/deals` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | deal.opened.v1, deal.updated.v1, offer.commercial_status_changed.v1, demand.status_changed.v1 | Open a deal (In process) for one demand and one offer (C-15, US-25) |
| GET | `/v1/deals` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | List deals |
| GET | `/v1/deals/{idOrCode}` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Get a deal |
| PATCH | `/v1/deals/{idOrCode}` | staff | Admin, Manager, Demand agent | If-Match |  | 20/s per user, burst 40 (token bucket at web) | 2000 | deal.updated.v1, deal.closed.v1, offer.commercial_status_changed.v1, demand.status_changed.v1, audit.recorded.v1 | Advance stage, update terms / next action / follow-up; stage=Closed closes the deal (saga start) |
| POST | `/v1/deals/{idOrCode}/cancel` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | deal.cancelled.v1, deal.updated.v1, offer.commercial_status_changed.v1, demand.status_changed.v1, lifecycle.stage_changed.v1, audit.recorded.v1 | Cancel a deal (compensation): offer → Available, demand → Active; deal kept |
| POST | `/v1/deals/{idOrCode}/follow-ups` | staff | Admin, Manager, Demand agent, Supply agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | deal.updated.v1, demand.confirmed.v1, offer.confirmed.v1, lifecycle.stage_changed.v1 | Log a follow-up on an open deal and set the next one (resets both life curves) |
| GET | `/v1/lease-renewals` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Scheduled lease renewals (month 10 of 11-month leases, US-16) |
| GET | `/v1/notifications` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | My in-app notifications (FR-NTF-1) |
| GET | `/v1/notifications/unread-count` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Unread notification count (sidebar badge) |
| POST | `/v1/notifications/mark-read` | staff | all | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Mark notifications read (by ids or up to a time) |
| GET | `/v1/watchlist-tasks` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Supply follow-up tasks for Market Signals (D-14, US-36) |
| PATCH | `/v1/watchlist-tasks/{taskId}` | staff | Admin, Manager | If-Match |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Assign, set due date or cancel a watchlist task |
| POST | `/v1/watchlist-tasks/{taskId}/complete` | staff | Admin, Manager, Supply agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | watchlist_task.completed.v1 | Close a watchlist follow-up task |
| GET | `/v1/settings/life-curve-thresholds` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Life-curve thresholds per category |
| PUT | `/v1/settings/life-curve-thresholds` | staff | Admin | by design |  | 20/s per user, burst 40 (token bucket at web) | 2000 | audit.recorded.v1 | Replace life-curve thresholds (Admin); recomputes nextChangeOn |
| GET | `/v1/settings/queue-weights` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Should call ranking weights |
| PUT | `/v1/settings/queue-weights` | staff | Admin | by design |  | 20/s per user, burst 40 (token bucket at web) | 2000 | audit.recorded.v1 | Replace Should call ranking weights (Admin) |
| GET | `/internal/v1/subject-states` | svc | — | safe | yes | 10/s per calling service | 2000 | — | Life stage and Commercial axis per subject, for consumers rebuilding a projection |
| POST | `/internal/v1/relay` | cron | — | by design |  | 1 call/min per job (pg_cron); internal only | 10000 | — | Relay unpublished outbox rows into consumer pgmq queues |
| POST | `/internal/v1/drain/{queue}` | cron | — | by design |  | 1 call/min per job (pg_cron); internal only | 55000 | offer.commercial_status_changed.v1, demand.status_changed.v1, lifecycle.stage_changed.v1, sourcing_request.updated.v1 | Drain a pgmq queue owned by this service |
| POST | `/internal/v1/jobs/{name}` | cron | — | by design |  | 1 call/min per job (pg_cron); internal only | 55000 | queue.counts_changed.v1, deal.updated.v1, lifecycle.stage_changed.v1, demand.exited.v1, offer.commercial_status_changed.v1, lease_renewal.due.v1 | Run a scheduled job (one bounded batch; continues on the next call) |
| GET | `/health/live` | none | — | safe |  | unlimited (platform probe) | 500 | — | Liveness: process is up |
| GET | `/health/ready` | none | — | safe |  | unlimited (platform probe) | 1000 | — | Readiness: DB reachable and migrations at the expected version |

## crm-engine (19)

| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/v1/demands/{idOrCode}/matches` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Matches for a demand, best first (C-10, P-03) |
| GET | `/v1/offers/{idOrCode}/matches` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Matches that include an offer (single or bundle) (P-02) |
| GET | `/v1/matches/{idOrCode}` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Get a match |
| GET | `/v1/matches/{idOrCode}/explanation` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Explain a match: hard filters, factor breakdown, flags |
| POST | `/v1/matches/{idOrCode}/confirm` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | match.confirmed.v1 | Confirm a suggested match (US-21) |
| POST | `/v1/matches/{idOrCode}/reject` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | match.rejected.v1 | Reject a match with a reason code (US-21) |
| POST | `/v1/bundles` | staff | Admin, Manager, Demand agent, Supply agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | match.suggested.v1, match.confirmed.v1 | Build a bundle of 2–3 offers for a demand (A-38) |
| GET | `/v1/bundles/{idOrCode}` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Get a bundle |
| GET | `/v1/demands/{idOrCode}/exclusions` | staff | all | safe | yes | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Offers excluded for a demand, with reasons (date-aware, e.g. 'Available too late') |
| POST | `/v1/demands/{idOrCode}/matching-runs` | staff | Admin, Manager, Demand agent | Idempotency-Key |  | 20/s per user, burst 40 (token bucket at web) | 2000 | demand.matching_completed.v1, match.suggested.v1, match.closed.v1, match.flagged.v1 | Re-run matching for one demand (async) |
| GET | `/v1/matching-runs/{runId}` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Status of a matching run |
| GET | `/v1/weights` | staff | all | safe |  | 20/s per user, burst 40 (token bucket at web) | 2000 | — | Current match weights and tunables |
| PUT | `/v1/weights` | staff | Admin | by design |  | 20/s per user, burst 40 (token bucket at web) | 2000 | audit.recorded.v1, match.suggested.v1, match.closed.v1 | Replace match weights (Admin); queues a full re-score |
| GET | `/internal/v1/matches` | svc | — | safe | yes | 10/s per calling service | 2000 | — | All matches (keyset), for consumers rebuilding a projection |
| POST | `/internal/v1/relay` | cron | — | by design |  | 1 call/min per job (pg_cron); internal only | 10000 | — | Relay unpublished outbox rows into consumer pgmq queues |
| POST | `/internal/v1/drain/{queue}` | cron | — | by design |  | 1 call/min per job (pg_cron); internal only | 55000 | match.suggested.v1, match.closed.v1, match.flagged.v1, match.reopened.v1, demand.matching_completed.v1 | Drain a pgmq queue owned by this service |
| POST | `/internal/v1/jobs/{name}` | cron | — | by design |  | 1 call/min per job (pg_cron); internal only | 55000 | match.suggested.v1, match.closed.v1, match.flagged.v1, match.reopened.v1, demand.matching_completed.v1 | Run a scheduled job (one bounded batch; continues on the next call) |
| GET | `/health/live` | none | — | safe |  | unlimited (platform probe) | 500 | — | Liveness: process is up |
| GET | `/health/ready` | none | — | safe |  | unlimited (platform probe) | 1000 | — | Readiness: DB reachable and migrations at the expected version |

## listings (25)

| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/v1/offers/{idOrCode}/publication` | staff | all | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | Publication state of an offer with the computed ceiling and the reasons (C-12, P-02 Overview) |
| PUT | `/v1/offers/{idOrCode}/publication` | staff | Admin, Manager, Supply agent | by design |  | per user at web (20 req/s, burst 40) | 2000 | publication.changed.v1, audit.recorded.v1 | Set the publication level (at or below the ceiling), optionally with an edited public description |
| POST | `/v1/offers/{idOrCode}/privacy-scan` | staff | Admin, Manager, Supply agent | Idempotency-Key |  | per user at web (20 req/s, burst 40) | 2000 | — | Dry-run privacy scan of a proposed public description (and the offer's photos) without changing the level |
| GET | `/v1/projects/{idOrCode}/publication` | staff | all | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | Publication state of a project (P-05) with ceiling and reasons |
| PUT | `/v1/projects/{idOrCode}/publication` | staff | Admin, Manager, Supply agent | by design |  | per user at web (20 req/s, burst 40) | 2000 | publication.changed.v1, audit.recorded.v1 | Set a project's level (Private or Public; projects have no Anonymous level) |
| GET | `/v1/demands/{idOrCode}/demand-post` | staff | all | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | Anonymous demand post state for a demand (P-03 Sourcing tab) |
| PUT | `/v1/demands/{idOrCode}/demand-post` | staff | Admin, Manager, Demand agent | by design |  | per user at web (20 req/s, burst 40) | 2000 | publication.changed.v1, audit.recorded.v1 | Post (Anonymous) or take down (Private) the anonymous demand post; allowed only while the demand is in Sourcing and Fresh/Ageing |
| GET | `/v1/publications` | staff | all | safe | yes | per user at web (20 req/s, burst 40) | 2000 | — | Staff list of publication states (e.g. "Stale Public offers", everything Public), stored-field filters |
| GET | `/v1/publication-settings` | svc, staff | all | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | RERA agent number and listing notes shown on every item |
| PUT | `/v1/publication-settings` | staff | Admin | by design |  | per user at web (20 req/s, burst 40) | 2000 | audit.recorded.v1 | Set the 11 Estates MahaRERA agent number and the "subject to confirmation" note (Admin) |
| GET | `/v1/api-keys` | staff | Admin | safe | yes | per user at web (20 req/s, burst 40) | 2000 | — | List website API keys (metadata only; secrets are never returned after creation) |
| POST | `/v1/api-keys` | staff | Admin | Idempotency-Key |  | per user at web (20 req/s, burst 40) | 2000 | audit.recorded.v1 | Create an API key for a website or microsite; the secret is returned once |
| POST | `/v1/api-keys/{keyId}/rotate` | staff | Admin | Idempotency-Key |  | per user at web (20 req/s, burst 40) | 2000 | audit.recorded.v1 | Issue a replacement key; the old key stays valid for a grace period (default 168 h, max 720 h) |
| POST | `/v1/api-keys/{keyId}/revoke` | staff | Admin | Idempotency-Key |  | per user at web (20 req/s, burst 40) | 2000 | audit.recorded.v1 | Revoke a key immediately (the edge cache entries for it expire within 30 s) |
| GET | `/v1/listings` | key | Website client | safe | yes | 50 req/s, burst 100 per API key (token bucket enforced by listings itself, conventions R-1; cache hits are not counted) | 2000 | — | Published offers (Anonymous or Public shape per item), stored-field filters, cursor pagination (max 50) |
| GET | `/v1/listings/{publicId}` | key | Website client | safe |  | 50 req/s, burst 100 per API key | 2000 | — | One published offer. Withdrawn or unknown IDs → 404 (the change feed says "withdrawn"). |
| GET | `/v1/projects` | key | Website client | safe | yes | 50 req/s, burst 100 per API key | 2000 | — | Published projects (Sale, Primary) |
| GET | `/v1/projects/{publicId}` | key | Website client | safe |  | 50 req/s, burst 100 per API key | 2000 | — | One published project with configurations |
| GET | `/v1/demand-posts` | key | Website client | safe | yes | 50 req/s, burst 100 per API key | 2000 | — | Anonymous demand posts ("Wants" label) while the demand is in Sourcing |
| GET | `/v1/changes` | key | Website client | safe |  | 50 req/s, burst 100 per API key | 2000 | — | Change feed (published / updated / upgraded / downgraded / withdrawn) since a cursor or a time |
| POST | `/internal/v1/relay` | cron | scheduler | by design |  | none (scheduler only; single-flight via advisory lock) | 55000 | publication.changed.v1, audit.recorded.v1 | Publish unpublished outbox rows to subscribed consumer queues (pg_cron every minute + poke after commit) |
| POST | `/internal/v1/drain/{queue}` | cron | scheduler | by design |  | none (scheduler only; every 20 s + poke from the producer relay) | 55000 | publication.changed.v1, audit.recorded.v1 | Consume a batch from listings' queue (dedupe on eventId, per-aggregate version check, DLQ after 5 attempts) |
| POST | `/internal/v1/jobs/{name}` | cron | scheduler | by design |  | none (scheduler only; single-flight per job name) | 55000 | publication.changed.v1 | Scheduled jobs |
| GET | `/health/live` | none | anonymous | safe |  | none | 500 | — |  |
| GET | `/health/ready` | none | anonymous | safe |  | none | 1000 | — |  |

## insight (20)

| Method | Path | Auth | Roles | Idempotency | Paged | Rate limit | Timeout ms | Emits | Summary |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/v1/chat/conversations` | staff | all | safe | yes | per user at web (20 req/s, burst 40) | 2000 | — | The caller's own conversations (sidebar "Recent chats"), newest first |
| POST | `/v1/chat/conversations` | staff | all | Idempotency-Key |  | per user at web (20 req/s, burst 40) | 2000 | — | Start a conversation ("+ New chat") |
| GET | `/v1/chat/conversations/{conversationId}` | staff | all | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | One of the caller's conversations (metadata) |
| DELETE | `/v1/chat/conversations/{conversationId}` | staff | all | by design |  | per user at web (20 req/s, burst 40) | 2000 | — | Delete one of the caller's conversations (soft delete now, purged by the nightly job) |
| GET | `/v1/chat/conversations/{conversationId}/messages` | staff | all | safe | yes | per user at web (20 req/s, burst 40) | 2000 | — | Messages of a conversation, oldest first (stored text is redacted; cards are re-rendered with live state by the UI, R-CHAT-3) |
| POST | `/v1/chat/conversations/{conversationId}/messages` | staff | all | Idempotency-Key |  | at web: 1 concurrent stream and 30 messages/min per user | 15000 | — | Ask a question; the answer streams back as Server-Sent Events |
| GET | `/v1/chat/plan-catalogue` | staff | all | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | The allowed query-plan templates (what the assistant can answer), for transparency and the UI's "How I got this" |
| POST | `/v1/queries` | staff | all | by design |  | per user at web (20 req/s, burst 40) | 2000 | — | Run a validated plan (no model involved) and return one page of rows — used by "Open in panel" (P-07) and dashboard drill-downs |
| GET | `/v1/dashboards/demand` | staff | Admin, Manager, Demand agent, Supply agent | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | Demand dashboard (BRD §8): by source, life curve, team queues, exits, classification grid with Wants labels |
| GET | `/v1/dashboards/supply` | staff | Admin, Manager, Demand agent, Supply agent | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | Supply dashboard (BRD §8): stock, life curve, queues and listings, classification grid with For labels, deal-tag filters |
| GET | `/v1/dashboards/scopes` | staff | Admin, Manager, Demand agent, Supply agent | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | Other scopes (BRD §8): Business and Capital desks, Archive, Network, Watchlist |
| GET | `/v1/dashboards/quality` | staff | all | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | Data quality (BRD §8): uploads, review queue by review_reason, side checks, source quality |
| GET | `/v1/exports` | staff | all | safe | yes | per user at web (20 req/s, burst 40) | 2000 | — | The caller's exports (Admin sees all), newest first |
| POST | `/v1/exports` | staff | all | Idempotency-Key |  | per user at web (20 req/s, burst 40); plus 10 exports per hour per user (insight) | 2000 | export.completed.v1, export.failed.v1, audit.recorded.v1 | Start a background Excel export of a list or chat answer (≤ 100,000 rows; pilot ≤ 20,000, R-16) |
| GET | `/v1/exports/{idOrCode}` | staff | all | safe |  | per user at web (20 req/s, burst 40) | 2000 | — | Status of an export; when completed and not expired, a short-lived signed download URL (file kept 24 h) |
| POST | `/internal/v1/relay` | cron | scheduler | by design |  | none (scheduler only; single-flight via advisory lock) | 55000 | export.completed.v1, export.failed.v1, audit.recorded.v1 | Publish outbox rows to consumer queues (pg_cron every minute + poke after commit) |
| POST | `/internal/v1/drain/{queue}` | cron | scheduler | by design |  | none (scheduler only; every minute + poke) | 55000 | export.completed.v1, export.failed.v1, audit.recorded.v1 | Consume a batch: q_insight (domain events → read model), q_insight_exports (export jobs) |
| POST | `/internal/v1/jobs/{name}` | cron | scheduler | by design |  | none (scheduler only; single-flight per job) | 55000 | — | Scheduled jobs |
| GET | `/health/live` | none | anonymous | safe |  | none | 500 | — |  |
| GET | `/health/ready` | none | anonymous | safe |  | none | 1000 | — |  |

