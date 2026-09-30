# 04 — LLD: `records` service (S2)

| | |
|---|---|
| Version | 0.2 (draft; aligned to events v0.2 and conventions §10) |
| Date | 2026-09-24 |
| Based on | HLD v0.2 §2 S2, §5, §6, §7 (merge saga); ADR-0003/0006; PRD v0.6 §2.3, §3 (incl. 3.6a), US-04…09, US-13, US-17, US-36, US-37, D-1, D-5, D-14, D-16, NFR-13/15/18; BRD v0.6.1 §4.1–4.2, dedup rules (§9); CR-006 Z-2…Z-8 |
| Contract | [`contracts/openapi/records.yaml`](../../contracts/openapi/records.yaml) (68 operations) · events: [`contracts/asyncapi/events.yaml`](../../contracts/asyncapi/events.yaml) |
| Shared rules | [`conventions.md`](conventions.md) incl. §10 reconciliation decisions R-1…R-22 (they override this document); events catalogue v0.2 |
| Status | IN PROGRESS (Stage 4) |

---

## 1. Purpose and scope

records is the **single source of truth for what exists and which records are the same**: properties, projects, offers,
demands, people, enquiries, touches, sightings, source ads and splits, second sources, merges (with undo), desk items
(Business, Capital, Equipment/Archive, Watchlist; Network = people with a participant_role), photos (metadata), market data
points, the **controlled vocabulary releases** and the **micromarket hierarchy / launch area**.

Not owned here: life curve, Commercial axis, queues, exits, deals (journeys); publication level (listings; records keeps a
read-only cache from `publication.changed.v1`); matches (crm-engine); uploads, raw rows and classification review (intake).

---

## 2. Internal module layout

TypeScript on Vercel Functions assumed (confirmed in Stage 6).

```
services/records/
  src/
    domain/                        # pure
      property/    Property, Offer (one dealType each), OfferFacts, PriceFields, DealTags, RecordStage (transitions),
                   DisplayLabel (generated label builder, BRD §4.2), FloorBand
      project/     Project, PriceSheet, ConfigurationMatcher
      demand/      Demand, Touch (first-touch rule), StatedTags
      person/      Person, PhoneNumber (E.164 normaliser), ContactMask, PartyRole, PersonFlag
      intake/      RowRouting (scope/side → record kinds), OfferSplitter (deal_type list → offers), RowFactsMapper
      dedup/       PropertyMatcher (scores), DemandMatcher (scores), BuildingNormaliser, SplitSiblingRule,
                   ExtractorTrustRule, Thresholds
      merge/       MergePlan (what moves), UndoLog, MergeGuards
      source/      SourceAd, Sighting, SecondSource (price-gap > 5%)
      desk/        DeskItem, DeskRouting
      reference/   VocabularyRelease (validator), MicromarketTree (alias resolution), LaunchArea (outside-MMR rule)
      market/      MarketDataPoint
      codes/       CodeFormat (prefix + zero padding)
      ports.ts     Clock, IdGenerator, KeyedHash (phone/email hashing)
    application/
      ports.ts     PropertyRepo, OfferRepo, ProjectRepo, DemandRepo, PersonRepo, TouchRepo, EnquiryRepo, SourceAdRepo,
                   SightingRepo, IngestionRepo (ingested_records, upload ledgers), MergeRepo, CandidateRepo, DeskRepo,
                   PhotoRepo, MarketDataRepo, ReferenceRepo, CodeIssuer, Outbox, UnitOfWork, IntakeRowsClient,
                   PhotoStore (signed URLs, head/verify), ImageFetcher, IdempotencyStore, AuditEmitter (outbox)
      offers/      CreateOffer, PatchOffer, ChangeOfferRecordStage, SetOfferPhotos, List/GetOffer
      properties/  CreateProperty, PatchProperty, CheckDuplicates, ListSightings, ListSecondSources, ResolveSecondSource
      projects/    CreateProject, PatchProject, ApplyPriceSheet
      demands/     CreateDemand, PatchDemand, ChangeDemandRecordStage, AddTouch, AddSupplyForDemand
      people/      CreatePerson, PatchPerson, FlagPerson
      quickadd/    QuickAddLookup, QuickAdd
      reveal/      RevealContact
      ingestion/   IngestBatch (rows.classified.v1), ApplyMigrationMap, ApplyReviewResolution, ResolvePendingRepeats
      merges/      ListCandidates, DismissCandidate, MergeRecords, UndoMerge
      desks/       ListDesk, PatchDeskItem
      reference/   GetVocabulary, ActivateVocabulary, Micromarket CRUD, Get/PutLaunchArea, RecomputeLaunchArea
      photos/      RequestPhotoUpload, AttachPhoto, FetchSheetPhoto
      reactions/   OnOfferConfirmed, OnSiteVisitCompleted, OnDealClosed, OnDealCancelled, OnOfferRetired,
                   OnLeaseRenewalDue, OnPublicationChanged, OnDemandExited, OnDemandReactivated, OnCallLogged
      internal/    GetScanTerms (R-20), GetContactsBatch (R-21)
      jobs/        RetentionPurge, ExpireIdempotencyKeys, ReconcileCounters
    adapters/
      http/        handlers generated from records.yaml, auth (role + tenant + ownership re-checks), RFC 7807, correlation
      db/          Postgres repositories (Supavisor, transaction mode), keyset pagination helper, UnitOfWork
      intake/      IntakeRowsClient (GET intake /internal/v1/uploads/{id}/rows|migration-map, 2 s, 3 retries, breaker)
      auth/        ServiceTokenClient (mints aud=intake tokens at web POST /internal/v1/service-tokens) and JWKS verifier (web
                   /.well-known/jwks.json, cached 10 min) for inbound service calls (R-2)
      storage/     Supabase Storage (bucket records-photos)
      images/      ImageFetcher for sheet links (5 concurrent per host, 2 s timeout, 10 MB cap)
      queue/       outbox relay + drains (libs/outbox)
    main.ts        composition root
  vocabulary/      release files (v0.6.json …) loaded by migrations
  migrations/      forward-only SQL
  tests/           unit (dedup scoring, merge/undo plans, routing, labels, codes, masks), integration (repos, pgmq, storage),
                   contract (OpenAPI + AsyncAPI), tenancy (NFR-15), ingestion replay with the PII-free extractor fixture
  Dockerfile  README.md
```

---

## 3. Data schema (schema `records`, role `records_svc`)

Common columns unless stated: `id uuid` PK (UUIDv7), `tenant_id uuid not null`, `created_at`, `updated_at timestamptz not null`,
`version int not null default 1` on mutable aggregates. `-- PII` marks personal data. Extension `btree_gin` is used so GIN
indexes can start with `tenant_id`. `*_norm` columns are lower-cased, punctuation-stripped, whitespace-collapsed copies used
for matching. Keyset pagination always orders by `(sort column, id)`.

### 3.1 `code_sequences`
| Column | Type | Null | Notes |
|---|---|---|---|
| tenant_id | uuid | no | PK part |
| prefix | text | no | PK part: `PRP`,`PRJ`,`INV`,`DEM`,`PER`,`ENQ`,`BIZ`,`CAP`,`EQP`,`WCH`,`AD` |
| next_value | bigint | no | |
| pad | int | no | PRP 5, PRJ 4, INV 5, DEM 6, PER 6, ENQ 6, BIZ/CAP/EQP/WCH 4, AD 6 (grows past the pad naturally) |

Index: PK (tenant_id, prefix) → `UPDATE code_sequences SET next_value = next_value + $n WHERE tenant_id=$1 AND prefix=$2 RETURNING next_value - $n`.

### 3.2 `persons`
| Column | Type | Null | Notes |
|---|---|---|---|
| code | text | no | `PER-000812` |
| name | text | yes | -- PII |
| name_initials | text | yes | derived mask (`S. K.`), not PII by itself |
| company_name | text | yes | |
| company_norm | text | yes | |
| party_type | text | yes | vocabulary `party_type` |
| participant_role | text | yes | vocabulary `participant_role` (Network) |
| other_contact | text | yes | -- PII |
| flags | text[] | no | default `{}`; `invalid`,`broker_posing`,`unwilling`,`anonymous_shares_only`,`unreachable` |
| dependencies | jsonb | no | default `[]`; `{text, offerId, demandId}` |
| status | text | no | `active`/`merged` |
| merged_into_id | uuid | yes | FK → persons.id |
| last_activity_at | timestamptz | no | NFR-18 retention anchor (§7) |
| purged_at | timestamptz | yes | contacts erased |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, code) | `GET /v1/people/{code}` |
| (tenant_id, updated_at desc, id desc) WHERE status='active' | `GET /v1/people` default order |
| (tenant_id, party_type, updated_at desc, id desc) WHERE status='active' | `?partyType=` |
| (tenant_id, participant_role, updated_at desc, id desc) WHERE participant_role IS NOT NULL AND status='active' | `?participantRole=`; `GET /v1/desks/network` |
| GIN (tenant_id, flags) | `?flag=` |
| (tenant_id, company_norm text_pattern_ops) WHERE company_norm IS NOT NULL | `?companyName=` prefix; demand dedup company evidence |
| (tenant_id, last_activity_at) WHERE purged_at IS NULL | retention-purge |

### 3.3 `person_phones`, `person_emails`
| Column | Type | Null | Notes |
|---|---|---|---|
| person_id | uuid | no | FK → persons.id |
| phone_e164 / email | text | no | -- PII |
| phone_hash / email_hash | text | no | HMAC-SHA256(tenant key, normalised value), hex |
| kind (phones only) | text | no | `phone`/`whatsapp` |
| is_primary | boolean | no | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, phone_hash, person_id) / UNIQUE (tenant_id, email_hash, person_id) | no duplicate contact on one person |
| (tenant_id, phone_hash) / (tenant_id, email_hash) | quick-add lookup, person dedup at ingestion `WHERE tenant_id=$ AND phone_hash = ANY($hashes)` |
| (tenant_id, person_id) | load a person's contacts (reveal, merge, purge) |

