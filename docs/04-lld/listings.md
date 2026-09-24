# 04 — LLD: listings (S5, Publishing and Listings API)

| | |
|---|---|
| Version | 0.2 (draft; aligned to events v0.2 and conventions §10 R-1…R-22) |
| Date | 2026-09-24 |
| Based on | BRD v0.6.1 (§4.2 labels, §4.6, §9 Module C), PRD v0.6 (§2, §4.6, US-15, US-33, §8.3, NFR-1/2/10/13, §8.4), HLD v0.2 (S5, §5.2, §5.4, §7, §8), ADR-0003/0006/0008, `conventions.md` |
| Contract | `contracts/openapi/listings.yaml` (25 operations); events per `contracts/asyncapi/events.yaml` **v0.2** |
| Status | IN PROGRESS (Stage 4) |

## 1. Purpose and scope
listings decides **what the market may see** and serves it to the 11 Estates website and project microsites.

It owns:
- the **Publication axis** of offers, projects and anonymous demand posts: the level, the computed ceiling and the reasons for it;
- the blocking **privacy scan** and its results;
- the **sanitised public projection**, which is the only data the public API reads;
- the **change feed**, the website **API keys** and the **RERA publication settings** (the 11 Estates MahaRERA agent number).

Out of scope:
- offer, property, project and demand facts (records);
- the life curve and the Commercial axis (journeys);
- matches (crm-engine);
- photo capture (records).

listings learns about all of these **only from events**. When it rebuilds a projection, or fetches scan terms, it may
also call records with a service token issued by web (R-2, R-20). It never calls another service on a user request.

Per conventions §10:
- **R-1:** listings enforces the public API's per-key rate limits itself, with the `libs/ratelimit` Postgres token bucket
  in `listings.rate_limit_bucket`. web never sees website traffic.
- **R-4:** technical tables are exempt from tenant-first indexes.
- Remaining exception: **API key lookup is not tenant-first**, because the tenant is derived from the key
  (§3.5, `api_key`).

## 2. Internal module layout
```
services/listings/
  src/domain/                      # pure, no I/O
    publication/ceiling.ts         # computeCeiling(inputs) → {ceiling, reasons[]}
    publication/levels.ts          # rank(), clampToCeiling(), transition → changeType
    publication/autoDowngrade.ts   # decide(level, newCeiling, cause) → {newLevel, reason}
    privacy/scanner.ts             # scan(text, privateTermHashes, rules) → findings[]
    privacy/patterns.ts            # phone/email/url/handle/wing-unit/floor/street regexes + normaliser (rulesVersion)
    labels/labelGenerator.ts       # BRD §4.2 display labels + headline
    projection/publicOffer.ts      # facts → PublicOffer (Anonymous | Public shape), field allow-list
    projection/publicProject.ts    # project + configurations → PublicProject
    projection/publicDemandPost.ts # demand → PublicDemandPost (budget banding)
    ids/publicId.ts                # L- + 10 Crockford base32 (CSPRNG)
    changefeed/changeType.ts       # (before, after) → published|updated|upgraded|downgraded|withdrawn|none
  src/application/                 # use cases; depend on ports only
    ports/  PublicationRepo, InputRepo, PublicItemRepo, ChangeFeedRepo, ScanRepo, PhotoRepo, PrivateTermRepo,
            SettingsRepo, ApiKeyRepo, RateLimiter, Outbox, IdempotencyStore, VocabularyCache, Clock,
            RecordsReader (service-token GETs for rebuilds), ScanTermsReader (records GET /internal/v1/properties/{id}/scan-terms, R-20),
            PhotoStore (buckets), ImageProcessor
    SetPublicationLevel, ScanText, GetPublicationState, ListPublications, SetDemandPost, PutSettings,
    CreateApiKey, RotateApiKey, RevokeApiKey, AuthenticateApiKey,
    PublicListOffers/GetOffer/ListProjects/GetProject/ListDemandPosts/ListChanges,
    ApplyEvent (one handler per consumed event type), ProcessPhoto, CeilingSweep, ProjectionRefresh
  src/adapters/
    http/        Next.js route handlers (Vercel functions): staff, public, internal, health; zod validation from OpenAPI
    db/          postgres (Supavisor tx mode), repositories, migrations runner hooks
    messaging/   pgmq drain (q_listings, q_listings_photos), outbox relay (libs/outbox)
    storage/     Supabase Storage: listings-photos (private), listings-public (public CDN)
    records/     RecordsReader + ScanTermsReader (service token from web POST /internal/v1/service-tokens; JWKS verify, R-2)
    image/       sharp ImageProcessor (EXIF strip, resize). No OCR in listings: records supplies hasTextDetected
    composition.ts   # composition root: wires ports to adapters
  migrations/  tests/  Dockerfile  README.md
```
Shared `libs/` used: outbox/relay, consumer (dedupe + DLQ), idempotency, ratelimit, auth (service-token verify, API-key
HMAC), logging (PII allow-list), tracing, vocabulary client, redaction patterns (phone/email only; listings adds its own
address rules in domain).

## 3. Data schema (schema `listings`, role `listings_svc`)
Every table has `tenant_id uuid not null`, `created_at timestamptz not null default now()` and `updated_at timestamptz`.
The PK is `(tenant_id, id)`, so the tenant is the first column of every index (conventions §3) and `id` is the row
identity (§6). Types: `bigint` for INR, `numeric(12,2)` for sq ft, `numeric(3,1)` for BHK (0.5 = 1 RK).