A phone belongs to at most one **active** person: enforced in the application inside the creating transaction with
`SELECT … FOR UPDATE` on the hash rows (a merged person's rows are moved to the survivor).

### 3.4 `properties`
| Column | Type | Null | Notes |
|---|---|---|---|
| code | text | no | `PRP-00210` |
| segment | text | yes | vocabulary |
| property_types | text[] | no | default `{}` |
| property_detail | text | yes | |
| land_use | text | yes | Land only |
| locality, locality_norm | text | yes | |
| micromarket_id | uuid | yes | FK → micromarkets.id (resolved from locality aliases) |
| city, city_norm, state | text | yes | |
| landmark, location_text | text | yes | |
| building_name | text | yes | private (proposals only) |
| building_norm | text | yes | normalised: strips "CHS", "society", "building", "tower", "apartments", punctuation |
| wing | text | yes | -- PII (unit-level) |
| unit_no | text | yes | -- PII |
| floor_no | int | yes | -- PII (exact floor) |
| floor_band | text | yes | `Low`/`Mid`/`High` derived from floor_no/total_floors (A-43) |
| parking | int | yes | parking spaces (public field) |
| building_key | text | yes | HMAC(tenant key, building_norm + micromarket_id): opaque building identity carried in offer facts (`buildingKey`) |
| total_floors | int | yes | |
| area_sqft_min, area_sqft_max | numeric(12,2) | yes | |
| area_basis | text | yes | `Carpet`/`Builtup`/`Saleable`/null (Z-2) |
| land_area_value | numeric(14,4) | yes | |
| land_area_unit | text | yes | |
| land_area_sqft | numeric(14,2) | yes | |
| area_text | text | yes | |
| bhk_min, bhk_max | numeric(3,1) | yes | 0.5 = 1 RK |
| features | text | yes | |
| amenities | text[] | no | default `{}` |
| project_id | uuid | yes | FK → projects.id |
| outside_launch_area | boolean | no | §4.9 |
| photo_count | int | no | default 0 |
| has_real_photos | boolean | no | default false |
| staff_edited_fields | text[] | no | fields a person changed; re-uploads never overwrite them (§4.3) |
| last_seen_at | timestamptz | yes | |
| status | text | no | `active`/`merged` |
| merged_into_id | uuid | yes | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, code) | get by code |
| (tenant_id, micromarket_id, building_norm) WHERE status='active' AND building_norm IS NOT NULL | property dedup with a building (§4.4) |
| (tenant_id, micromarket_id, segment, bhk_min, area_sqft_min) WHERE status='active' | property dedup without a building (area ±5% range scan) |
| (tenant_id, locality_norm, segment, area_sqft_min) WHERE status='active' AND micromarket_id IS NULL | dedup outside the hierarchy (outside MMR / unresolved locality) |
| (tenant_id, building_norm text_pattern_ops) WHERE building_norm IS NOT NULL | `GET /v1/properties?buildingName=` prefix |
| (tenant_id, building_key) WHERE building_key IS NOT NULL | same-building lookups (bundles support, scan-terms by building) |
| (tenant_id, micromarket_id, updated_at desc, id desc) | `GET /v1/properties?micromarketId=` (descendants expanded to an id list, ≤ 200) |
| (tenant_id, segment, updated_at desc, id desc) | `?segment=` |
| GIN (tenant_id, property_types) | `?propertyType=` |
| (tenant_id, city_norm, updated_at desc, id desc) | `?city=`; launch-area recompute by city |
| (tenant_id, project_id) WHERE project_id IS NOT NULL | project configurations; `?projectId=` |
| (tenant_id, updated_at desc, id desc) | default list and `updatedSince` (projection rebuilds) |
| (tenant_id, outside_launch_area, updated_at desc, id desc) | `?outsideLaunchArea=` |

### 3.5 `offers`
| Column | Type | Null | Notes |
|---|---|---|---|
| code | text | no | `INV-00452` |
| property_id | uuid | no | FK → properties.id |
| project_id | uuid | yes | FK → projects.id (configuration offers) |
| deal_type | text | no | exactly one (Sale/Lease/JV/Pagdi) |
| market | text | yes | Sale only |
| sale_price_inr_min, sale_price_inr_max, sale_rate_inr | bigint | yes | |
| sale_rate_unit | text | yes | |
| rent_monthly_inr_min, rent_monthly_inr_max, deposit_inr, current_rent_inr | bigint | yes | |
| rent_rate_psf, yield_pct | numeric(10,2) | yes | |
| deposit_months | int | yes | |
| price_negotiable | boolean | yes | |
| price_text | text | yes | |
| sale_mode, tenancy_status, tenure, agreement_form, possession_status, furnishing | text | yes | deal tags (vocabulary) |
| deadline_date | date | yes | |
| is_jodi | boolean | yes | |
| possession_date | text | yes | `YYYY`/`YYYY-MM`/`YYYY-MM-DD` |
| possession_date_start | date | yes | first day of the stated period (sort/filter) |
| description | text | yes | staff-editable description -- PII-sensitive (free text); listings sanitises before public use |
| revenue_share_text | text | yes | |
| revenue_share_pct | numeric(5,2) | yes | |
| unit_count | int | yes | projects |
| record_stage | text | no | `Captured`…`Qualified` |
| publication_level | text | no | cache from `publication.changed.v1`, default `Private` |
| publication_version | bigint | no | last applied event aggregateVersion |
| source_type | text | no | `Channel`/`Digi`/`Direct` |
| capture_mode | text | no | `uploaded`/`typed_in` |
| side_evidence | text | yes | may quote ad text; not returned to Website; staff-visible |
| needs_review | boolean | no | |
| review_reason | text | yes | |
| review_reason_code | text | yes | |
| route_to_suggestion | text | yes | extractor `route_to` (Z-8) |
| sourced_for_demand_id | uuid | yes | FK → demands.id (Add supply) |
| owner_user_id | uuid | yes | supply owner |
| ingested_record_id | uuid | yes | FK → ingested_records.id |
| source_ad_id | uuid | yes | FK → source_ads.id (first ad) |
| first_seen_date | date | yes | |
| last_seen_at | timestamptz | yes | max(extractor last_seen_date, sightings) |
| times_seen | int | no | default 1 |
| enquiry_count, sighting_count, second_source_count | int | no | default 0; signals counters |
| has_price_gap | boolean | no | default false |
| closed_at, retired_at | timestamptz | yes | from deal.closed / offer.retired (market data context only) |
| renewal_of_offer_id | uuid | yes | set on the Upcoming offer created from `lease_renewal.due.v1` |
| retired_reason | text | yes | |
| staff_edited_fields | text[] | no | §4.3 |
| status | text | no | `active`/`merged`/`voided` |
| void_reason | text | yes | `side_changed`/`scope_changed`/`duplicate_discarded` |
| merged_into_id | uuid | yes | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, code) | get by code, `?code=` |
| UNIQUE (tenant_id, property_id, deal_type) WHERE status='active' AND project_id IS NULL | one offer per deal type per property (409 deal-type-exists) |
| (tenant_id, property_id) | property panel offers, merge re-pointing |
| (tenant_id, project_id) WHERE project_id IS NOT NULL | project configurations, price-sheet matching |
| (tenant_id, deal_type, updated_at desc, id desc) WHERE status='active' | `GET /v1/offers?dealType=` |
| (tenant_id, deal_type, market, updated_at desc, id desc) WHERE status='active' | `?dealType=Sale&market=` |
| (tenant_id, record_stage, updated_at desc, id desc) WHERE status='active' | `?recordStage=` |
| (tenant_id, publication_level, updated_at desc, id desc) WHERE status='active' | `?publicationLevel=` |
| (tenant_id, owner_user_id, updated_at desc, id desc) WHERE status='active' | `?ownerUserId=` |
| (tenant_id, source_type, updated_at desc, id desc) WHERE status='active' | `?sourceType=` |
| (tenant_id, sourced_for_demand_id) WHERE sourced_for_demand_id IS NOT NULL | `?sourcedForDemandId=` (demand panel "Sourcing" tab) |
| (tenant_id, deal_type, sale_price_inr_min) WHERE status='active' AND deal_type IN ('Sale','Pagdi') | `?priceInrMin/Max=` for sale |
| (tenant_id, deal_type, rent_monthly_inr_min) WHERE status='active' AND deal_type='Lease' | `?priceInrMin/Max=` for lease |
| (tenant_id, needs_review, updated_at desc, id desc) WHERE needs_review | `?needsReview=true` |
| (tenant_id, has_price_gap) WHERE has_price_gap | `?hasPriceGap=true` |
| (tenant_id, updated_at desc, id desc) | default list, `updatedSince` (projection rebuilds by listings/journeys/crm-engine) |
| (tenant_id, ingested_record_id) | re-upload updates, migration re-key |
| UNIQUE (tenant_id, renewal_of_offer_id, possession_date) WHERE renewal_of_offer_id IS NOT NULL | idempotent lease-renewal handling |
| (tenant_id, tenancy_status/sale_mode/furnishing/possession_status, updated_at desc, id desc) WHERE value IS NOT NULL — four partial indexes | deal-tag filters (dashboards drill-down) |

Filters on property facts (segment, propertyType, micromarket, city, bhk, area, outsideLaunchArea) join `properties` on
`property_id` and use the property indexes (§3.4) as the driving index, then the offer PK; the planner is steered by the query
builder picking the most selective supplied filter as the driving index. Unsupported combinations use the default order index
with a 2 s statement timeout (bounded by `limit`).

### 3.6 `offer_photos`
Columns: tenant_id, offer_id (FK offers), photo_id (FK photos), sort int. PK (tenant_id, offer_id, photo_id).
Indexes: PK → photos of an offer; (tenant_id, photo_id) → offers using a photo (photo delete/merge).

### 3.7 `projects` and `price_sheets`
| Column | Type | Null | Notes |
|---|---|---|---|
| projects.code | text | no | `PRJ-0031` |
| projects.name, name_norm | text | no | |
| projects.developer_person_id | uuid | yes | FK persons (party_type Developer) |
| projects.developer_name | text | yes | as captured |
| projects.locality, locality_norm, city, city_norm, state, landmark, location_text | text | yes | |
| projects.micromarket_id | uuid | yes | |
| projects.rera_number | text | yes | required before publishing (listings checks) |
| projects.possession_date | text | yes | |
| projects.amenities | text[] | no | |
| projects.floor_plan_photo_ids | uuid[] | no | |
| projects.latest_price_sheet_date | date | yes | |
| projects.publication_level, publication_version | text, bigint | no | cache |
| projects.outside_launch_area | boolean | no | |
| price_sheets.project_id | uuid | no | FK projects |
| price_sheets.sheet_date | date | no | |
| price_sheets.received_via | text | yes | |
| price_sheets.lines | jsonb | no | snapshot of applied lines |
| price_sheets.created_offers, updated_offers, price_changed_offers | uuid[] | no | |
| price_sheets.created_by | uuid | no | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, code) on projects | get by code |
| UNIQUE (tenant_id, developer_person_id, name_norm, micromarket_id) on projects | 409 project-exists; project match at ingestion (`project_name`) |
| (tenant_id, name_norm text_pattern_ops) on projects | ingestion match by name when developer unknown |
| (tenant_id, micromarket_id, updated_at desc, id desc) on projects | `GET /v1/projects?micromarketId=` |
| (tenant_id, updated_at desc, id desc) on projects | default list, `updatedSince` |
| (tenant_id, developer_person_id) on projects | `?developerPersonId=` |
| (tenant_id, (rera_number IS NOT NULL), updated_at desc, id desc) on projects | `?hasRera=` |
| (tenant_id, project_id, sheet_date desc, id desc) on price_sheets | `GET …/price-sheets`; stale-sheet check |

### 3.8 `demands`
| Column | Type | Null | Notes |
|---|---|---|---|
| code | text | no | `DEM-000127` |
| person_id | uuid | yes | FK persons (client) |
| company_norm | text | yes | dedup evidence |
| deal_types | text[] | no | one or more |
| market | text | yes | Primary/Secondary/Any (Sale only) |
| segment | text | yes | |
| property_types | text[] | no | |
| micromarket_ids | uuid[] | no | |
| localities | text[] | no | as stated |
| budget_inr_min, budget_inr_max, rent_monthly_inr_min, rent_monthly_inr_max | bigint | yes | |
| area_sqft_min, area_sqft_max | numeric(12,2) | yes | |
| area_basis | text | yes | |
| bhk_min, bhk_max | numeric(3,1) | yes | |
| move_in_from | date | yes | earliest move-in (v0.2 `moveInFrom`) |
| move_in_by | date | yes | |
| move_in_text | text | yes | |
| stated_tags | jsonb | no | default `{}` |
| decision_maker | text | yes | role text only |
| introducing_broker_person_id | uuid | yes | FK persons |
| shared_commission_note | text | yes | |
| shared_commission_pct | numeric(5,2) | yes | |
| record_stage | text | no | `Captured`…`Qualified` |
| publication_level, publication_version | text, bigint | no | cache (`demand_post`) |
| owner_user_id | uuid | yes | demand agent |
| source_type, capture_mode | text | no | of the first touch |
| side_evidence, review_reason, review_reason_code | text | yes | |
| needs_review | boolean | no | |
| first_touch_id | uuid | yes | FK touches |
| touch_count | int | no | default 1 |
| ingested_record_id, source_ad_id | uuid | yes | |
| outside_launch_area | boolean | no | §4.9 |
| closed_at | timestamptz | yes | from deal.closed.v1 (dedup ignores closed demands) |
| exit_state | text | yes | `Lost`/`Dormant`/`Invalid` from `demand.exited.v1`; cleared by `demand.reactivated.v1` |
| exit_version | bigint | no | last applied journeys aggregateVersion for exits |
| staff_edited_fields | text[] | no | |
| status | text | no | `active`/`merged`/`voided` |
| void_reason | text | yes | |
| merged_into_id | uuid | yes | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, code) | get by code |
| (tenant_id, person_id, created_at desc) WHERE status='active' | demand dedup by phone → person (§4.5); quick-add lookup "open demands"; `?personId=` |
| (tenant_id, company_norm, created_at desc) WHERE company_norm IS NOT NULL AND status='active' | demand dedup company evidence |
| (tenant_id, segment, updated_at desc, id desc) WHERE status='active' | `GET /v1/demands?segment=` |
| GIN (tenant_id, deal_types) / GIN (tenant_id, property_types) / GIN (tenant_id, micromarket_ids) | `?dealType=`, `?propertyType=`, `?micromarketId=` |
| (tenant_id, record_stage, updated_at desc, id desc) | `?recordStage=` |
| (tenant_id, owner_user_id, updated_at desc, id desc) | `?ownerUserId=` |
| (tenant_id, source_type, updated_at desc, id desc) | `?sourceType=` |
| (tenant_id, budget_inr_min) / (tenant_id, area_sqft_min) | budget / area range filters |
| (tenant_id, needs_review, updated_at desc, id desc) WHERE needs_review | `?needsReview=` |
| (tenant_id, updated_at desc, id desc) | default list, `updatedSince` |
| (tenant_id, outside_launch_area, updated_at desc, id desc) | `?outsideLaunchArea=` |
| (tenant_id, ingested_record_id) | re-upload updates |

### 3.9 `touches`
| Column | Type | Null | Notes |
|---|---|---|---|
| demand_id | uuid | no | FK demands |
| source_type | text | no | |
| capture_mode | text | no | |
| source_detail | text | yes | |
| occurred_at | timestamptz | no | |
| is_first_touch | boolean | no | exactly one per demand (partial unique) |
| source_ad_id, enquiry_id, referrer_person_id, upload_id, row_id | uuid | yes | lineage |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, demand_id) WHERE is_first_touch | first-touch invariant (A-16) |
| (tenant_id, demand_id, occurred_at, id) | `GET /v1/demands/{id}/touches` |
| UNIQUE (tenant_id, row_id, demand_id) WHERE row_id IS NOT NULL | idempotent ingestion (same row never adds two touches) |

### 3.10 `enquiries`
| Column | Type | Null | Notes |
|---|---|---|---|
| code | text | no | `ENQ-000331` |
| person_id | uuid | yes | |
| source_export | text | yes | upload source detail |
| campaign_ref, form_ref, listing_ref | text | yes | |
| offer_id, project_id, demand_id, touch_id | uuid | yes | links |
| message | text | yes | -- PII |
| received_at | timestamptz | no | |
| upload_id, row_id | uuid | yes | |

Indexes: UNIQUE (tenant_id, code); UNIQUE (tenant_id, row_id) WHERE row_id IS NOT NULL (idempotent ingestion);
(tenant_id, offer_id, received_at desc, id desc) → `?offerId=`; (tenant_id, project_id, received_at desc, id desc) →
`?projectId=`; (tenant_id, demand_id, received_at desc) → `?demandId=`; (tenant_id, campaign_ref, received_at desc) →
`?campaignRef=`; (tenant_id, received_at desc, id desc) → default list / `receivedSince`.

### 3.11 `record_parties`
Columns: subject_type (`property`/`offer`/`demand`/`project`/`desk_item`), subject_id, person_id, role (Seller, Landlord,
Broker, Developer, Client, Introducing broker, Contact, …), party_type_at_capture. Indexes: UNIQUE (tenant_id, subject_type,
subject_id, person_id, role) → idempotent linking and the property/demand panel parties; (tenant_id, person_id) → person panel
"linked offers and demands", merge re-pointing, property dedup phone evidence.

### 3.12 `source_ads`, `sightings`, `second_sources`
| Column | Type | Null | Notes |
|---|---|---|---|
| source_ads.code | text | no | `AD-001204` |
| source_ads.external_ref | text | no | parent_record_id, or record_id when not split |
| source_ads.source_channel, source_name, source_edition, source_supplement, source_files, source_language | text | yes | |
| source_ads.source_date | date | yes | |
| source_ads.source_page | int | yes | |
| source_ads.ocr_used | boolean | yes | |
| source_ads.extraction_confidence | numeric(3,2) | yes | |
| source_ads.extractor_notes | text | yes | may quote the ad; staff-only |
| source_ads.raw_text | text | yes | -- PII |
| source_ads.text_variants | text | yes | -- PII |
| source_ads.sender_name | text | yes | -- PII |
| source_ads.sender_phone | text | yes | -- PII |
| source_ads.sender_phone_hash | text | yes | |
| source_ads.split_count | int | no | number of children seen |
| sightings.subject_type, subject_id | text, uuid | no | offer/demand/property/person/desk_item |
| sightings.source_ad_id, upload_id, row_id | uuid | yes | |
| sightings.external_ref, split_index | text | yes | |
| sightings.source_type, source_name | text | yes | |
| sightings.seen_on | date | no | |
| second_sources.property_id | uuid | no | |
| second_sources.offer_id, source_ad_id, person_id | uuid | yes | |
| second_sources.source_type, source_name | text | yes | |
| second_sources.sale_price_inr_min/max, rent_monthly_inr_min/max | bigint | yes | |
| second_sources.price_gap_pct | numeric(6,2) | yes | |
| second_sources.price_gap | boolean | no | > 5% (A-39) |
| second_sources.status | text | no | `open`/`accepted`/`dismissed` |
| second_sources.seen_on | date | no | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, code) on source_ads | get by code |
| UNIQUE (tenant_id, external_ref) on source_ads | one ad per parent ref (Z-3); ingestion upsert; `?externalRef=` |
| (tenant_id, source_name, source_date desc, id desc) on source_ads | `GET /v1/source-ads?sourceName=&sourceDate=` |
| (tenant_id, created_at desc, id desc) on source_ads | default list; `?hasSplits=` filtered with `split_count > 1` on this index (bounded page) |
| (tenant_id, sender_phone_hash) on source_ads | WhatsApp sender → person resolution |
| (tenant_id, subject_type, subject_id, seen_on desc, id desc) on sightings | `GET /v1/properties/{id}/sightings` (property + its offers via `subject_id = ANY`) |
| UNIQUE (tenant_id, row_id, subject_type, subject_id) WHERE row_id IS NOT NULL on sightings | idempotent ingestion |
| (tenant_id, source_ad_id) on sightings | source ad children list |
| (tenant_id, property_id, seen_on desc, id desc) on second_sources | `GET /v1/properties/{id}/second-sources` |
| (tenant_id, status, price_gap, seen_on, id) on second_sources | `GET /v1/second-sources` price-gap queue |
| UNIQUE (tenant_id, property_id, source_ad_id) WHERE source_ad_id IS NOT NULL on second_sources | idempotent ingestion |