### 3.1 Ceiling inputs (projections fed by events)
**`offer_input`**: one row per offer, keyed by the records offer id.

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | = offerId |
| code | text | no | INV-… |
| property_id | uuid | no | |
| project_id | uuid | yes | Sale/Primary configurations |
| deal_type, market, segment | text | deal_type no; others yes | vocabulary values |
| property_types | text[] | no | |
| bhk_min, bhk_max | numeric(3,1) | yes | |
| area_sqft_min, area_sqft_max | numeric(12,2) | yes | |
| area_basis | text | yes | Carpet / Builtup / Saleable |
| land_area_sqft | numeric(14,2) | yes | |
| sale_price_inr_min/max, rent_monthly_inr_min/max | bigint | yes | deposit and current rent are **not** stored (not public) |
| locality, micromarket, city | text | yes | |
| outside_launch_area | boolean | no | default false |
| tenancy_status, sale_mode, possession_status, furnishing | text | yes | deal tags |
| possession_date | text | yes | YYYY, YYYY-MM or YYYY-MM-DD |
| unit_count | integer | yes | project configurations |
| floor_band | text | yes | Low / Mid / High (public; the exact floor never reaches listings) |
| total_floors, parking | integer | yes | public fields |
| amenities | text[] | no | default `{}` |
| selected_photo_ids | uuid[] | no | the offer's chosen photos (D-5), from offer events |
| public_description_source | text | yes | reference only, not fetched (§4.7, OQ-L4) |
| voided_reason | text | yes | offer.voided (side_changed / scope_changed / duplicate_discarded) → never publishable |
| record_stage | text | yes | Captured…Qualified |
| has_real_photos | boolean | no | default false |
| commercial_status | text | yes | from journeys |
| life_stage | text | yes | Fresh/Ageing/Stale/Expired/Paused; null = not yet received |
| life_day | integer | yes | |
| retired_reason | text | yes | already_gone / unwilling / other |
| merged_into_id | uuid | yes | set on records.merged |
| records_version, journeys_version | integer | no | last applied aggregateVersion per producer (default 0) |

| Index | Serves |
|---|---|
| PK (tenant_id, id) | apply event by offerId; staff GET by id |
| UNIQUE (tenant_id, code) | staff `idOrCode` lookup by code |
| (tenant_id, project_id) WHERE project_id IS NOT NULL | build a project's configurations; RERA re-check when a project changes |
| (tenant_id, property_id) | photo.added → offers on that property; property merges |

**`project_input`**: id (= projectId), code, name, developer_person_id, developer_name (null, see remaining gap L-1),
city, micromarket, locality, rera_number (null), possession_date, amenities text[], offer_ids uuid[], records_version.
Indexes: PK (tenant_id, id); UNIQUE (tenant_id, code) (idOrCode).
*Fed by `project.created.v1` / `project.updated.v1`.*

**`demand_input`**: id (= demandId), code, deal_types text[], market, segment, property_types text[],
micromarkets text[], area_sqft_min/max, area_basis, budget_inr_min/max, rent_monthly_inr_min/max,
move_in_by text, outside_launch_area, commercial_status, life_stage, exit_type text (Lost/Dormant/Invalid),
post_requested boolean, sourcing_request_id uuid, voided_reason text, records_version, journeys_version.
Indexes: PK (tenant_id, id); UNIQUE (tenant_id, code).
*Facts are fed by `demand.created.v1` / `demand.updated.v1`.*

### 3.2 Publication state
**`publication`**: one row per publishable subject.

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | UUIDv7 |
| subject_type | text | no | offer / project / demand_post |
| subject_id | uuid | no | offerId / projectId / demandId |
| level | text | no | Private / Anonymous / Public, default Private |
| ceiling | text | no | computed |
| ceiling_reasons | text[] | no | reason codes (contract `CeilingReason.code`) |
| life_stage | text | yes | denormalised for listing filters |
| public_id | text | yes | `L-XXXXXXXXXX`, issued on first publish, never reused for another subject |
| public_description | text | yes | staff-edited text (null = generated) |
| description_source | text | no | generated / staff |
| last_scan_id | uuid | yes | FK privacy_scan |
| last_change_reason | text | yes | user / ceiling_dropped / closed / retired / expired / merged / voided |
| last_changed_by | uuid | yes | user id, or the system actor id |
| published_at | timestamptz | yes | first time above Private in the current publication |
| version | integer | no | optimistic concurrency (ETag / If-Match) |

| Index | Serves |
|---|---|
| PK (tenant_id, id) | |
| UNIQUE (tenant_id, subject_type, subject_id) | GET/PUT publication by subject; event handlers |
| UNIQUE (tenant_id, public_id) WHERE public_id IS NOT NULL | ID issuance collision check; merge re-pointing |
| (tenant_id, level, updated_at DESC, id DESC) | `GET /v1/publications?level=` |
| (tenant_id, subject_type, updated_at DESC, id DESC) | `GET /v1/publications?subjectType=` |
| (tenant_id, life_stage, level) | "Stale Public offers" tile (`lifeStage=Stale&level=Public`) |
| (tenant_id, id) WHERE level_rank(level) > level_rank(ceiling) | `ceilingBelowLevel=true` health list (should be empty) |

### 3.3 Sanitised public projection
**`public_item`**: the **only** table the public API reads. A row exists only while the level is Anonymous or Public.
`payload` holds the exact public JSON, built by the domain projection functions with a field **allow-list**.

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | = publication.id |
| public_id | text | no | |
| subject_type | text | no | listing / project / demand_post |
| level | text | no | Anonymous / Public |
| payload | jsonb | no | the response body for this item |
| payload_hash | bytea | no | SHA-256; decides whether a change counts as `updated` in the feed |
| deal_type | text | yes | offers |
| deal_types | text[] | yes | demand posts |
| market, segment, city, micromarket, locality | text | yes | filter columns (stored values) |
| micromarket_path | text[] | no | locality + all ancestor micromarkets/zones (hierarchy filter) |
| property_types | text[] | no | |
| bhk_min, bhk_max, area_sqft_min, area_sqft_max | numeric | yes | |
| sale_price_inr_min, rent_monthly_inr_min | bigint | yes | |
| price_sort_inr | bigint | yes | sale min for Sale, rent min for Lease; null sorts last |
| possession_sort | date | yes | possession_date normalised to its first day |
| sale_mode, tenancy_status, furnishing | text | yes | |
| project_public_id | text | yes | |
| published_at | timestamptz | no | |

| Index | Serves |
|---|---|
| UNIQUE (tenant_id, public_id) | `GET /v1/listings/{publicId}`, `/v1/projects/{publicId}` |
| (tenant_id, subject_type, published_at DESC, id DESC) | list endpoints, default sort `newest`, cursor |
| (tenant_id, subject_type, deal_type, segment, published_at DESC, id DESC) | the most common website filter (e.g. Lease + Commercial) |
| (tenant_id, subject_type, deal_type, price_sort_inr, id) | `sort=priceAsc/priceDesc` (400 `sort-requires-deal-type` without dealType) |
| GIN (tenant_id, property_types) (btree_gin) | `propertyType=` |
| GIN (tenant_id, micromarket_path) (btree_gin) | `micromarket=` / `locality=` with hierarchy |
| (tenant_id, subject_type, city, published_at DESC, id DESC) | `city=` |
| (tenant_id, project_public_id) WHERE project_public_id IS NOT NULL | `projectPublicId=` |