### 3.13 `ingested_records` (external-ref map, upsert key)
| Column | Type | Null | Notes |
|---|---|---|---|
| external_source | text | no | `extractor`/`upload` |
| external_ref | text | no | record_id or intake ref |
| parent_external_ref, split_index | text | yes | splits |
| record_scope | text | yes | |
| content_hash | text | no | last applied |
| primary_subject_type | text | yes | `offer`/`demand`/`desk_item`/`person`/`unrouted` |
| primary_subject_id | uuid | yes | offer (first) / demand / desk item / person |
| property_id | uuid | yes | supply rows |
| desk_item_id | uuid | yes | |
| source_ad_id | uuid | yes | |
| status | text | no | `active`/`rekeyed`/`merged`/`split` |
| replaced_by_refs | text[] | yes | migration map targets |
| last_upload_id, last_row_id | uuid | yes | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, external_source, external_ref) | per batch `WHERE external_ref = ANY($refs)` upsert lookup; migration map application; possible_repeat_of resolution |
| (tenant_id, parent_external_ref) WHERE parent_external_ref IS NOT NULL | split-sibling rule (siblings never auto-merged) |
| (tenant_id, primary_subject_type, primary_subject_id) | subject → ref (merge undo, support) |

### 3.14 `unrouted_rows`
Property rows whose side is blank (needs review) are held here until `review_item.resolved.v1` gives a side.
Columns: external_source, external_ref, upload_id, batch_no, row_id, row_snapshot jsonb (-- PII: the IntakeRow), status
(`waiting`/`routed`). Indexes: UNIQUE (tenant_id, external_source, external_ref) → resolution lookup; (tenant_id, status,
created_at) → reconcile/monitoring.

### 3.15 Merges
| Table | Columns | Index → query |
|---|---|---|
| `merge_candidates` | aggregate_type, left_id, right_id (null while pending), right_external_ref, pair_low, pair_high (ordered ids), reason (`possible_repeat`/`property_match`/`demand_similarity`/`person_phone`), score numeric(4,3), evidence jsonb (no PII values: field names and scores), status (`open`/`pending_target`/`merged`/`different`/`skipped`), upload_id, resolved_by, resolved_at | UNIQUE (tenant_id, aggregate_type, pair_low, pair_high) → never propose a pair twice, remembers `different`; (tenant_id, status, aggregate_type, score desc, id) → `GET /v1/merge-candidates`; (tenant_id, status, reason, score desc, id) → `?reason=`; (tenant_id, upload_id, status) → `?uploadId=`; (tenant_id, right_external_ref) WHERE status='pending_target' → resolve-pending-repeats |
| `merges` | aggregate_type, survivor_id, merged_ids uuid[], candidate_id, source (`user`/`migration_map`/`demand_dedup`), status (`active`/`undone`), moved_counts jsonb, performed_by, performed_at, undone_by, undone_at | (tenant_id, survivor_id, status) → undo-blocked check, record "merged from" history; GIN (tenant_id, merged_ids) → "was this record merged?" |
| `merge_undo_log` | merge_id, seq int, table_name, row_id, column_name, old_value jsonb, new_value jsonb, op (`update`/`insert`/`delete`) | PK (tenant_id, merge_id, seq) → undo replays in reverse seq |

### 3.16 `desk_items`
| Column | Type | Null | Notes |
|---|---|---|---|
| code | text | no | `BIZ-`/`CAP-`/`EQP-`/`WCH-` |
| desk | text | no | `business`/`capital`/`archive`/`watchlist` (network = persons) |
| record_scope | text | no | Business/Capital/Equipment/Market Signal |
| side | text | yes | |
| deal_types | text[] | no | |
| sector, includes_property, signal_type, party_type | text | yes | vocabulary |
| business_description | text | yes | -- PII-sensitive (may hold contacts from the ad) |
| business_description_redacted | text | yes | served in APIs |
| deadline_date | date | yes | |
| linked_property_id | uuid | yes | includes_property = Yes (D-14) |
| person_id | uuid | yes | |
| assignee_user_id | uuid | yes | Manager-assigned |
| archived_at | timestamptz | yes | |
| note | text | yes | |
| outside_launch_area | boolean | no | |
| ingested_record_id | uuid | yes | |

| Index / constraint | Serves |
|---|---|
| UNIQUE (tenant_id, code) | get by code |
| (tenant_id, desk, (archived_at IS NOT NULL), created_at desc, id desc) | `GET /v1/desks/{business|capital|archive}` |
| (tenant_id, desk, (archived_at IS NOT NULL), deadline_date, id) WHERE desk='watchlist' | Watchlist ordered by deadline (≤ 14 days first = `deadline_date` ascending from today, then the rest) |
| (tenant_id, desk, assignee_user_id, created_at desc, id desc) | `?assigneeUserId=` |
| (tenant_id, desk, sector, created_at desc, id desc) | `?sector=` |
| GIN (tenant_id, deal_types) | `?dealType=` |

### 3.17 `photos`, `market_data_points`
| Column | Type | Null | Notes |
|---|---|---|---|
| photos.property_id | uuid | no | |
| photos.origin | text | no | `call`/`visit`/`source_share`/`sheet_link`/`upload` |
| photos.is_real | boolean | no | |
| photos.status | text | no | `pending_upload`/`ready`/`fetch_failed`/`rejected` |
| photos.storage_path | text | no | `records-photos/{tenant}/{property}/{photo}` |
| photos.content_type, size_bytes, width, height, sha256 | … | yes | |
| photos.source_url | text | yes | sheet link |
| photos.fetch_error | text | yes | |
| photos.created_by | uuid | yes | |
| market_data_points.property_id, offer_id, deal_id, micromarket_id | uuid | yes | |
| market_data_points.locality, deal_type, segment, property_type, area_basis, source, notes | text | yes/no | source not null |
| market_data_points.price_inr, rent_monthly_inr | bigint | yes | |
| market_data_points.area_sqft | numeric(12,2) | yes | |
| market_data_points.observed_on | date | no | |
| market_data_points.voided_at | timestamptz | yes | deal cancelled |

Indexes: photos (tenant_id, property_id, created_at, id) → property photos list, 30-photo limit count; UNIQUE (tenant_id,
property_id, sha256) WHERE status='ready' → duplicate image guard; (tenant_id, status, created_at) WHERE status='pending_upload'
→ cleanup of abandoned tickets. market_data_points (tenant_id, micromarket_id, observed_on desc, id desc) → `?micromarketId=`;
(tenant_id, deal_type, segment, observed_on desc, id desc) → `?dealType=&segment=`; (tenant_id, observed_on desc, id desc) →
default list; UNIQUE (tenant_id, deal_id, source) WHERE deal_id IS NOT NULL → idempotent close handling.

### 3.18 Reference data
| Table | Columns | Index → query |
|---|---|---|
| `vocabulary_releases` | version, checksum, status (`pending`/`active`/`superseded`), content jsonb (fields, recordScopes, legacyTerms, displayLabels), activated_at | UNIQUE (tenant_id, version) → `GET /v1/vocabulary?version=`; UNIQUE (tenant_id) WHERE status='active' → active release; (tenant_id, activated_at desc, id desc) → versions list |
| `micromarkets` | parent_id, level, name, name_norm, aliases text[], aliases_norm text[], city, city_norm, in_launch_area | UNIQUE (tenant_id, level, name_norm, parent_id) → create conflicts; GIN (tenant_id, aliases_norm) → locality alias resolution (+ 409 micromarket-alias-taken); (tenant_id, parent_id, name_norm, id) → `?parentId=` and descendant expansion (recursive CTE, depth ≤ 4); (tenant_id, level, name_norm, id) → default list order and `?q=` prefix |
| `micromarket_adjacency` (R-13) | micromarket_id, adjacent_id (stored both directions) | PK (tenant_id, micromarket_id, adjacent_id) → `adjacentIds` on reads and in the crm-engine cache |
| `reference_versions` | kind (`micromarkets`), version bigint | PK (tenant_id, kind) → `micromarkets.updated.v1.version`, bumped in every hierarchy/alias/adjacency change |
| `launch_area_cities` | city_norm, name, enabled, version | UNIQUE (tenant_id, city_norm) → outside-launch-area rule; recompute diff |

### 3.19 Ingestion ledgers, consumer state and infrastructure
| Table | Columns | Index → query |
|---|---|---|
| `upload_batches` | upload_id, batch_no, status (`applied`), rows_applied, applied_at | UNIQUE (tenant_id, upload_id, batch_no) → batch-level idempotency (in addition to processed_events) |
| `upload_migrations` | upload_id, status (`applying`/`applied`), entries_applied, applied_at | UNIQUE (tenant_id, upload_id) → "is the map applied?" + advisory lock key |
| `inbound_versions` | aggregate_type, aggregate_id, last_version | PK (tenant_id, aggregate_type, aggregate_id) → ignore stale journeys/listings events (conventions §5) |
| `idempotency_keys` (per service, R-3) | tenant_id, user_id, route, key, request_hash, status_code, response_body jsonb (**for `/v1/reveals` only the auditId is stored, never the revealed fields**), expires_at | PK (tenant_id, user_id, route, key); (expires_at) → expiry job (technical table, R-4) |
| `outbox`, `processed_events` | per conventions §6 | outbox (published_at, occurred_at, id) WHERE published_at IS NULL → relay (technical table, R-4); processed_events PK (event_id), (processed_at) → purge after 30 days |

pgmq queues owned by records: `q_records` (all consumed events), `q_records_photo_fetch` (sheet-link photos), each with `_dlq`.

---

## 4. Business rules and algorithms

### 4.1 Codes and labels
- Codes are issued in the creating transaction from `code_sequences` (row lock per prefix). Ingestion reserves a block
  (`next_value += n`) per batch to avoid a hot row. Gaps are allowed; codes are never reused (merged records keep theirs).
- APIs accept `id` or `code` (`/v1/offers/{idOrCode}`); a code is recognised by its prefix pattern `^[A-Z]{2,3}-\d+$`.
- Display labels are generated on read from stored fields (BRD §4.2 table) by `DisplayLabel`; they are never stored or
  filterable. Example: Offer Lease + Residential → "For Rent"; Demand Sale + Primary → "Wants to Buy, New Project".