The remaining filters (bhk, area, price max, possessionBy, deal tags, level) are residual predicates on the indexed
candidate set. Each query is bounded by `LIMIT limit+1` with the index order, and a statement timeout of 800 ms.

**`change_feed`**: id uuid, seq bigint GENERATED ALWAYS AS IDENTITY, public_id, subject_type, change_type (published /
updated / upgraded / downgraded / withdrawn), level (null when withdrawn), occurred_at.
Indexes:
- UNIQUE (tenant_id, seq): `GET /v1/changes?since=<cursor>` (the cursor encodes seq);
- (tenant_id, occurred_at, seq): `since=<ISO time>` → the first seq at or after that time.

Rows are kept 30 days.

### 3.4 Photos, private terms, scans
**`photo`**: id (= records photoId), property_id, origin, is_real, source_storage_path (records' `storagePath`),
has_text_detected boolean (from records; **warning only**, R-8), status (pending / ready / failed / removed),
private_path (listings-photos bucket), public_path (null unless used by a Public item), public_name (random, not the
photo id), width, height, sort_order, attempts.
Indexes:
- (tenant_id, property_id, sort_order): photos for an offer's property;
- (tenant_id, status, created_at) WHERE status = 'pending': the photo worker.

**`private_term`**: a cache of the **salted hashes** returned by records
`GET /internal/v1/properties/{id}/scan-terms` (R-20) for the building/society name tokens, wing and unit of each
property. They're used only to detect those words in public text. listings never sees or stores the plain names.
Columns: id, property_id, kind (building / society / wing / unit), token_hash bytea, ngram smallint (1–4), salt_key_id
text, fetched_at. The cache is refreshed on offer.created/updated (property change), records.merged (property) and
merge_undone.
Indexes:
- (tenant_id, property_id): scan against the offer's own property;
- (tenant_id, token_hash): scan against **every** building/society name known in the tenant.

**`privacy_scan`**: id, subject_type, subject_id, text_sha256, rules_version, result (pass / warning / blocked),
findings jsonb (`[{kind, severity, field, start, end, photoId}]`), scanned_by.
Index: (tenant_id, subject_type, subject_id, created_at DESC) for the latest scan per subject (C-12).

### 3.5 Settings, API keys, rate limits
**`settings`**: id, maharera_agent_number text (null until set), subject_to_confirmation_note text, version, updated_by.
Index: UNIQUE (tenant_id), one row per tenant.

**`api_key`**:

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | keyId |
| name | text | no | site |
| prefix | text | no | first 8 chars, for display |
| key_hash | bytea | no | HMAC-SHA-256(secret, server pepper). The plaintext is never stored. |
| status | text | no | active / rotating / revoked |
| rate_limit_rps, burst | integer | no | ≤ 50 / ≤ 100 |
| allowed_origins | text[] | no | |
| grace_ends_at | timestamptz | yes | rotating keys |
| replaced_by_key_id | uuid | yes | |
| last_used_at | timestamptz | yes | written at most once a minute per instance |
| created_by, revoked_at, version | | | |

| Index | Serves |
|---|---|
| UNIQUE (key_hash) | authenticate `X-Api-Key` on each cache miss (tenant unknown until the key resolves: documented exception to tenant-first) |
| (tenant_id, created_at DESC, id DESC) | `GET /v1/api-keys` |
| (tenant_id, status, grace_ends_at) WHERE status = 'rotating' | `api-key-expire` job |

**`rate_limit_bucket`**: api_key_id uuid PK, tenant_id, tokens numeric, refilled_at timestamptz. This is the
`libs/ratelimit` token bucket. Instances lease tokens in blocks of 10 to cut writes (§8).

### 3.6 Plumbing
| Table | Columns | Index → query |
|---|---|---|
| `outbox` | conventions §6 | (published_at) WHERE published_at IS NULL, created_at → relay batch |
| `processed_events` | event_id PK, consumer, processed_at | PK → dedupe; (processed_at) → prune after 30 days |
| `idempotency_key` | id, tenant_id, user_id, route, key uuid, request_hash, status_code, response_body jsonb, expires_at | UNIQUE (tenant_id, user_id, route, key) → replay; (expires_at) → prune |
| `merge_log` | id, merge_id, subject_type, subject_id, prior jsonb (publication row + public_item payload) | (tenant_id, merge_id) → undo |
| `vocabulary_release` | id, version, checksum, values jsonb, micromarkets jsonb, active | UNIQUE (tenant_id, version); UNIQUE (tenant_id) WHERE active → validation cache load |
| `job_checkpoint` | name, cursor jsonb, updated_at | UNIQUE (tenant_id, name) |

**Tenancy:** the staff tenant comes from the service token `tid`. The website tenant comes from the API key row. Every
repository method takes `tenantId` as its first argument. The tenant-isolation test (NFR-15) covers staff routes,
public routes (key of tenant A can't read tenant B), and event handlers.

**Buckets:**
- `listings-photos` (private): sanitised copies.
- `listings-public` (public, CDN): copies used by Public items only. Deleted on downgrade or withdrawal.

## 4. Business rules and algorithms

### 4.1 Ceiling computation (BRD §4.6, PRD §4.6)
`computeCeiling(inputs, settings) → {ceiling, reasons[]}` is pure. Rules are evaluated in order, and the first rule
that caps the ceiling decides it. Every failing condition is added to `reasons`.

**Offers:**

| # | Condition | Ceiling | Reason code |
|---|---|---|---|
| 1 | `settings.maharera_agent_number` not set | Private | agent_rera_missing |
| 2 | commercial_status = Closed | Private | commercial_closed |
| 3 | commercial_status = Inactive (retired_reason = unwilling → also `retired_unwilling`; never publishable) | Private | commercial_inactive |
| 3a | offer voided (offer.voided.v1) or merged away | Private (never publishable) | voided / merged |
| 4 | life_stage = Expired | Private | life_expired |
| 5 | life_stage = Paused | Private | life_paused |
| 6 | outside_launch_area = true | Private | outside_launch_area |
| 7 | deal_type = Sale, market = Primary and the project RERA number is missing | Private | project_rera_missing |
| 8 | life_stage = Stale | Anonymous if the current level ≥ Anonymous, otherwise Private (see A-L1) | life_stale |
| 9 | record_stage ∉ {Verified, Qualified} | Anonymous | not_verified |
| 10 | has_real_photos = false, or no selected real photo is ready | Anonymous | no_real_photos |
| 11 | otherwise (Fresh or Ageing, Verified, real photos) | Public | — |

- `life_stage = null` (journeys hasn't reported yet) is treated as **Fresh**: a new capture is day 0 (BRD §4.6 allows
  Anonymous "before anyone has spoken to the source").
- Upcoming offers (commercial_status Upcoming) follow the same rules. Their possession_date is shown.

**Projects** (levels Private / Public only, A-L3):
- Public requires the agent number, the project RERA number, and at least one configuration offer whose own ceiling ≥
  Anonymous (`project_no_live_configuration`).
- Otherwise the ceiling is Private.

**Demand posts** (levels Private / Anonymous):
- Anonymous requires all of:
  - commercial_status = Sourcing;
  - no exit;
  - life_stage ∈ {Fresh, Ageing, null};
  - the agent number set.
- Otherwise the ceiling is Private, with reason `demand_not_sourcing`, `demand_exited` or `life_stale`/`life_expired`.

### 4.2 Setting a level (US-15, C-12)
Transaction: `SELECT … FOR UPDATE` on the publication row, check If-Match, then:
1. Validate `level ≤ ceiling`. Otherwise → 409 `level-above-ceiling`, with `errors[]` listing the reasons.
2. If raising to Anonymous or Public, or if `publicDescription` changed while above Private:
   a. **RERA check:** agent number set; project RERA number for Sale/Primary → else 422 `rera-missing`.
   b. **Privacy scan** (§4.4) on the effective public text. Any `block` finding → 422 `privacy-scan-blocked`. The scan
      row is stored either way.
   c. **Photo warnings (Public only; R-8, PRD A-17):** photos in `selected_photo_ids` with `has_text_detected = true`
      are flagged on C-12 and in the scan as `photo_text` **warnings**. Nothing is excluded or blocked automatically.
      The supply agent can deselect a photo in records (`PUT /v1/offers/{idOrCode}/photos`).
3. Issue `public_id` on the first publish (§4.6).
4. Upsert `public_item` (projection §4.7). Delete it when the level is Private.
5. Append a `change_feed` row (§4.8).
6. Write the `outbox` rows:
   - `publication.changed.v1`, only when the level changed (reason `user`);
   - `audit.recorded.v1` (action `publication.set`, `details` a flat string map with no PII: `{from, to, scanId, photoWarnings}`).
7. Commit, then poke the relay.

A repeat PUT with the same body changes nothing and emits nothing (PUT is idempotent).

### 4.3 Auto-downgrade (NFR-9, PRD §4.6, US-33 AC4)
Every input change is applied in the consumer transaction, and the ceiling is recomputed in that same transaction:
- lifecycle.stage_changed, offer.commercial_status_changed, deal.closed, deal.cancelled, offer.retired;
- offer.updated / record_stage_changed / photo.added;
- demand status, exit or match changes;
- settings changes.

If the level is now above the ceiling, it is set to the ceiling in the same transaction. Mapping to the event reason:

| Cause | New level | `publication.changed.v1` reason | Change feed |
|---|---|---|---|
| life Stale (from Public) | Anonymous | ceiling_dropped | downgraded |
| life Expired / Paused | Private | expired | withdrawn |
| commercial Closed (deal.closed or commercial_status_changed → Closed) | Private | closed | withdrawn |
| commercial Inactive (offer.retired) | Private | retired | withdrawn |
| not verified any more, photos removed, RERA removed, outside launch area, agent number cleared | per ceiling | ceiling_dropped | downgraded / withdrawn |
| demand matched (match.confirmed with demandId), status leaves Sourcing, or exited | Private | ceiling_dropped | withdrawn |
| offer merged into another (records.merged, aggregateType offer) | Private for the merged ids | merged | withdrawn |
| offer.voided / demand.voided | Private, never publishable | voided | withdrawn |
| photo.removed of a photo in use | stays; public photo set refreshed (ceiling may drop if no real photo remains) | ceiling_dropped (if the level drops) | updated / downgraded |

- **Never auto-raise.** When the ceiling rises (a deal cancelled, a reconfirmation, a merge undone), the level stays
  put. The supply agent re-publishes from C-12, so nothing becomes more visible without a click (R-CHAT-1).
  **Merge undo is the one exception:** the pre-merge level is restored from `merge_log`, capped at the current ceiling
  (HLD §7 saga "restore pre-merge state").
- Auto changes also emit `audit.recorded.v1` (action `publication.auto_changed`, `via: system`, actor = the reserved
  system user id `00000000-0000-0000-0000-000000000001`, R-7).
- Safety net: the `ceiling-sweep` job at 04:30 IST (after the nightly life-curve run ends by 04:00, NFR-9) recomputes
  every publication above Private.

### 4.4 Privacy scan (blocking; `rulesVersion` e.g. `ps-1`)
**Input:** the effective public text (the generated description, or the staff description). Generated text is
built only from allow-listed fields and passes by construction, but it's scanned too, as defence in depth.

**Normalisation:**
1. NFKC; lowercase.
2. Map number words to digits (en + common Hinglish: "nine eight two zero", "double 9"). Map look-alikes (o→0, l/i→1)
   inside digit runs.
3. Collapse separators (space, `.`, `-`, `/`, `(`, `)`) between digits.
4. Map "[at]", "(at)", " at " + "dot" to `@` and `.` for e-mail detection.
5. Keep a map from normalised offsets back to original offsets so findings point at the original text.

**Blocking rules:**

| Kind | Rule |
|---|---|
| phone | `(?:\+?91)?[6-9]\d{9}` (mobile); `0\d{2,4}\d{6,8}` (landline); any run of ≥ 8 digits after normalisation that isn't a recognised price/area/date |
| email | RFC-lite `[\w.+-]+@[\w-]+(\.[\w-]+)+` after de-obfuscation |
| url | `https?://`, `www.`, bare domains `[\w-]+\.(com\|in\|co\.in\|net\|org\|io\|me\|ly)\b`, `wa.me`, `t.me`, `bit.ly` |
| social_handle | `@[a-z0-9_.]{3,}` not part of an e-mail; "insta", "whatsapp me", "dm me" + handle |
| wing_unit | `\b(wing\|flat\|unit\|shop\|office\|gala\|apt\|door\|room\|block)\s*(no\.?\|number\|#)?\s*[a-z]?-?\d{1,4}[a-z]?\b`; `\b[a-z]-?\d{3,4}\b` (A-1203); `\b\d{3,4}\s*[a-z]\b` |
| exact_floor | `\b\d{1,2}(st\|nd\|rd\|th)\s*floor\b`, `floor\s*(no\.?)?\s*\d{1,2}` (the public shape uses floor bands only, A-43) |
| street_address | `\b(plot\|survey\|s\.?\s?no\|cts\|gat)\s*(no\.?)?\s*\d+`; a number + street word (`road\|rd\|marg\|lane\|street\|galli\|path`) |
| building_name / society_name / wing_unit (records terms) | text n-grams (1–4 tokens, generic words such as tower/society/chs/apartment/building/residency dropped first) are hashed with the same salt records used (R-20). A match against `private_term` (the offer's own property **or** any cached property in the tenant) blocks. Single tokens count only if length ≥ 6 and not on the locality/micromarket/amenity allow-list. A project's own public `name` is allow-listed for that project and its configurations. |

**Warnings (non-blocking, R-8):**
- `photo_text`: a selected photo has `hasTextDetected = true` (records). It's shown on C-12. Nothing is excluded.

**Findings:** kind, severity, field, start/end offsets, photoId. The matched text is **never** stored, returned or logged.

**False positives:** staff reword the text. There is no override for blocking findings (M8 = 0).

### 4.5 Photos
1. `photo.added.v1` (storagePath, isReal, hasTextDetected) → a `photo` row (pending) → a job on the internal pgmq queue
   `q_listings_photos` (slow work, CLAUDE.md §3.5).
2. The worker (drain `q_listings_photos`, 5 at a time):
   a. Read the file at `storagePath` (a records bucket) through a short-lived signed URL (see remaining gap L-2).
   b. Download (≤ 10 MB, 2 s connect / 10 s total).
   c. **Strip EXIF/GPS**; resize to 1600 px long edge, WebP q80 (sharp).
   d. Store the result in `listings-photos` and mark it ready.
   listings does **no OCR**: records' `hasTextDetected` is the warning source (R-8). Photos never go to a third-party AI.
3. Failure: after 3 attempts the status is `failed`. C-12 shows it. It's excluded only because there's no file.
4. **Which photos are public:** the offer's `selectedPhotoIds` (offer events; D-5) that are ready, in that order.
   - When an item becomes Public, those photos are copied to `listings-public/<tenant>/<public_name>.webp`.
   - On a downgrade, a withdrawal, a deselection or `photo.removed.v1`, the public copy is deleted in the same job
     run (≤ 1 min) and the projection is refreshed (`updated` feed row).

### 4.6 Public IDs
- `L-` + 10 Crockford base32 characters from 50 CSPRNG bits. On a unique-index collision, retry (≤ 3).
- Issued on the first publish of a subject and **stable for its life**. It's reused when a withdrawn item is
  re-published, so website URLs keep working. It's never derived from the id or code.
- On an offer merge, the survivor keeps its own ID. The merged item's ID is withdrawn and is never re-assigned.

### 4.7 Projection (field allow-lists; PRD §8.3)
- **Anonymous offer:** publicId, level, label, headline, dealType, market, segment, propertyTypes, bhkMin/Max, city,
  micromarket, locality, areaSqftMin/Max, areaBasis, landAreaSqft, the sale or rent price fields for its dealType,
  possessionDate, saleMode, tenancyStatus, furnishing, note (settings), agentReraNumber, projectPublicId,
  projectReraNumber, publishedAt, updatedAt. No photos.
- **Public offer:** Anonymous plus photos (selectedPhotoIds), floorBand (Low/Mid/High), parking, amenities,
  possessionStatus, description (listings-owned: generated from fields, or staff-edited in C-12 and privacy-scanned).
  `publicDescriptionSource` from records isn't fetched in Phase 1 (OQ-L4).
- **Project:** name, developerName (null until it's in `project.*` events: remaining gap L-1), locality chain, configurations (from its configuration offers whose own level ≥
  Anonymous):
  - propertyType, bhk, area, priceInrFrom = the minimum salePriceInrMin;
  - unitsAvailableBand from unit_count: 1-5 / 6-20 / 21-50 / 50+.

  Also: possession, amenities, floor plans, photos, projectReraNumber, agentReraNumber.
- **Demand post:** label, dealTypes, segment, propertyTypes, micromarkets, area range, and a budget **band**:
  - sale: round min down / max up to ₹10 L below ₹1 Cr, ₹25 L up to ₹5 Cr, ₹1 Cr above;
  - rent: ₹5,000 below ₹1 L a month, ₹25,000 above.

  Timing is month precision (YYYY-MM). Plus agentReraNumber.
- **Never** (enforced by the allow-list plus a contract test that fails on any other key): building/society name,
  wing, unit, exact floor, street, contacts, sources, notes, owners, side_evidence, needs_review data, deposit, current
  rent, internal id/code. Non-property scopes never get a publication row.

**Generated labels (BRD §4.2):**

| deal_type / market / segment | Supply label | Demand label |
|---|---|---|
| Sale, Secondary | Resale, For Sale | Wants to Buy, Resale |
| Sale, Primary | New Project, For Sale | Wants to Buy, New Project |
| Sale, Any (demand) | — | Wants to Buy |
| Sale, market blank (supply) | For Sale (A-L4) | Wants to Buy |
| Lease, Residential | For Rent | Wants to Rent |
| Lease, Commercial / Industrial / Land / blank | For Lease | Wants to Lease |
| JV | For JV | Wants JV |
| Pagdi | Pagdi, For Transfer | Wants Pagdi |

- A demand with several deal types joins the labels with " · " (e.g. "Wants to Buy · Wants to Rent").
- Headline: `[{bhk} BHK ]{propertyTypes joined " / "} · {label} · {locality ?? micromarket}`.
- Labels are never stored in filters. Filters work on stored values only.

### 4.8 Change feed
- One row per visible transition, written in the same transaction as `public_item`.

  | Transition | changeType |
  |---|---|
  | Private → Anonymous/Public | `published` |
  | Anonymous → Public | `upgraded` |
  | Public → Anonymous | `downgraded` |
  | → Private, or merged away | `withdrawn` |
  | same level, `payload_hash` changed (price, facts, photos, settings) | `updated` |

- The cursor is opaque base64url of `{seq}`. `since` as an ISO time → the first seq with `occurred_at ≥ since`.
- Retention is 30 days. An older cursor → 410 `change-feed-expired`, and the client resyncs from the list endpoints.
- The website contract: apply changes in seq order. For published/updated/upgraded/downgraded, re-GET the item. For
  withdrawn, remove it.

### 4.9 Freshness ≤ 1 min (NFR-10, US-33 AC4)
| Hop | Budget (p95) |
|---|---|
| Producer commit → relay (poked after commit; pg_cron each minute as backstop) | ≤ 5 s |
| Relay → `q_listings` drain (relay pokes subscribed drains; pg_cron `20 seconds` schedule as backstop) | ≤ 10 s |
| Drain applies the event + projection + change feed | ≤ 1 s |
| Edge cache (`s-maxage=20, stale-while-revalidate=10`) | ≤ 30 s |
| **Total** | **≤ ~46 s** p95. If pokes fail, the 20 s pg_cron backstops on relay and drain bound it at ≈ 20 + 20 + 1 + 30 ≈ 71 s worst case (see §8, OQ-L3) |

### 4.10 API keys
- Format `lk_live_` + 40 base62 characters (≈ 238 bits). Only `HMAC-SHA-256(pepper, secret)` is stored. It's shown
  once, and not even the idempotency replay returns it.
- **Rotate:** a new key is created; the old one becomes `rotating` with `grace_ends_at` (default 7 days) and is then
  expired by the job.
- **Revoke:** immediate. The positive-auth cache in each function instance has a TTL of 30 s, and edge cache entries
  are keyed by `Vary: X-Api-Key` with ≤ 30 s staleness.
- **Rate limit:** a token bucket per key (default 50 rps, burst 100), enforced by listings (R-1). Only cache misses
  reach the function.

### 4.11 RERA settings
- Admin sets the MahaRERA agent number (format `A` + 11 digits; the format is an assumption, A-L5) and the
  confirmation note.
- A change enqueues `projection-refresh`, which rewrites every `public_item` payload in batches of 500 and writes
  `updated` feed rows.
- Clearing the number isn't allowed (it's required). Until it's first set, every ceiling is Private.

### 4.12 Consumer mechanics
- Dedupe on `processed_events`. Ignore events whose `aggregateVersion ≤` the stored per-producer version.
- On a detected gap (version jump > 1 on an offer), mark the row `needs_rebuild` and fetch it from records with a
  service token (HLD §3.2 exception) in the same drain run.
- 5 failures → `q_listings_dlq` + alarm.

## 5. Events

### 5.1 Produced (outbox → relay)
| Event | When | Consumers (catalogue) |
|---|---|---|
| `publication.changed.v1` | Level changed by a user, auto-downgrade or merge. `data {subjectType, subjectId, from, to, reason, publicId}` | records, insight |
| `audit.recorded.v1` | publication.set, publication.auto_changed, photo_warning.overridden, api_key.created/rotated/revoked, settings.changed | web |

### 5.2 Consumed (queue `q_listings`; exactly the 26 listings subscriptions in `events.yaml` v0.2)
| Event | Effect |
|---|---|
| `offer.created.v1` | insert `offer_input` (incl. floorBand, totalFloors, parking, amenities, selectedPhotoIds) + `publication` (Private) + ceiling. Fetch scan terms for its property (R-20) |
| `offer.updated.v1` | update facts; re-fetch scan terms if the property changed; recompute the ceiling; refresh `public_item` (→ `updated` feed) |
| `offer.price_changed.v1` | update prices from the typed `current`; refresh the projection |
| `offer.record_stage_changed.v1` | record_stage, has_real_photos → ceiling (may downgrade) |
| `offer.voided.v1` | withdraw; never publishable (reason `voided`) |
| `photo.added.v1` | `photo` row (storagePath, hasTextDetected) + photo job |
| `photo.removed.v1` | delete the private and public copies; refresh the projection and ceiling |
| `project.created.v1` / `project.updated.v1` | `project_input` (name, RERA, locality, possession, amenities, offerIds); RERA re-check on its configuration offers; refresh the project item |
| `demand.created.v1` / `demand.updated.v1` | `demand_input` facts for demand posts; refresh the post if published |
| `demand.voided.v1` | withdraw the demand post (reason `voided`) |
| `offer.confirmed.v1` | no ceiling effect by itself (lifecycle.stage_changed follows). Refresh `updatedAt` only |
| `lifecycle.stage_changed.v1` | offer: life_stage → auto-downgrade (§4.3). demand: demand post ceiling |
| `offer.commercial_status_changed.v1` | commercial_status (Closed/Inactive → withdraw; Upcoming/Available allowed). Supersedes HLD `offer.closed.v1` (R-19) |
| `deal.closed.v1` | offer → Closed (withdraw); demand post → withdraw |
| `deal.cancelled.v1` | offer back to Available; ceiling recomputed, **no auto-raise** |
| `offer.retired.v1` | Inactive (withdraw); `unwilling` = never publishable |
| `demand.sourcing_started.v1` | post_requested = postAnonymously. If true, publish the demand post at Anonymous (the C-11 toggle is the user's click) |
| `demand.status_changed.v1` | leaves Sourcing → withdraw the post |
| `demand.exited.v1` | withdraw the post |
| `match.confirmed.v1` | withdraw the demand post for `demandId` |
| `records.merged.v1` | offer: `merge_log`, withdraw merged ids (reason `merged`), survivor unchanged. property: re-fetch scan terms. demand: withdraw the merged posts |
| `records.merge_undone.v1` | restore from `merge_log` (capped by the current ceiling) |
| `vocabulary.released.v1` | fetch the release (records `GET /v1/vocabulary`, service token) → `vocabulary_release`; `projection-refresh` if label rules changed |
| `micromarkets.updated.v1` | fetch the hierarchy (records `GET /v1/micromarkets`) → recompute `public_item.micromarket_path` (`projection-refresh`) |

## 6. Error codes
| Code | HTTP | Where | Meaning |
|---|---|---|---|
| validation-failed | 400 | all | Schema or field validation |
| unknown-vocabulary-value | 400 | public filters, staff | Filter value not in the active release (stored values only; labels rejected) |
| sort-requires-deal-type | 400 | GET /v1/listings | priceAsc/priceDesc without dealType |
| invalid-cursor | 400 | lists | Cursor tampered with or from another query |
| unauthenticated / invalid-api-key | 401 | staff / public | Missing or invalid token / key (revoked or expired keys too; no distinction, to avoid key probing) |
| forbidden | 403 | staff | Role not allowed |
| not-found | 404 | all | Unknown subject, or public ID not currently published |
| level-above-ceiling | 409 | PUT publication, demand post | Requested level > ceiling. `errors[]` = reasons |
| subject-not-publishable | 409 | PUT | Non-publishable subject (retired unwilling, merged away) |
| key-already-rotating | 409 | rotate | The key is already in rotation |
| idempotency-key-reused | 409 | POST | Same key, different body |
| change-feed-expired | 410 | /v1/changes | `since` older than 30 days |
| version-mismatch | 412 | PUT | If-Match mismatch |
| privacy-scan-blocked | 422 | PUT | Blocking findings (kinds and offsets in `errors[]`) |
| rera-missing | 422 | PUT | Agent number or project RERA number missing |
| rate-limited | 429 | all | Token bucket empty (`Retry-After`) |
| internal / dependency-unavailable | 500 / 503 | all | |

## 7. PII fields and retention
- listings stores **no contact PII**: no names, phones, e-mails or raw text. Events carry none, and the projection
  allow-list excludes them.
- **Sensitive (not public):**
  - `private_term.token_hash`: salted hashes from records scan-terms (R-20). listings never holds the plain names.
    Refreshed or deleted with the property (merge/purge → refresh) and never logged.
  - `publication.public_description`: staff free text. It may contain PII if typed. It's blocked from publication by
    the scan, **marked `-- PII-possible`**, never logged, kept while the subject exists, and cleared when the offer is
    purged.
- `privacy_scan.findings`: offsets and kinds only. Kept 90 days (the latest per subject is kept while the subject exists).
- `api_key.key_hash`: a secret-derived hash. Revoked keys are kept 1 year for audit.
- Photos: EXIF/GPS is stripped. Public copies exist only while the item is Public and the photo is selected.
- `change_feed`: 30 days. `processed_events`: 30 days. `idempotency_key`: 24 h.
- NFR-18: when records purges personal data, listings holds none. Offers that are purged in records arrive as
  `offer.retired`/merges, and their rows follow within the event flow.
- M8 = 0 is checked by the **contract test** (the allow-list), the **privacy scan**, and a nightly **output audit**
  (job, part of `ceiling-sweep`) that re-runs the §4.4 patterns on every `public_item.payload` and alarms on any hit.

## 8. Performance (NFR-1, NFR-2, NFR-10; pilot §8.4)
- **Main 1,000 rps consumer** (paid plans). The website and microsites call `/v1/listings*`, `/v1/projects*` and
  `/v1/demand-posts` directly.
- **Edge cache:** `Cache-Control: public, s-maxage=20, stale-while-revalidate=10`, `Vary: X-Api-Key`. With a few keys
  and repeating queries (the website's home, locality and project pages), the expected hit ratio is ≥ 70%, so ≤ 300 rps
  reach functions.
- **Miss path:** API-key auth (in-memory positive cache, 30 s) → token bucket → one index-ordered query on
  `public_item` returning `payload` jsonb (no joins) → JSON.
  - Target: p95 ≤ 60 ms DB, ≤ 120 ms function, well under 300 ms (NFR-2).
  - Little's law: 300 rps × 0.06 s ≈ 18 concurrent DB queries, within the production cap of 20 connections for
    `listings_svc` (data-hosting §5). Above that the `libs` semaphore queues for ≤ 50 ms. The Medium trigger is in
    data-hosting §6.
- **Rate-limit writes:** each instance leases 10 tokens per DB round trip, so at 300 rps that's ≤ 30 writes/s per key,
  on a single row, with sub-millisecond UPDATEs.
- **Staff routes:** low volume. p95 ≤ 300 ms. The PUT with the scan is ≤ 150 ms: the scan is pure CPU on ≤ 2,000
  characters plus one hash-index lookup batch.
- **Freshness:** §4.9. pg_cron runs the listings relay and drains every **20 s** as the backstop for failed pokes
  (supported by pg_cron ≥ 1.5; verified in the foundation task).
- **Pilot (CR-005):** best effort. The pooler cap is 4 connections, Hobby function limits apply, and the same caching
  applies. The website isn't live during the pilot (the paid-plan gate), so public traffic is test traffic only.
- **Load test** (capacity plan): 1,000 rps mix of 70% list (varied filters), 25% detail, 5% changes, over 50k published
  items, with a cold-cache phase to prove the miss path.

## 9. Endpoint summary
| Method | Path | Auth | Roles | Idempotency | Paginated | Rate limit | Timeout | Emits |
|---|---|---|---|---|---|---|---|---|
| GET | /v1/offers/{idOrCode}/publication | staffViaWeb | all staff | safe | — | web user 20/s | 2 s | — |
| PUT | /v1/offers/{idOrCode}/publication | staffViaWeb | Admin, Mgr, Supply | PUT + If-Match | — | web user | 2 s | publication.changed.v1, audit.recorded.v1 |
| POST | /v1/offers/{idOrCode}/privacy-scan | staffViaWeb | Admin, Mgr, Supply | Idempotency-Key | — | web user | 2 s | — |
| GET | /v1/projects/{idOrCode}/publication | staffViaWeb | all staff | safe | — | web user | 2 s | — |
| PUT | /v1/projects/{idOrCode}/publication | staffViaWeb | Admin, Mgr, Supply | PUT + If-Match | — | web user | 2 s | publication.changed.v1, audit.recorded.v1 |
| GET | /v1/demands/{idOrCode}/demand-post | staffViaWeb | all staff | safe | — | web user | 2 s | — |
| PUT | /v1/demands/{idOrCode}/demand-post | staffViaWeb | Admin, Mgr, Demand | PUT + If-Match | — | web user | 2 s | publication.changed.v1, audit.recorded.v1 |
| GET | /v1/publications | staffViaWeb | all staff | safe | cursor ≤ 100 | web user | 2 s | — |
| GET | /v1/publication-settings | staffViaWeb | all staff | safe | — | web user | 2 s | — |
| PUT | /v1/publication-settings | staffViaWeb | Admin | PUT + If-Match | — | web user | 2 s | audit.recorded.v1 |
| GET | /v1/api-keys | staffViaWeb | Admin | safe | cursor ≤ 100 | web user | 2 s | — |
| POST | /v1/api-keys | staffViaWeb | Admin | Idempotency-Key (no secret on replay) | — | web user | 2 s | audit.recorded.v1 |
| POST | /v1/api-keys/{keyId}/rotate | staffViaWeb | Admin | Idempotency-Key | — | web user | 2 s | audit.recorded.v1 |
| POST | /v1/api-keys/{keyId}/revoke | staffViaWeb | Admin | natural + Idempotency-Key | — | web user | 2 s | audit.recorded.v1 |
| GET | /v1/listings | websiteApiKey | Website client | safe | cursor ≤ 50 | 50/s burst 100 per key | 2 s | — |
| GET | /v1/listings/{publicId} | websiteApiKey | Website client | safe | — | per key | 2 s | — |
| GET | /v1/projects | websiteApiKey | Website client | safe | cursor ≤ 50 | per key | 2 s | — |
| GET | /v1/projects/{publicId} | websiteApiKey | Website client | safe | — | per key | 2 s | — |
| GET | /v1/demand-posts | websiteApiKey | Website client | safe | cursor ≤ 50 | per key | 2 s | — |
| GET | /v1/changes | websiteApiKey | Website client | safe | seq cursor ≤ 100 | per key | 2 s | — |
| POST | /internal/v1/relay | cronSecret | scheduler | idempotent | — | — | 55 s | publication.changed.v1, audit.recorded.v1 (relayed) |
| POST | /internal/v1/drain/{queue} | cronSecret | scheduler | processed_events | batch ≤ 200 | — | 55 s | publication.changed.v1, audit.recorded.v1 |
| POST | /internal/v1/jobs/{name} | cronSecret | scheduler | resumable | — | — | 55 s | publication.changed.v1 |
| GET | /health/live | none | — | safe | — | — | 0.5 s | — |
| GET | /health/ready | none | — | safe | — | — | 1 s | — |

## 10. Contract gaps, assumptions, open questions

### Closed by events v0.2 and conventions §10
| Former gap | Resolution |
|---|---|
| G-1 project events | `project.created/updated.v1` consumed |
| G-2 demand facts | listings consumes `demand.created/updated.v1` |
| G-3 photos | `photo.added.v1` has storagePath + hasTextDetected; `photo.removed.v1`; offer `selectedPhotoIds` |
| G-4 public fields | floorBand, totalFloors, parking, amenities in offer facts (publicDescriptionSource: see OQ-L4) |
| G-5 scan terms | records `GET /internal/v1/properties/{id}/scan-terms` (R-20) |
| G-6 `offer.closed.v1` | superseded (R-19) |
| G-7 reasons | `publication.changed.v1` reason has `merged`, `voided` |
| G-8 hierarchy | `micromarkets.updated.v1` consumed |
| G-9 system actor | `00000000-0000-0000-0000-000000000001` (R-7) |
| Rate limits | R-1: listings enforces the public per-key limits |
| Photo text | R-8: warning only (former A-L2 removed) |

### Remaining gaps
| # | Gap | Proposal |
|---|---|---|
| L-1 | `project.*` events carry `developerPersonId`, not a developer **name**. PRD §8.3 shows the developer name on project items. | Add an additive `developerName` (a company name, not contact PII) to `project.created/updated.v1`. Until then `developerName` is null. |
| L-2 | `photo.added.v1.storagePath` points into records' private bucket. listings has no grant on it and there's no records endpoint for a signed download URL. | records to expose `GET /internal/v1/photos/{id}/download-url` (serviceToken), or a Storage policy granting `listings_svc` read access to that bucket. |
| L-3 | The scan-terms response must state the salt/key id so listings can hash text n-grams the same way. `records.yaml` doesn't have the endpoint yet (the records agent is aligning in parallel). | Confirm the response shape `{saltKeyId, salt?, terms:[{kind, ngram, hash}]}` with records. |

### Assumptions
- **A-L1** At Stale, the ceiling is Anonymous for items already published (so Public drops to Anonymous per BRD §4.5),
  but Private items can't be *newly* published at Stale ("Anonymous while Fresh or Ageing").
- **A-L3** Projects have no Anonymous level: the project name identifies it. Configuration offers can still be
  Anonymous individually.
- **A-L4** A supply Sale with a blank market is labelled "For Sale" (the BRD table has no row for it).
- **A-L5** MahaRERA agent number format `A` + 11 digits.
- **A-L6** Offers that are part of a project also appear in `/v1/listings` with `projectPublicId`.
- **A-L8** Demand-post budgets are shown as rounded bands, never the exact budget.

### Open questions
- **OQ-L2** Should a rotated key's grace period default to 7 days?
- **OQ-L3** NFR-10 (≤ 1 min) holds at p95 (~46 s). If both pokes fail, the 20 s backstops give a worst case of ~71 s.
  The options are to accept this as a rare tail, or to run the listings backstops every 10 s.
- **OQ-L4** `publicDescriptionSource` (records' free source text) isn't fetched in Phase 1, because source text can
  hide contacts. The public description is generated from fields or written by staff in C-12. Confirm that this is
  acceptable.