### 4.2 Ingestion of `rows.classified.v1` (US-01, US-07a, CR-006 Z-3/Z-4/Z-8)
Per event (≤ 500 rows):
1. Dedupe on `eventId` (`processed_events`) and on `(uploadId, batchNo)` (`upload_batches`).
2. If `migrationApplied` → ensure the upload's migration map is applied first (§4.8), under `pg_advisory_xact_lock(hash(uploadId))`;
   concurrent batches of the same upload wait on the lock (lock_timeout 45 s, then retried).
3. Fetch rows: `GET intake /internal/v1/uploads/{uploadId}/rows?batch=` (service token; 2 s timeout, 3 retries with jitter,
   breaker). If intake returns 404 `batch-not-found` the message goes to the DLQ (alarm).
4. Pre-load in bulk: `ingested_records` for all refs, persons by `phone_hash = ANY`, micromarket aliases (cached), active vocabulary.
5. Process in sub-transactions of 100 rows (each commits its outbox rows). Per row:
   - **Known ref, same content_hash** → only `last_seen_at`/`times_seen` (max) and a sighting; no domain event.
   - **Known ref, changed** → update facts except `staff_edited_fields`; `offer.updated.v1` / `demand.updated.v1`, plus
     `offer.price_changed.v1` if price fields changed.
   - **New ref** → route (table below), dedup (§4.4/§4.5), create, emit.
6. Mark `upload_batches` applied; write `processed_events`.

| record_scope | side | Creates | Emits |
|---|---|---|---|
| Property | Supply | source ad (by parent ref) + person(s) (by phone) + property (dedup §4.4) + **one offer per deal_type** (Sale\|Lease → 2 offers; prices split: Sale gets sale fields + current_rent; Lease gets rent/deposit; Pagdi gets premium as sale price and nominal rent; JV no price) + parties + sightings; project + configuration offer when `project_name` and market Primary | `offer.created.v1` × n |
| Property | Demand | person + demand, or a touch on an existing demand (§4.5) | `demand.created.v1` + `demand.touch_added.v1` (first) / `demand.touch_added.v1` |
| Property | blank | `unrouted_rows` (waits for review) | — |
| Business | any | desk item `business`; when includes_property = Yes and side Supply also property + offers (D-14) | `desk_item.created.v1` (+ `offer.created.v1` for the linked offers) |
| Capital | any | desk item `capital` | `desk_item.created.v1` |
| Equipment | any | desk item `archive` | `desk_item.created.v1` |
| Market Participant | None | person with participant_role (Network) | `desk_item.created.v1` (deskItemId = person id, recordScope Market Participant) |
| Market Signal | None | desk item `watchlist` | `watchlist_item.created.v1` |
| any Digi row with campaign/form/listing/project ref | — | enquiry linked to the offer/project/listing (listing ref resolved via listings public id is **not** possible here; stored as `listing_ref`) + person + demand or touch | `enquiry.received.v1` (+ demand events) |

- Offers and demands from ingestion start at record stage **Enriched** (R-10), source type from the row, capture mode `uploaded`.
- Every new merge candidate or price gap emits `merge_candidate.raised.v1` (kind `uncertain_merge`, `possible_repeat` or `price_gap`).
- `route_to` is stored as `route_to_suggestion` only; routing uses record_scope and side (Z-8). `crm_notes` (initial import
  only) becomes a note on the primary subject.
- `outside_launch_area` computed per §4.9 and carried in `offer.*`/`demand.*` facts.
- `needsReview` rows are created normally (review never blocks routing) with `needs_review`, `review_reason`,
  `review_reason_code` stored.

### 4.3 Staff edits vs re-uploads
Any field changed through the API is added to the record's `staff_edited_fields`. Later extractor updates of the same ref
never overwrite those fields (CRM work wins; US-07a AC4 intent). Extractor-only fields (times_seen, last seen, source facts)
always update.

### 4.4 Property-level supply dedup (US-07, BRD dedup rules)
Scores are computed by `PropertyMatcher` (pure) over candidates fetched by the dedup indexes (§3.4):
| Evidence | Weight |
|---|---|
| building_norm equal (both present) | 0.40 |
| same micromarket (or same locality_norm when unresolved) | 0.10 |
| floor_no equal (both present) | 0.15 |
| area overlap within 5% on the same basis (within 10% if a basis is blank) | 0.20 |
| bhk range equal | 0.05 |
| price within 5% for the same deal_type | 0.05 |
| shared phone (party) | 0.05, **counted only if the score without it is ≥ 0.50** (a phone never decides alone) |

Segment must be equal and property_types must overlap, otherwise not a candidate.
- **≥ 0.85 and building matched** → same property: attach. Same person and same deal → repost: sighting only, `last_seen_at`
  updated. Different person/source → **second source** (price, `price_gap` when > 5%, A-39) + sighting;
  `offer.has_price_gap` set. New deal_type → new offer on the existing property.
- **0.60–0.85** (or ≥ 0.85 without a building) → create the new property and a `merge_candidate` (`property_match`) for review
  (`merge_candidate.raised.v1`, kind `uncertain_merge`).
- **< 0.60** → new property.
- **Split siblings** (same `parent_external_ref`) are never candidates of each other (Z-3).
- **Extractor trust** (Z-4): a row with `external_source='extractor'` is not auto-linked to another record that came from the
  **same extractor source channel** (the extractor already merged its repeats); only `possible_repeat_of` creates a candidate
  between them. Cross-source (newspaper vs WhatsApp vs Digi vs manual) and CRM-created records are deduped normally.
- Manual create/add-supply/quick-add: the same scoring; candidates ≥ 0.60 → 409 `duplicate-property-suspected` with the
  candidates unless the user picked `existingPropertyId` or sent `confirmNewDespiteCandidates`.

### 4.5 Person and demand dedup (US-04, US-08)
- **Person:** phone (E.164, `phone_hash`) or email hash equal → same person (A phone identifies a Person, BRD). Several persons
  share a phone only after a merge was undone; then the most recently active is used and a `person_phone` candidate is raised.
- **Demand:** candidates = active, not closed, not exited Lost/Invalid (`exit_state`) demands of the same person (a Dormant demand is
  still a candidate: a new arrival becomes a touch and journeys may reactivate it), (index by person_id) created in the last 365 days,
  plus demands with the same `company_norm`. `DemandMatcher` score: segment equal (required), deal_types overlap 0.25,
  property_types overlap 0.20, micromarket/locality overlap 0.20, budget or rent overlap (±20%) 0.15, area overlap (±20%)
  0.15, bhk overlap 0.05.
  - phone match and score ≥ 0.80 → **touch** on the existing demand (first touch unchanged, A-16), `demand.touch_added.v1`.
  - 0.50–0.80, or company-only match ≥ 0.80 → new demand **and** a `demand_similarity` merge candidate (never silent, US-09).
  - otherwise new demand.
- Quick add follows the same rule, but when the user picked an open demand in the lookup (`existingDemandId`) the touch is
  added directly.

### 4.6 `possible_repeat_of` (Z-4)
For a row with `possibleRepeatOf = X`: if ref X is known → `merge_candidate(reason possible_repeat)` between the two primary
subjects (same aggregate type only); if X is not yet ingested → candidate with `status pending_target`, `right_external_ref = X`;
when X arrives (ingestion checks pending candidates for each new ref) or the nightly `resolve-pending-repeats` job runs, the
candidate becomes `open`. Never merged automatically.

### 4.7 Merge and undo (US-09, HLD §7 merge saga)
- Allowed: same aggregate type, all `active`, same tenant, not split siblings (409 `merge-not-allowed`).
- **MergePlan** (pure) lists the moves; `MergeRecords` executes them in one transaction and logs every change in
  `merge_undo_log` (table, row, column, old → new):
  - person: phones/emails, record_parties, demands.person_id, enquiries; flags union; name/company filled if survivor blank.
  - property: offers (a second offer with the same deal_type becomes an `offer` merge candidate, not auto-merged), photos,
    sightings, second sources, parties; facts filled where the survivor is blank.
  - offer: sightings, enquiries, second sources, offer_photos; counters recomputed; merged offer `status=merged`.
  - demand: touches (first touch = earliest `occurred_at`, flag moved accordingly), enquiries, parties.
  - merged records: `status='merged'`, `merged_into_id`; `ingested_records.primary_subject_id` re-pointed.
- Emits `records.merged.v1` (+ `offer.updated.v1`/`demand.updated.v1` for the survivor when facts changed,
  `demand.touch_added.v1` for moved touches) and `audit.recorded.v1` (action `records_merged`). Consumers re-key their own data
  (HLD §7).
- Guard: > 5,000 moved rows → 409 `merge-too-large` for user requests (migration-map merges run in the job context in pages).
- **Undo** (Admin/Manager): refuse if a later active merge has this survivor or any merged id as a participant
  (409 `merge-undo-blocked`). Replay the log in reverse: a column is restored only if its current value still equals the logged
  `new_value`; otherwise it is left (changed after the merge) and listed in the response `movedCounts.conflicts`. Children
  created after the merge stay on the survivor. Merged records return to `active`. Emits `records.merge_undone.v1`
  (restoredIds), updated events for affected aggregates, and `audit.recorded.v1` (`merge_undone`).

### 4.8 Migration map application (US-07a AC2, CR-006 Z-5)
Triggered by the first batch of an upload with `migrationApplied = true` (§4.2 step 2). Entries are fetched from intake
(`/internal/v1/uploads/{id}/migration-map`, 1,000 per page) and applied in entry order, 200 per transaction, progress in
`upload_migrations.entries_applied` (resumable):
| action | Effect in records |
|---|---|
| `kept` (old → new) | re-key `ingested_records` old → new (if new already exists, treat as `merged`) |
| `merged` (old → target) | both known → merge old's primary subject into target's (source `migration_map`, reversible, §4.7); only old known → re-key; old unknown → no-op |
| `split` (old → n1…nk) | old's subject is re-keyed to **n1** (CRM work — calls, stages, matches, notes — stays with it); n2…nk are created when their rows arrive; old ref `status=split`, `replaced_by_refs` |
A re-upload never deletes records missing from the file (AC3). IDs, codes and CRM work follow the new ref, so other services
(keyed by our UUIDs) see no change except for merges (`records.merged.v1`).

### 4.9 Outside-launch-area flag (Z-7)
`outside_launch_area = true` when `city_norm` is set and not an enabled `launch_area_cities` entry. If city is blank, the
record is inside when `source_edition` = Mumbai or the locality resolves (aliases) inside the MMR hierarchy; otherwise it is
flagged needs_review with review reason "location unclear" (R-9) and not marked outside. Demands: true only when **all** stated micromarkets/localities are outside. Initial enabled list: Mumbai, Navi
Mumbai, Thane and the MMR municipal areas (seeded by migration; Admin edits via `PUT /v1/launch-area`). Changing the list or
the hierarchy queues `recompute-launch-area`, which updates flags in batches of 1,000 and emits `offer.updated.v1` /
`demand.updated.v1` for flipped records. Flagged records stay searchable; consumers exclude them from queues, matching and listings.

### 4.10 Record axis
Offer: Captured → Enriched → Contacted → Verified → Qualified. Forward moves by agents (skipping allowed); backward moves by
Admin/Manager only (409 `invalid-stage-transition`). Verified requires `has_real_photos` (409
`verification-needs-real-photos`). `offer.confirmed.v1` / `site_visit.completed.v1` lift the stage to at least Contacted.
Initial stages (R-10): ingested records **Enriched**; quick add **Captured**, or **Contacted** when `duringCall = true`; Add supply
Contacted (US-05 AC2). `call.logged.v1` with outcome `confirmed` also lifts an offer to ≥ Contacted. Demand: Captured → Enriched → Verified → Qualified (stage carried in
`demand.updated.v1`).

### 4.11 Projects and price sheets (US-17)
One transaction per sheet: reject sheets older than `latest_price_sheet_date` (409 `stale-price-sheet`); per line match an
existing configuration offer by `offerId` or by (property_type, bhk_min, bhk_max); update prices/units/area (emit
`offer.price_changed.v1` and `offer.updated.v1`) or create a configuration offer (deal_type Sale, market Primary, on a project
property per configuration; `offer.created.v1`). `missingConfigurations = zero_units` sets unit_count 0 on configurations not in
the sheet. Updates `latest_price_sheet_date` and emits `price_sheet.applied.v1` (projectId, priceSheetId, sheetDate,
changedOfferIds: the life-curve basis for Sale, Primary in journeys) and `project.updated.v1`. Project create/patch emit
`project.created.v1` / `project.updated.v1` (full facts incl. offerIds).

### 4.12 Photos (D-5, A-26)
`POST /v1/photos` creates a `pending_upload` row and a signed PUT URL (15 min) after checking the 30-per-property cap. `attach`
verifies existence, size ≤ 10 MB and magic bytes (JPG/PNG/WebP), computes sha256 (duplicate guard), sets `ready`, updates
`photo_count`/`has_real_photos`, links offers, emits `photo.added.v1` with `storagePath` (listings produces public renditions) and `hasTextDetected` (set when the
optional attach-time text detector finds text; a warning only, R-8), plus `offer.updated.v1` (photoCount, hasRealPhotos,
selectedPhotoIds). `DELETE /v1/photos/{id}` removes it from all offer selections and emits `photo.removed.v1` + `offer.updated.v1`.
Sheet links (`photoUrls`, mapping mode) are fetched by `q_records_photo_fetch` (5 per host, 2 s timeout); failures are
`fetch_failed` with the error shown on the property and never block the upload.

### 4.13 Vocabulary releases (D-16, US-37)
Release files (`services/records/vocabulary/<version>.json`, the BRD §4.2 lists, per-segment property types, record-scope rules,
legacy-term table, display labels) are inserted as `pending` by a migration. Job `activate-vocabulary` (run after each deploy
and daily) activates the newest pending release whose version is greater than the active one: in one transaction it marks it
`active`, the previous `superseded`, and writes `vocabulary.released.v1` (version, checksum = sha256 of canonical content).
There is no API to change the vocabulary. records validates its own writes against the active release (in-memory, 5 min TTL,
refreshed immediately when the active version changes). Values removed by a release are handled by a data migration shipped
with it; existing records are never silently rewritten.

### 4.14 Contact reveal (R-VIS-3, NFR-13)
Default responses mask contacts: `displayName` = initials, `phonesMasked` = `+91 98•••••421`, no emails/other contact; property
unit/wing/floor and source-ad raw text are omitted. `POST /v1/reveals` returns the fields for one subject, writes
`audit.recorded.v1` (action `contact_viewed`, subject, purpose, **field names only**) in the same transaction, sets
`Cache-Control: no-store`, and is rate-limited to 60/hour per user. Reveals of purged persons return empty fields.

### 4.15 Consumed-event reactions
See §5.2. All reactions update `persons.last_activity_at` for linked people (retention anchor). Automatic changes use the system
actor `00000000-0000-0000-0000-000000000001` (R-7) in `changedBy` and audit events.

### 4.16 Review resolution and voiding (G-R1 closed by v0.2)
`review_item.resolved.v1` (with `action`): `set`/`confirm` apply the final classification. If the subject kind changes (side
Supply ↔ Demand, or Property ↔ another scope) records creates the correct record and **voids** the old one (`status = voided`,
`offer.voided.v1` / `demand.voided.v1`, reason `side_changed` / `scope_changed`). `discard` voids with reason
`duplicate_discarded`. Voided records are hidden from lists, kept for lineage, and never matched or published.

### 4.17 Offer facts in events (v0.2)
`offer.*` facts are built from offer + property + project: buildingKey (opaque hash, never the name), floorBand, totalFloors,
parking, amenities, tenure, agreementForm, isJodi, priceSheetDate (project's latest sheet), lastSeenDate, selectedPhotoIds
(`offer_photos`), contactPersonIds (`record_parties`, ids only), projectCode. Demand facts add contactPersonIds, moveInFrom and
lastSeenDate. `publicDescriptionSource` is set to the offer id when `description` is non-empty (listings fetches the text
through `GET /v1/offers/{id}` with a service token and sanitises it).

### 4.18 Internal endpoints for listings and insight
- **Scan terms (R-20):** `GET /internal/v1/properties/{id}/scan-terms` returns `HMAC-SHA256(scan salt, token)` for each normalised
  building/society name token (≥ 3 chars, stop-words like "CHS", "tower" removed), wing and unit. The salt is a records secret
  shared with listings (versioned, `saltVersion`); no plain name leaves records.
- **Contacts batch (R-21):** `POST /internal/v1/contacts:batch` (≤ 1,000 person ids, `aud=records`, `sub=insight`) returns name,
  phones, emails, whatsapp for an export and writes one `audit.recorded.v1` (action `contacts_exported`, exportId, count) per call.

---

## 5. Events (catalogue v0.2)

### 5.1 Produced (outbox, same transaction)
| Event | Trigger | aggregate (type / id) | Notes |
|---|---|---|---|
| `offer.created.v1` | ingestion, POST offers/properties, quick add (supply), add supply, price sheet (new configuration), lease renewal | offer / offerId | full OFFER_FACTS v0.2 (§4.17) |
| `offer.updated.v1` | any change to offer, property or project facts (PATCH, re-upload, merge fill, photos, launch-area recompute, stage change, review) | offer / offerId | full current facts |
| `offer.price_changed.v1` | price or unit_count changed | offer / offerId | previous/current, `cause` = edit / call / price_sheet / upload |
| `offer.record_stage_changed.v1` | record axis moved (API, add supply, confirmed/visit/call reactions) | offer / offerId | from, to, hasRealPhotos, changedBy |
| `offer.voided.v1` | review changed side/scope, or discard (§4.16) | offer / offerId | reason |
| `demand.created.v1` / `demand.updated.v1` | ingestion, POST demands, quick add / facts or stage changed, merge, recompute | demand / demandId | DEMAND_FACTS v0.2 |
| `demand.touch_added.v1` | new touch (first touch on create too) | demand / demandId | isFirstTouch |
| `demand.voided.v1` | review changed side/scope, or discard | demand / demandId | reason |
| `enquiry.received.v1` | enquiry row ingested | enquiry / enquiryId | |
| `records.merged.v1` / `records.merge_undone.v1` | merge (user, migration map, demand dedup) / undo | merged aggregate type / survivorId | |
| `merge_candidate.raised.v1` | new merge candidate or price gap (ingestion, quick add) | merge_candidate / candidateId | kind uncertain_merge / possible_repeat / price_gap |
| `person.flagged.v1` / `person.flag_removed.v1` | flag added (API, `call.logged.v1` unreachable, `demand.exited.v1` flagPerson) / removed (Admin/Manager) | person / personId | |
| `watchlist_item.created.v1` | Market Signal ingested | watchlist_item / deskItemId | |
| `desk_item.created.v1` / `desk_item.updated.v1` | Business/Capital/Equipment/Market Participant stored / assigned or archived | desk_item / deskItemId | |
| `project.created.v1` / `project.updated.v1` | project created / facts, configurations or sheet changed | project / projectId | |
| `price_sheet.applied.v1` | price sheet applied | project / projectId | priceSheetId, sheetDate, changedOfferIds |
| `photo.added.v1` / `photo.removed.v1` | photo attached (API or sheet fetch) / deleted | photo / photoId | storagePath, hasTextDetected |
| `micromarkets.updated.v1` | micromarket create/patch (hierarchy, aliases, adjacency) | micromarkets / tenant id | version = `reference_versions` |
| `market_data.recorded.v1` | a market data point is written (deal closed by us via `deal.closed.v1`, retired offer with a known price via `offer.retired.v1`, Lost demand with `competingPriceInr` via `demand.exited.v1`, or staff entry) | market data point | 1 |
| `vocabulary.released.v1` | activate-vocabulary job | vocabulary / release row id | version, checksum |
| `audit.recorded.v1` | reveal, contacts batch, merge, undo | audit / new UUIDv7 | action `contact_viewed` / `contacts_exported` / `records_merged` / `merge_undone`; no PII values |

`aggregateVersion` = the row `version` after the change, so consumers can drop stale events.

### 5.2 Consumed (queue `q_records`)
| Event | Handling | Idempotency | Out-of-order |
|---|---|---|---|
| `rows.classified.v1` (intake) | §4.2 | processed_events + `upload_batches (upload_id, batch_no)`; row-level uniques | batches are independent aggregates; content hash + `staff_edited_fields` make an older batch harmless; migration map applied first |
| `review_item.resolved.v1` (intake) | §4.16 (unrouted rows routed; set/confirm applied; kind change or discard → void) | processed_events | `inbound_versions(review_item, id)`: older resolution ignored |
| `offer.confirmed.v1` (journeys) | record stage ≥ Contacted (`offer.record_stage_changed.v1` if moved); last_activity | processed_events | forward-only |
| `site_visit.completed.v1` (journeys) | record stage ≥ Contacted for offerIds; last_activity | processed_events | forward-only |
| `call.logged.v1` (journeys) | `personUnreachable = true` → add flag `unreachable` to personId (`person.flagged.v1`); outcome `confirmed` on an offer → stage ≥ Contacted; last_activity | processed_events; flag add is a no-op if present | forward-only / set semantics |
| `demand.exited.v1` (journeys) | set `exit_state`; `flagPerson` → flag `invalid` on personId (`person.flagged.v1`); competingPriceInr → market data `lost_competing` (no PII) | processed_events + UNIQUE market data per (demand, source) | apply only if aggregateVersion > `exit_version` |
| `demand.reactivated.v1` (journeys) | clear `exit_state` | processed_events | `exit_version` |
| `deal.closed.v1` (journeys) | market data `closed_by_us`; `closed_at` on offer and demand | processed_events + UNIQUE (deal_id, source) | a later `deal.cancelled.v1` voids it; cancel-first is recorded in inbound_versions |
| `deal.cancelled.v1` (journeys) | void the market data point; clear `closed_at` (HLD §7 compensation) | processed_events | idempotent |
| `offer.retired.v1` (journeys) | `retired_at`, reason; knownPriceInr → market data `closed_elsewhere` | processed_events | idempotent |
| `lease_renewal.due.v1` (journeys) | R-19: create the Upcoming offer on propertyId (copy of the previous Lease offer, `possession_status = Available From`, `possession_date = availableFrom`, stage Contacted) → `offer.created.v1` | processed_events + UNIQUE (renewal_of_offer_id, possession_date) | one-shot |
| `publication.changed.v1` (listings) | cache publication level on offer / project / demand (`demand_post`) | processed_events | only if aggregateVersion > `publication_version` |

---

## 6. Error codes (service-specific; common codes per conventions §4)

| Code | HTTP | When |
|---|---|---|
| `duplicate-property-suspected` | 409 | create/add-supply/quick-add supply with candidates ≥ 0.60 and no confirmation; body carries `candidates[]` |
| `deal-type-exists` | 409 | property already has an active offer of that deal type |
| `record-merged` | 409 | mutating a merged record (response names `mergedIntoId`) |
| `invalid-stage-transition` | 409 | backward move by an agent, unknown stage |
| `verification-needs-real-photos` | 409 | offer → Verified without a real photo |
| `not-demand-owner` | 403 | demand agent adding supply to someone else's demand |
| `person-phone-exists` | 409 | creating a person with a phone that belongs to another active person |
| `project-exists` | 409 | same developer + name + micromarket |
| `stale-price-sheet` | 409 | sheet older than the latest applied |
| `photo-limit-reached` | 409 | > 30 photos on a property |
| `photo-upload-missing` | 409 | attach before the file is in storage |
| `photo-not-on-property` | 409 | offer photo selection outside its property |
| `unsupported-media-type` | 415 | image type/magic bytes not JPG/PNG/WebP |
| `merge-not-allowed` | 409 | mixed types, split siblings, already merged |
| `merge-too-large` | 409 | > 5,000 rows to move |
| `merge-already-undone` | 409 | undo twice |
| `merge-undo-blocked` | 409 | a later active merge involves these records |
| `candidate-closed` | 409 | dismissing a closed candidate |
| `already-resolved` | 409 | resolving a closed second source |
| `desk-item-not-editable` | 409 | PATCH on a network (person) item |
| `micromarket-alias-taken` | 409 | name/alias already resolves elsewhere |
| `vocabulary-value-invalid` | 400 | a controlled field value not in the active release (`errors[]` per field) |
| `phone-invalid` | 400 | phone not normalisable to E.164 |
| `range-inverted` | 400 | a `_min` greater than its `_max` |
| `reveal-not-applicable` | 400 | subject has no revealable fields |
| `version-mismatch` | 412 | If-Match mismatch (common) |

---

## 7. PII fields and retention

| Column | Class | Exposure |
|---|---|---|
| persons.name, persons.other_contact | PII | reveal only |
| person_phones.phone_e164, person_emails.email | PII (+ hash columns for lookup) | reveal only; lookup by hash |
| properties.wing, unit_no, floor_no | PII-sensitive | reveal only; floor_band is served instead |
| properties.building_name | private | staff APIs and proposals; never to listings (events do not carry it) |
| source_ads.raw_text, text_variants, sender_name, sender_phone | PII | reveal only |
| enquiries.message | PII | reveal only |
| desk_items.business_description | PII-sensitive | APIs serve the redacted copy |
| offers.description | PII-sensitive | staff APIs; listings sanitises before public use |
| contacts batch response | PII | internal route, insight export only, audited per call (R-21) |
| unrouted_rows.row_snapshot | PII | internal only; deleted when routed (+ 30 days) |
| idempotency_keys.response_body | never PII (reveal stores auditId only) | — |

- Never logged (allow-list logger); never in events (conventions §5; events carry `contactPersonIds` and `buildingKey`, not
  values); never in URLs (quick-add lookup uses POST). Scan terms leave records only as salted hashes (R-20).
- **Retention (NFR-18):** `persons.last_activity_at` is bumped by any create/update/touch/enquiry/confirmation/visit/deal on a
  linked record. Weekly job `retention-purge` (Sunday 04:00 IST): for persons with `last_activity_at` < now − 24 months and no
  linked record active within 24 months → delete phone/email rows, null name/other_contact, set `purged_at`; null
  `raw_text`/`text_variants`/`sender_*` on source ads whose linked records are all inactive > 24 months; null
  `enquiries.message`; null `wing`/`unit_no`/`floor_no` on such properties. Offers, demands and market data points stay without
  personal data. Pilot: data is wiped at the paid-plan gate.

---

## 8. Performance notes

| Path | Target | Design |
|---|---|---|
| GET by id/code | p95 < 100 ms | PK/unique lookup + one join for property facts; masks computed in memory |
| Lists / search | NFR-2 p95 < 300 ms | keyset pagination on (sort, id), limit ≤ 100, driving index per filter (§3), no counts, 2 s statement timeout |
| Quick-add lookup | < 150 ms | hash index lookups, ≤ 5 people × 10 demands/offers |
| Create/patch | < 200 ms | one transaction: row + outbox (+ dedup queries ≤ 3 indexed range scans) |
| Merge | < 2 s for ≤ 5,000 moved rows | set-based UPDATEs per child table with undo-log `INSERT … SELECT` |
| Price sheet | < 1 s for ≤ 200 lines | one transaction, batched upserts |
| Ingestion | ~10 ms/row, 500-row event ≈ 5 s (capacity plan §3) | bulk pre-loads per batch, multi-row inserts, sub-transactions of 100 rows; drain concurrency 3 (pilot) / 8 (paid) |

- Pool `records_svc`: 6 pilot / 16 paid (data-hosting §5). Sync requests hold one connection ~30 ms; ingestion drainers hold one
  connection per sub-transaction (~0.5–1 s). 8 drainers + ~1 for sync traffic at 30 rps fit in 16.
- Caches (in-memory per instance): vocabulary (5 min / on release), micromarket tree + aliases (1 h / on change), launch area
  (5 min). Never the source of truth.
- Counters (`enquiry_count`, `sighting_count`, …) are maintained in the writing transaction; `reconcile-counters` fixes drift nightly.
- Volume (NFR-11): offers/demands 5M, sightings 20M: all hot paths are index range scans bounded by `limit`; sightings and
  merge_undo_log are candidates for monthly partitioning after the paid gate (not needed in the pilot).

---

## 9. Endpoint summary

Auth: staff = `staffViaWeb`, service = `serviceToken` minted by web (R-2; projection rebuilds, vocabulary refresh, scan terms,
contacts batch), cron = `cronSecret`. Roles: Adm = Admin, Mgr = Manager, Dem = Demand agent, Sup = Supply agent, Op = Data
operator. Details and schemas: `contracts/openapi/records.yaml`.

| Method | Path | Auth | Roles | Idempotency | Paginated | Rate limit | Timeout | Emits |
|---|---|---|---|---|---|---|---|---|
| GET | `/v1/offers` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/offers` | staff | Adm, Mgr, Sup | Idempotency-Key | — | 20/s user | 2 s | `offer.created.v1` |
| GET | `/v1/offers/{idOrCode}` | staff / service | all | safe | — | 20/s user | 2 s | — |
| PATCH | `/v1/offers/{idOrCode}` | staff | Adm, Mgr, Sup, Dem | If-Match | — | 20/s user | 2 s | `offer.updated.v1`, `offer.price_changed.v1` |
| POST | `/v1/offers/{idOrCode}/record-stage` | staff | Adm, Mgr, Sup, Dem | Idempotency-Key | — | 20/s user | 2 s | `offer.record_stage_changed.v1`, `offer.updated.v1` |
| PUT | `/v1/offers/{idOrCode}/photos` | staff | Adm, Mgr, Sup, Dem | PUT (+If-Match) | — | 20/s user | 2 s | `offer.updated.v1` |
| GET | `/v1/properties` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/properties` | staff | Adm, Mgr, Sup | Idempotency-Key | — | 20/s user | 2 s | `offer.created.v1` |
| POST | `/v1/properties/dedup-check` | staff | Adm, Mgr, Sup, Dem | read-only POST | — | 20/s user | 2 s | — |
| GET | `/v1/properties/{idOrCode}` | staff / service | all | safe | — | 20/s user | 2 s | — |
| PATCH | `/v1/properties/{idOrCode}` | staff | Adm, Mgr, Sup, Dem | If-Match | — | 20/s user | 2 s | `offer.updated.v1` |
| GET | `/v1/properties/{idOrCode}/sightings` | staff | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/properties/{idOrCode}/second-sources` | staff | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/properties/{idOrCode}/photos` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/second-sources` | staff | Adm, Mgr, Op, Sup | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/second-sources/{id}/resolve` | staff | Adm, Mgr, Op, Sup | Idempotency-Key | — | 20/s user | 2 s | `offer.price_changed.v1`, `offer.updated.v1` |
| GET | `/v1/projects` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/projects` | staff | Adm, Mgr, Sup | Idempotency-Key | — | 20/s user | 2 s | `project.created.v1` |
| GET | `/v1/projects/{idOrCode}` | staff / service | all | safe | — | 20/s user | 2 s | — |
| PATCH | `/v1/projects/{idOrCode}` | staff | Adm, Mgr, Sup | If-Match | — | 20/s user | 2 s | `project.updated.v1`, `offer.updated.v1` |
| POST | `/v1/projects/{idOrCode}/price-sheets` | staff | Adm, Mgr, Sup | Idempotency-Key | — | 20/s user | 2 s | `price_sheet.applied.v1`, `project.updated.v1`, `offer.created.v1`, `offer.updated.v1`, `offer.price_changed.v1` |
| GET | `/v1/projects/{idOrCode}/price-sheets` | staff | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/demands` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/demands` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s user | 2 s | `demand.created.v1`, `demand.touch_added.v1` |
| GET | `/v1/demands/{idOrCode}` | staff / service | all | safe | — | 20/s user | 2 s | — |
| PATCH | `/v1/demands/{idOrCode}` | staff | Adm, Mgr, Dem | If-Match | — | 20/s user | 2 s | `demand.updated.v1` |
| POST | `/v1/demands/{idOrCode}/record-stage` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s user | 2 s | `demand.updated.v1` |
| GET | `/v1/demands/{idOrCode}/touches` | staff | all | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/demands/{idOrCode}/touches` | staff | Adm, Mgr, Dem | Idempotency-Key | — | 20/s user | 2 s | `demand.touch_added.v1` |
| POST | `/v1/demands/{idOrCode}/add-supply` | staff | Adm, Mgr, Sup, Dem | Idempotency-Key | — | 20/s user | 2 s | `offer.created.v1`, `offer.record_stage_changed.v1` |
| GET | `/v1/people` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/people` | staff | Adm, Mgr, Sup, Dem | Idempotency-Key | — | 20/s user | 2 s | — |
| GET | `/v1/people/{idOrCode}` | staff / service | all | safe | — | 20/s user | 2 s | — |
| PATCH | `/v1/people/{idOrCode}` | staff | Adm, Mgr, Sup, Dem | If-Match | — | 20/s user | 2 s | — |
| POST | `/v1/people/{idOrCode}/flags` | staff | Adm, Mgr, Sup, Dem | Idempotency-Key | — | 20/s user | 2 s | `person.flagged.v1`, `person.flag_removed.v1` |
| POST | `/v1/quick-add/lookup` | staff | Adm, Mgr, Dem, Sup | read-only POST | — | 20/s user | 2 s | — |
| POST | `/v1/quick-add` | staff | Adm, Mgr, Dem, Sup | Idempotency-Key | — | 20/s user | 2 s | `demand.created.v1`, `demand.touch_added.v1`, `offer.created.v1`, `merge_candidate.raised.v1` |
| POST | `/v1/reveals` | staff | all | Idempotency-Key | — | 60 reveals/hour per user | 2 s | `audit.recorded.v1` |
| GET | `/v1/enquiries` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/enquiries/{idOrCode}` | staff / service | all | safe | — | 20/s user | 2 s | — |
| GET | `/v1/source-ads` | staff | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/source-ads/{idOrCode}` | staff | all | safe | — | 20/s user | 2 s | — |
| GET | `/v1/merge-candidates` | staff | Adm, Mgr, Op | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/merge-candidates/{id}/dismiss` | staff | Adm, Mgr, Op | Idempotency-Key | — | 20/s user | 2 s | — |
| POST | `/v1/merges` | staff | Adm, Mgr, Op | Idempotency-Key | — | 20/s user | 2 s | `records.merged.v1`, `audit.recorded.v1`, `demand.touch_added.v1`, `offer.updated.v1`, `demand.updated.v1` |
| GET | `/v1/merges/{id}` | staff | all | safe | — | 20/s user | 2 s | — |
| POST | `/v1/merges/{id}/undo` | staff | Adm, Mgr | Idempotency-Key | — | 20/s user | 2 s | `records.merge_undone.v1`, `audit.recorded.v1`, `offer.updated.v1`, `demand.updated.v1` |
| GET | `/v1/desks/{desk}` | staff | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/desk-items/{idOrCode}` | staff | all | safe | — | 20/s user | 2 s | — |
| PATCH | `/v1/desk-items/{idOrCode}` | staff | Adm, Mgr | If-Match | — | 20/s user | 2 s | `desk_item.updated.v1` |
| GET | `/v1/vocabulary` | staff / service | all | safe | — | 20/s user | 2 s | — |
| GET | `/v1/vocabulary/versions` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| GET | `/v1/micromarkets` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| POST | `/v1/micromarkets` | staff | Adm | Idempotency-Key | — | 20/s user | 2 s | `micromarkets.updated.v1` |
| PATCH | `/v1/micromarkets/{id}` | staff | Adm | If-Match | — | 20/s user | 2 s | `micromarkets.updated.v1` |
| GET | `/v1/launch-area` | staff / service | all | safe | — | 20/s user | 2 s | — |
| PUT | `/v1/launch-area` | staff | Adm | PUT (+If-Match) | — | 20/s user | 2 s | `offer.updated.v1`, `demand.updated.v1` |
| POST | `/v1/photos` | staff | Adm, Mgr, Sup, Dem | Idempotency-Key | — | 20/s user | 2 s | — |
| POST | `/v1/photos/{id}/attach` | staff | Adm, Mgr, Sup, Dem | Idempotency-Key | — | 20/s user | 2 s | `photo.added.v1`, `offer.updated.v1` |
| DELETE | `/v1/photos/{id}` | staff | Adm, Mgr, Sup, Dem | natural | — | 20/s user | 2 s | `photo.removed.v1`, `offer.updated.v1` |
| GET | `/internal/v1/properties/{id}/scan-terms` | service | — | safe | — | listings only; no user limit | 2 s | — |
| POST | `/internal/v1/contacts:batch` | service | — | natural (see spec) | — | insight export workers only; no user limit | 2 s | `audit.recorded.v1` |
| GET | `/v1/market-data` | staff / service | all | safe | yes | 20/s user | 2 s | — |
| POST | `/internal/v1/relay` | cron | — | natural (see spec) | — | cron | 60 s | — |
| POST | `/internal/v1/drain/{queue}` | cron | — | natural (see spec) | — | cron | 60 s | — |
| POST | `/internal/v1/jobs/{name}` | cron | — | natural (see spec) | — | cron | 60 s | — |
| GET | `/health/live` | none | — | safe | — | none | 2 s | — |
| GET | `/health/ready` | none | — | safe | — | none | 2 s | — |

Ownership re-checks inside the service: Demand agents may add supply only to demands they own; `ownerUserId` changes and backward
record-stage moves need Admin/Manager; person flag removal needs Admin/Manager.

---

## 10. Contract gaps and open questions

`events.yaml` (v0.2), `_common.yaml` and `conventions.md` were not edited. Closed since v0.1: G-R1 (`offer/demand.voided.v1`),
G-R2 (`price_sheet.applied.v1`), G-R3 (records consumes `demand.exited/reactivated`), G-R4 (R-2), G-R5 (`person.flag_removed.v1`),
G-R6 (`desk_item.*`), G-R10 (R-19), Q-R3 (R-9), Q-R4 (R-10).

| # | Still open | Assumption used | Proposed fix |
|---|---|---|---|
| G-R7 | `offer.retired.v1 (unwilling)`: no person-level flag implied | records stores the retired reason only; listings enforces never-publish | confirm |
| G-R9 | `publication.changed.v1` for `demand_post` is assumed to use the demand id as `subjectId` | cached on demands | confirm in the listings LLD |
| G-R11 | `publicDescriptionSource` semantics in offer facts are vague ("text id reference") | set to the offer id when `description` is non-empty; listings reads the text via `GET /v1/offers/{id}` (service token) | define in the catalogue description |
| G-R12 | `photo.added.v1.hasTextDetected` needs a detector; none is specified for Phase 1 | optional attach-time detector; omitted when not configured (warning only, R-8) | decide the detector in Stage 6 |
| G-R13 | `desk_item.created.v1` for Market Participants: they are People, not desk items | deskItemId = person id, recordScope Market Participant | confirm with insight |
| G-R14 | `desk_item.updated.v1` has no event for a new Market Participant role on an existing person | not emitted | additive if insight needs it |
| Q-R1 | Default responses mask names (initials) and phones; full contacts only via `/v1/reveals` (audit per view). Confirm vs R-VIS-3 and OQ-P10 | as stated | product owner |
| Q-R2 | Dedup thresholds (property 0.85 / 0.60; demand 0.80 / 0.50) and weights are initial values to tune for M3/M4 | as stated | tune in Stage 7 |
| Q-R5 | Migration-map `split`: CRM work follows the **first** child | as stated | confirm |
| Q-R6 | Staff edits win over later extractor values (`staff_edited_fields`) | as stated | confirm |
| Q-R7 | Extractor rows are not auto-deduped against records from the same extractor channel (only `possible_repeat_of` → review) | as stated (Z-4) | confirm |

## Amendments: CR-011 and CR-012 (approved 2026-09-30)
- Ingest stores `building_name` and `floor` on the property and uses the building for property-level dedup (the "same property" branch).
- When a row has `hasCrmNotes`, emit `record.note_imported.v1` (ids only) for the created or updated subject.
- `offers.sourcing_request_id` (nullable) is set by add-supply and exposed as `Offer.sourcingRequestId`.
- Lost-to-competing-terms points emit `market_data.recorded.v1` kind `lost_competing`. Photo operations declare 503. An idempotent replay of
  a duplicate-property 409 keeps its `candidates` extension.
