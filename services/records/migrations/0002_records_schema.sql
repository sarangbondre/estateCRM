-- records: business tables and indexes (records LLD §3, REC-01). Every business index starts with tenant_id
-- (conventions §3); technical tables are in 0001 (R-4). Columns holding personal data are marked "-- PII".
-- btree_gin lets GIN indexes lead with tenant_id (LLD §3 preamble). Supabase keeps extensions in `extensions`.
create extension if not exists btree_gin with schema extensions;

-- 3.1 code sequences ------------------------------------------------------------------------------------------
create table code_sequences (
  tenant_id uuid not null,
  prefix text not null,
  next_value bigint not null default 1,
  pad integer not null,
  primary key (tenant_id, prefix)          -- UPDATE … SET next_value = next_value + n RETURNING (issue / reserve a block)
);

-- 3.18 reference data (first: other tables reference micromarkets) -------------------------------------------
create table micromarkets (
  id uuid primary key,
  tenant_id uuid not null,
  parent_id uuid references micromarkets (id),
  level text not null check (level in ('zone', 'micromarket', 'locality', 'sub_locality')),
  name text not null,
  name_norm text not null,
  aliases text[] not null default '{}',
  aliases_norm text[] not null default '{}',
  city text not null,
  city_norm text not null,
  in_launch_area boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
-- create conflicts (nulls not distinct: two roots with the same name conflict)
create unique index micromarkets_level_name_parent on micromarkets (tenant_id, level, name_norm, parent_id) nulls not distinct;
-- locality alias resolution; 409 micromarket-alias-taken
create index micromarkets_aliases on micromarkets using gin (tenant_id, aliases_norm);
-- ?parentId= and descendant expansion (recursive CTE, depth ≤ 4)
create index micromarkets_parent on micromarkets (tenant_id, parent_id, name_norm, id);
-- default list order and ?q= prefix
create index micromarkets_level_name on micromarkets (tenant_id, level, name_norm text_pattern_ops, id);
-- exact name lookups during alias resolution
create index micromarkets_name on micromarkets (tenant_id, name_norm);

create table micromarket_adjacency (
  tenant_id uuid not null,
  micromarket_id uuid not null references micromarkets (id),
  adjacent_id uuid not null references micromarkets (id),
  created_at timestamptz not null default now(),
  primary key (tenant_id, micromarket_id, adjacent_id)   -- adjacentIds on reads (stored both directions, R-13)
);

create table reference_versions (
  tenant_id uuid not null,
  kind text not null,                     -- micromarkets | launch_area
  version bigint not null default 0,
  recompute_status text check (recompute_status in ('queued', 'running', 'done')),
  recompute_cursor jsonb,                 -- recompute-launch-area resume point
  updated_at timestamptz not null default now(),
  primary key (tenant_id, kind)           -- micromarkets.updated.v1 version; launch-area version and recompute state
);

create table launch_area_cities (
  id uuid primary key,
  tenant_id uuid not null,
  city_norm text not null,
  name text not null,
  enabled boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index launch_area_cities_city on launch_area_cities (tenant_id, city_norm);  -- outside-launch-area rule; recompute diff

create table vocabulary_releases (
  id uuid primary key,
  tenant_id uuid not null,
  version text not null,
  checksum text not null,
  status text not null check (status in ('pending', 'active', 'superseded')),
  content jsonb not null,                 -- fields, recordScopes, legacyTerms, displayLabels
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index vocabulary_releases_version on vocabulary_releases (tenant_id, version);                -- ?version=
create unique index vocabulary_releases_active on vocabulary_releases (tenant_id) where status = 'active';   -- active release
create index vocabulary_releases_list on vocabulary_releases (tenant_id, activated_at desc, id desc);        -- versions list

-- 3.2 persons -------------------------------------------------------------------------------------------------
create table persons (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  name text,                              -- PII
  name_initials text,
  company_name text,
  company_norm text,
  party_type text,
  participant_role text,
  other_contact text,                     -- PII
  flags text[] not null default '{}',
  dependencies jsonb not null default '[]',
  status text not null default 'active' check (status in ('active', 'merged')),
  merged_into_id uuid references persons (id),
  last_activity_at timestamptz not null default now(),
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index persons_code on persons (tenant_id, code);                                                     -- GET /v1/people/{code}
create index persons_list on persons (tenant_id, updated_at desc, id desc) where status = 'active';                  -- default order
create index persons_party_type on persons (tenant_id, party_type, updated_at desc, id desc) where status = 'active';  -- ?partyType=
create index persons_participant_role on persons (tenant_id, participant_role, updated_at desc, id desc)
  where participant_role is not null and status = 'active';                                                          -- ?participantRole=; desks/network
create index persons_flags on persons using gin (tenant_id, flags);                                                  -- ?flag=
create index persons_company on persons (tenant_id, company_norm text_pattern_ops) where company_norm is not null;    -- ?companyName= prefix; demand dedup
create index persons_retention on persons (tenant_id, last_activity_at) where purged_at is null;                     -- retention-purge

-- 3.3 person contacts -----------------------------------------------------------------------------------------
create table person_phones (
  id uuid primary key,
  tenant_id uuid not null,
  person_id uuid not null references persons (id),
  phone_e164 text not null,               -- PII
  phone_hash text not null,
  kind text not null default 'phone' check (kind in ('phone', 'whatsapp')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index person_phones_hash_person on person_phones (tenant_id, phone_hash, person_id, kind);  -- no duplicate contact on one person
create index person_phones_hash on person_phones (tenant_id, phone_hash);                                  -- quick-add lookup; ingestion person dedup
create index person_phones_person on person_phones (tenant_id, person_id);                                 -- reveal, merge, purge

create table person_emails (
  id uuid primary key,
  tenant_id uuid not null,
  person_id uuid not null references persons (id),
  email text not null,                    -- PII
  email_hash text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index person_emails_hash_person on person_emails (tenant_id, email_hash, person_id);
create index person_emails_hash on person_emails (tenant_id, email_hash);
create index person_emails_person on person_emails (tenant_id, person_id);

-- 3.7 projects (before properties/offers, which reference them) -----------------------------------------------
create table projects (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  name text not null,
  name_norm text not null,
  developer_person_id uuid references persons (id),
  developer_name text,
  locality text,
  locality_norm text,
  city text,
  city_norm text,
  state text,
  landmark text,
  location_text text,
  micromarket_id uuid references micromarkets (id),
  rera_number text,
  possession_date text,
  amenities text[] not null default '{}',
  floor_plan_photo_ids uuid[] not null default '{}',
  latest_price_sheet_date date,
  publication_level text not null default 'Private',
  publication_version bigint not null default 0,
  outside_launch_area boolean not null default false,
  staff_edited_fields text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index projects_code on projects (tenant_id, code);
create unique index projects_identity on projects (tenant_id, developer_person_id, name_norm, micromarket_id) nulls not distinct;  -- 409 project-exists
create index projects_name on projects (tenant_id, name_norm text_pattern_ops);                         -- ingestion match by name
create index projects_micromarket on projects (tenant_id, micromarket_id, updated_at desc, id desc);    -- ?micromarketId=
create index projects_list on projects (tenant_id, updated_at desc, id desc);                          -- default list, updatedSince
create index projects_developer on projects (tenant_id, developer_person_id);                          -- ?developerPersonId=
create index projects_rera on projects (tenant_id, (rera_number is not null), updated_at desc, id desc);  -- ?hasRera=
create index projects_city on projects (tenant_id, city_norm, updated_at desc, id desc);                -- ?city=; launch-area recompute

-- 3.4 properties ----------------------------------------------------------------------------------------------
create table properties (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  segment text,
  property_types text[] not null default '{}',
  property_detail text,
  land_use text,
  locality text,
  locality_norm text,
  micromarket_id uuid references micromarkets (id),
  city text,
  city_norm text,
  state text,
  landmark text,
  location_text text,
  building_name text,
  building_norm text,
  wing text,                              -- PII (unit-level)
  unit_no text,                           -- PII
  floor_no integer,                       -- PII (exact floor)
  floor_band text check (floor_band in ('Low', 'Mid', 'High')),
  parking integer,
  building_key text,
  total_floors integer,
  area_sqft_min numeric(12, 2),
  area_sqft_max numeric(12, 2),
  area_basis text check (area_basis in ('Carpet', 'Builtup', 'Saleable')),
  land_area_value numeric(14, 4),
  land_area_unit text,
  land_area_sqft numeric(14, 2),
  area_text text,
  bhk_min numeric(3, 1),
  bhk_max numeric(3, 1),
  features text,
  amenities text[] not null default '{}',
  project_id uuid references projects (id),
  outside_launch_area boolean not null default false,
  photo_count integer not null default 0,
  has_real_photos boolean not null default false,
  staff_edited_fields text[] not null default '{}',
  last_seen_at timestamptz,
  status text not null default 'active' check (status in ('active', 'merged')),
  merged_into_id uuid references properties (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index properties_code on properties (tenant_id, code);
create index properties_dedup_building on properties (tenant_id, micromarket_id, building_norm)
  where status = 'active' and building_norm is not null;                                               -- dedup with a building
create index properties_dedup_area on properties (tenant_id, micromarket_id, segment, bhk_min, area_sqft_min)
  where status = 'active';                                                                              -- dedup without a building (±5%)
create index properties_dedup_locality on properties (tenant_id, locality_norm, segment, area_sqft_min)
  where status = 'active' and micromarket_id is null;                                                   -- dedup outside the hierarchy
create index properties_building_name on properties (tenant_id, building_norm text_pattern_ops) where building_norm is not null;  -- ?buildingName=
create index properties_building_key on properties (tenant_id, building_key) where building_key is not null;      -- same-building lookups
create index properties_micromarket on properties (tenant_id, micromarket_id, updated_at desc, id desc);           -- ?micromarketId=
create index properties_segment on properties (tenant_id, segment, updated_at desc, id desc);                     -- ?segment=
create index properties_types on properties using gin (tenant_id, property_types);                               -- ?propertyType=
create index properties_city on properties (tenant_id, city_norm, updated_at desc, id desc);                      -- ?city=; recompute
create index properties_locality on properties (tenant_id, locality_norm, updated_at desc, id desc);              -- ?locality=
create index properties_project on properties (tenant_id, project_id) where project_id is not null;               -- ?projectId=
create index properties_list on properties (tenant_id, updated_at desc, id desc);                                 -- default, updatedSince
create index properties_outside on properties (tenant_id, outside_launch_area, updated_at desc, id desc);         -- ?outsideLaunchArea=

-- 3.8 demands -------------------------------------------------------------------------------------------------
create table demands (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  person_id uuid references persons (id),
  company_name text,
  company_norm text,
  deal_types text[] not null default '{}',
  market text,
  segment text,
  property_types text[] not null default '{}',
  micromarket_ids uuid[] not null default '{}',
  localities text[] not null default '{}',
  budget_inr_min bigint,
  budget_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  area_sqft_min numeric(12, 2),
  area_sqft_max numeric(12, 2),
  area_basis text check (area_basis in ('Carpet', 'Builtup', 'Saleable')),
  bhk_min numeric(3, 1),
  bhk_max numeric(3, 1),
  move_in_from date,
  move_in_by date,
  move_in_text text,
  stated_tags jsonb not null default '{}',
  decision_maker text,
  introducing_broker_person_id uuid references persons (id),
  shared_commission_note text,
  shared_commission_pct numeric(5, 2),
  record_stage text not null check (record_stage in ('Captured', 'Enriched', 'Verified', 'Qualified')),
  publication_level text not null default 'Private',
  publication_version bigint not null default 0,
  owner_user_id uuid,
  source_type text not null check (source_type in ('Channel', 'Digi', 'Direct')),
  capture_mode text not null check (capture_mode in ('uploaded', 'typed_in')),
  side_evidence text,
  needs_review boolean not null default false,
  review_reason text,
  review_reason_code text,
  first_touch_id uuid,
  touch_count integer not null default 1,
  ingested_record_id uuid,
  source_ad_id uuid,
  outside_launch_area boolean not null default false,
  closed_at timestamptz,
  exit_state text check (exit_state in ('Lost', 'Dormant', 'Invalid')),
  exit_version bigint not null default 0,
  last_seen_at timestamptz,
  staff_edited_fields text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'merged', 'voided')),
  void_reason text check (void_reason in ('side_changed', 'scope_changed', 'duplicate_discarded')),
  merged_into_id uuid references demands (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index demands_code on demands (tenant_id, code);
create index demands_person on demands (tenant_id, person_id, created_at desc) where status = 'active';            -- dedup by person; ?personId=
create index demands_company on demands (tenant_id, company_norm, created_at desc)
  where company_norm is not null and status = 'active';                                                            -- dedup company evidence
create index demands_segment on demands (tenant_id, segment, updated_at desc, id desc) where status = 'active';     -- ?segment=
create index demands_deal_types on demands using gin (tenant_id, deal_types);                                      -- ?dealType=
create index demands_property_types on demands using gin (tenant_id, property_types);                              -- ?propertyType=
create index demands_micromarkets on demands using gin (tenant_id, micromarket_ids);                               -- ?micromarketId=
create index demands_localities on demands using gin (tenant_id, localities);                                      -- ?locality=
create index demands_stage on demands (tenant_id, record_stage, updated_at desc, id desc);                          -- ?recordStage=
create index demands_owner on demands (tenant_id, owner_user_id, updated_at desc, id desc);                         -- ?ownerUserId=
create index demands_source on demands (tenant_id, source_type, updated_at desc, id desc);                          -- ?sourceType=
create index demands_budget on demands (tenant_id, budget_inr_min);                                                 -- budget range filter
create index demands_area on demands (tenant_id, area_sqft_min);                                                    -- area range filter
create index demands_review on demands (tenant_id, needs_review, updated_at desc, id desc) where needs_review;       -- ?needsReview=
create index demands_list on demands (tenant_id, updated_at desc, id desc);                                         -- default, updatedSince
create index demands_outside on demands (tenant_id, outside_launch_area, updated_at desc, id desc);                 -- ?outsideLaunchArea=
create index demands_ingested on demands (tenant_id, ingested_record_id);                                           -- re-upload updates

-- 3.5 offers --------------------------------------------------------------------------------------------------
create table offers (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  property_id uuid not null references properties (id),
  project_id uuid references projects (id),
  deal_type text not null,
  market text,
  sale_price_inr_min bigint,
  sale_price_inr_max bigint,
  sale_rate_inr bigint,
  sale_rate_unit text,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  deposit_inr bigint,
  current_rent_inr bigint,
  rent_rate_psf numeric(10, 2),
  yield_pct numeric(10, 2),
  deposit_months integer,
  price_negotiable boolean,
  price_text text,
  sale_mode text,
  tenancy_status text,
  tenure text,
  agreement_form text,
  possession_status text,
  furnishing text,
  deadline_date date,
  is_jodi boolean,
  possession_date text,
  possession_date_start date,
  description text,                       -- PII-sensitive free text (listings sanitises)
  revenue_share_text text,
  revenue_share_pct numeric(5, 2),
  unit_count integer,
  record_stage text not null check (record_stage in ('Captured', 'Enriched', 'Contacted', 'Verified', 'Qualified')),
  publication_level text not null default 'Private',
  publication_version bigint not null default 0,
  source_type text not null check (source_type in ('Channel', 'Digi', 'Direct')),
  capture_mode text not null check (capture_mode in ('uploaded', 'typed_in')),
  side_evidence text,
  needs_review boolean not null default false,
  review_reason text,
  review_reason_code text,
  route_to_suggestion text,
  sourced_for_demand_id uuid references demands (id),
  owner_user_id uuid,
  ingested_record_id uuid,
  source_ad_id uuid,
  first_seen_date date,
  last_seen_at timestamptz,
  times_seen integer not null default 1,
  enquiry_count integer not null default 0,
  sighting_count integer not null default 0,
  second_source_count integer not null default 0,
  has_price_gap boolean not null default false,
  closed_at timestamptz,
  retired_at timestamptz,
  renewal_of_offer_id uuid references offers (id),
  retired_reason text,
  staff_edited_fields text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'merged', 'voided')),
  void_reason text check (void_reason in ('side_changed', 'scope_changed', 'duplicate_discarded')),
  merged_into_id uuid references offers (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index offers_code on offers (tenant_id, code);                                                         -- by code, ?code=
create unique index offers_one_per_deal_type on offers (tenant_id, property_id, deal_type)
  where status = 'active' and project_id is null;                                                                   -- 409 deal-type-exists
create index offers_property on offers (tenant_id, property_id);                                                     -- property panel, merge
create index offers_project on offers (tenant_id, project_id) where project_id is not null;                          -- configurations
create index offers_deal_type on offers (tenant_id, deal_type, updated_at desc, id desc) where status = 'active';     -- ?dealType=
create index offers_deal_market on offers (tenant_id, deal_type, market, updated_at desc, id desc) where status = 'active';  -- ?dealType=Sale&market=
create index offers_stage on offers (tenant_id, record_stage, updated_at desc, id desc) where status = 'active';      -- ?recordStage=
create index offers_publication on offers (tenant_id, publication_level, updated_at desc, id desc) where status = 'active';  -- ?publicationLevel=
create index offers_owner on offers (tenant_id, owner_user_id, updated_at desc, id desc) where status = 'active';     -- ?ownerUserId=
create index offers_source on offers (tenant_id, source_type, updated_at desc, id desc) where status = 'active';      -- ?sourceType=
create index offers_sourced_for on offers (tenant_id, sourced_for_demand_id) where sourced_for_demand_id is not null;  -- ?sourcedForDemandId=
create index offers_sale_price on offers (tenant_id, deal_type, sale_price_inr_min)
  where status = 'active' and deal_type in ('Sale', 'Pagdi');                                                        -- price filter (sale)
create index offers_rent on offers (tenant_id, deal_type, rent_monthly_inr_min)
  where status = 'active' and deal_type = 'Lease';                                                                   -- price filter (lease)
create index offers_review on offers (tenant_id, needs_review, updated_at desc, id desc) where needs_review;          -- ?needsReview=true
create index offers_price_gap on offers (tenant_id, has_price_gap) where has_price_gap;                              -- ?hasPriceGap=true
create index offers_list on offers (tenant_id, updated_at desc, id desc);                                            -- default, updatedSince
create index offers_created on offers (tenant_id, created_at desc, id desc);                                          -- ?sort=createdAt
create index offers_ingested on offers (tenant_id, ingested_record_id);                                              -- re-upload updates
create unique index offers_renewal on offers (tenant_id, renewal_of_offer_id, possession_date)
  where renewal_of_offer_id is not null;                                                                            -- idempotent lease renewal
create index offers_tenancy on offers (tenant_id, tenancy_status, updated_at desc, id desc) where tenancy_status is not null;
create index offers_sale_mode on offers (tenant_id, sale_mode, updated_at desc, id desc) where sale_mode is not null;
create index offers_furnishing on offers (tenant_id, furnishing, updated_at desc, id desc) where furnishing is not null;
create index offers_possession on offers (tenant_id, possession_status, updated_at desc, id desc) where possession_status is not null;

-- 3.7 price sheets --------------------------------------------------------------------------------------------
create table price_sheets (
  id uuid primary key,
  tenant_id uuid not null,
  project_id uuid not null references projects (id),
  sheet_date date not null,
  received_via text,
  lines jsonb not null,
  created_offers uuid[] not null default '{}',
  updated_offers uuid[] not null default '{}',
  price_changed_offers uuid[] not null default '{}',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index price_sheets_project on price_sheets (tenant_id, project_id, sheet_date desc, id desc);  -- history; stale-sheet check

-- 3.16 desk items ---------------------------------------------------------------------------------------------
create table desk_items (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  desk text not null check (desk in ('business', 'capital', 'archive', 'watchlist')),
  record_scope text not null,
  side text,
  deal_types text[] not null default '{}',
  sector text,
  includes_property text,
  signal_type text,
  party_type text,
  business_description text,              -- PII-sensitive (may hold contacts from the ad)
  business_description_redacted text,
  deadline_date date,
  linked_property_id uuid references properties (id),
  person_id uuid references persons (id),
  assignee_user_id uuid,
  archived_at timestamptz,
  note text,
  outside_launch_area boolean not null default false,
  ingested_record_id uuid,
  staff_edited_fields text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'voided')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index desk_items_code on desk_items (tenant_id, code);
create index desk_items_desk on desk_items (tenant_id, desk, (archived_at is not null), created_at desc, id desc);  -- /v1/desks/{desk}
create index desk_items_watchlist on desk_items (tenant_id, desk, (archived_at is not null), deadline_date, id)
  where desk = 'watchlist';                                                                                        -- watchlist by deadline
create index desk_items_assignee on desk_items (tenant_id, desk, assignee_user_id, created_at desc, id desc);        -- ?assigneeUserId=
create index desk_items_sector on desk_items (tenant_id, desk, sector, created_at desc, id desc);                    -- ?sector=
create index desk_items_deal_types on desk_items using gin (tenant_id, deal_types);                                  -- ?dealType=
create index desk_items_ingested on desk_items (tenant_id, ingested_record_id);                                      -- re-upload updates

-- 3.9 touches -------------------------------------------------------------------------------------------------
create table touches (
  id uuid primary key,
  tenant_id uuid not null,
  demand_id uuid not null references demands (id),
  source_type text not null check (source_type in ('Channel', 'Digi', 'Direct')),
  capture_mode text not null check (capture_mode in ('uploaded', 'typed_in')),
  source_detail text,
  occurred_at timestamptz not null,
  is_first_touch boolean not null default false,
  source_ad_id uuid,
  enquiry_id uuid,
  referrer_person_id uuid references persons (id),
  upload_id uuid,
  row_id uuid,
  created_at timestamptz not null default now()
);
create unique index touches_first on touches (tenant_id, demand_id) where is_first_touch;                    -- first-touch invariant (A-16)
create index touches_demand on touches (tenant_id, demand_id, occurred_at, id);                               -- GET …/touches
create unique index touches_row on touches (tenant_id, row_id, demand_id) where row_id is not null;           -- idempotent ingestion

-- 3.10 enquiries ----------------------------------------------------------------------------------------------
create table enquiries (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  person_id uuid references persons (id),
  source_export text,
  campaign_ref text,
  form_ref text,
  listing_ref text,
  offer_id uuid references offers (id),
  project_id uuid references projects (id),
  demand_id uuid references demands (id),
  touch_id uuid,
  message text,                           -- PII
  received_at timestamptz not null,
  upload_id uuid,
  row_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index enquiries_code on enquiries (tenant_id, code);
create unique index enquiries_row on enquiries (tenant_id, row_id) where row_id is not null;           -- idempotent ingestion
create index enquiries_offer on enquiries (tenant_id, offer_id, received_at desc, id desc);             -- ?offerId=
create index enquiries_project on enquiries (tenant_id, project_id, received_at desc, id desc);         -- ?projectId=
create index enquiries_demand on enquiries (tenant_id, demand_id, received_at desc, id desc);           -- ?demandId=
create index enquiries_campaign on enquiries (tenant_id, campaign_ref, received_at desc, id desc);     -- ?campaignRef=
create index enquiries_list on enquiries (tenant_id, received_at desc, id desc);                       -- default, receivedSince
create index enquiries_person on enquiries (tenant_id, person_id) where person_id is not null;         -- person panel, merge, purge

-- 3.11 record parties -----------------------------------------------------------------------------------------
create table record_parties (
  id uuid primary key,
  tenant_id uuid not null,
  subject_type text not null check (subject_type in ('property', 'offer', 'demand', 'project', 'desk_item')),
  subject_id uuid not null,
  person_id uuid not null references persons (id),
  role text not null,
  party_type_at_capture text,
  created_at timestamptz not null default now()
);
create unique index record_parties_subject on record_parties (tenant_id, subject_type, subject_id, person_id, role);  -- idempotent linking; panels
create index record_parties_person on record_parties (tenant_id, person_id);                                        -- person panel, merge, dedup

-- 3.12 source ads, sightings, second sources ------------------------------------------------------------------
create table source_ads (
  id uuid primary key,
  tenant_id uuid not null,
  code text not null,
  external_ref text not null,
  source_channel text,
  source_name text,
  source_edition text,
  source_supplement text,
  source_files text,
  source_language text,
  source_date date,
  source_page integer,
  ocr_used boolean,
  extraction_confidence numeric(3, 2),
  extractor_notes text,
  raw_text text,                          -- PII
  text_variants text,                     -- PII
  sender_name text,                       -- PII
  sender_phone text,                      -- PII
  sender_phone_hash text,
  split_count integer not null default 0,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index source_ads_code on source_ads (tenant_id, code);
create unique index source_ads_ref on source_ads (tenant_id, external_ref);                              -- one ad per parent ref (Z-3); ?externalRef=
create index source_ads_source on source_ads (tenant_id, source_name, source_date desc, id desc);        -- ?sourceName=&sourceDate=
create index source_ads_list on source_ads (tenant_id, created_at desc, id desc);                       -- default; ?hasSplits=
create index source_ads_sender on source_ads (tenant_id, sender_phone_hash) where sender_phone_hash is not null;  -- sender → person

create table sightings (
  id uuid primary key,
  tenant_id uuid not null,
  subject_type text not null check (subject_type in ('offer', 'demand', 'property', 'person', 'desk_item')),
  subject_id uuid not null,
  source_ad_id uuid references source_ads (id),
  upload_id uuid,
  row_id uuid,
  external_ref text,
  split_index text,
  source_type text,
  source_name text,
  seen_on date not null,
  created_at timestamptz not null default now()
);
create index sightings_subject on sightings (tenant_id, subject_type, subject_id, seen_on desc, id desc);  -- property sightings
create unique index sightings_row on sightings (tenant_id, row_id, subject_type, subject_id) where row_id is not null;  -- idempotent ingestion
create index sightings_source_ad on sightings (tenant_id, source_ad_id);                                   -- source ad children

create table second_sources (
  id uuid primary key,
  tenant_id uuid not null,
  property_id uuid not null references properties (id),
  offer_id uuid references offers (id),
  source_ad_id uuid references source_ads (id),
  person_id uuid references persons (id),
  source_type text,
  source_name text,
  sale_price_inr_min bigint,
  sale_price_inr_max bigint,
  rent_monthly_inr_min bigint,
  rent_monthly_inr_max bigint,
  price_gap_pct numeric(6, 2),
  price_gap boolean not null default false,
  status text not null default 'open' check (status in ('open', 'accepted', 'dismissed')),
  seen_on date not null,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index second_sources_property on second_sources (tenant_id, property_id, seen_on desc, id desc);    -- property second sources
create index second_sources_queue on second_sources (tenant_id, status, price_gap, seen_on, id);          -- price-gap queue
create unique index second_sources_ad on second_sources (tenant_id, property_id, source_ad_id) where source_ad_id is not null;  -- idempotent ingestion
create index second_sources_offer on second_sources (tenant_id, offer_id) where offer_id is not null;     -- merge re-pointing

-- 3.13 ingested records, 3.14 unrouted rows -------------------------------------------------------------------
create table ingested_records (
  id uuid primary key,
  tenant_id uuid not null,
  external_source text not null check (external_source in ('extractor', 'upload')),
  external_ref text not null,
  parent_external_ref text,
  split_index text,
  record_scope text,
  source_channel text,
  content_hash text not null,
  primary_subject_type text check (primary_subject_type in ('offer', 'demand', 'desk_item', 'person', 'unrouted')),
  primary_subject_id uuid,
  property_id uuid,
  desk_item_id uuid,
  source_ad_id uuid,
  status text not null default 'active' check (status in ('active', 'rekeyed', 'merged', 'split')),
  replaced_by_refs text[],
  last_upload_id uuid,
  last_row_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ingested_records_ref on ingested_records (tenant_id, external_source, external_ref);   -- upsert lookup; map; repeats
create index ingested_records_parent on ingested_records (tenant_id, parent_external_ref)
  where parent_external_ref is not null;                                                                  -- split-sibling rule
create index ingested_records_subject on ingested_records (tenant_id, primary_subject_type, primary_subject_id);  -- subject → ref
create index ingested_records_row on ingested_records (tenant_id, last_row_id) where last_row_id is not null;    -- review resolution by row
create index ingested_records_source_ad on ingested_records (tenant_id, source_ad_id) where source_ad_id is not null;  -- source ad children
create index ingested_records_property on ingested_records (tenant_id, property_id) where property_id is not null;     -- dedup lineage rules

create table unrouted_rows (
  id uuid primary key,
  tenant_id uuid not null,
  external_source text not null,
  external_ref text not null,
  upload_id uuid,
  batch_no integer,
  row_id uuid,
  row_snapshot jsonb,                     -- PII (the IntakeRow)
  status text not null default 'waiting' check (status in ('waiting', 'routed')),
  routed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index unrouted_rows_ref on unrouted_rows (tenant_id, external_source, external_ref);  -- resolution lookup
create index unrouted_rows_status on unrouted_rows (tenant_id, status, created_at);                -- monitoring; snapshot purge

-- 3.15 merges -------------------------------------------------------------------------------------------------
create table merge_candidates (
  id uuid primary key,
  tenant_id uuid not null,
  aggregate_type text not null check (aggregate_type in ('property', 'offer', 'demand', 'person')),
  left_id uuid not null,
  right_id uuid,
  right_external_ref text,
  pair_low text not null,                 -- ordered pair key (uuid text, or 'ref:<externalRef>' while pending)
  pair_high text not null,
  reason text not null check (reason in ('possible_repeat', 'property_match', 'demand_similarity', 'person_phone')),
  score numeric(4, 3) not null,
  evidence jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'pending_target', 'merged', 'different', 'skipped')),
  upload_id uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index merge_candidates_pair on merge_candidates (tenant_id, aggregate_type, pair_low, pair_high);  -- never propose a pair twice
create index merge_candidates_queue on merge_candidates (tenant_id, status, aggregate_type, score desc, id);     -- review queue
create index merge_candidates_reason on merge_candidates (tenant_id, status, reason, score desc, id);           -- ?reason=
create index merge_candidates_upload on merge_candidates (tenant_id, upload_id, status);                        -- ?uploadId=
create index merge_candidates_pending on merge_candidates (tenant_id, right_external_ref)
  where status = 'pending_target';                                                                              -- resolve-pending-repeats
create index merge_candidates_list on merge_candidates (tenant_id, score desc, id);                              -- unfiltered queue

create table merges (
  id uuid primary key,
  tenant_id uuid not null,
  aggregate_type text not null check (aggregate_type in ('property', 'offer', 'demand', 'person')),
  survivor_id uuid not null,
  merged_ids uuid[] not null,
  candidate_id uuid references merge_candidates (id),
  source text not null check (source in ('user', 'migration_map', 'demand_dedup')),
  status text not null default 'active' check (status in ('active', 'undone')),
  moved_counts jsonb not null default '{}',
  performed_by uuid,
  performed_at timestamptz not null default now(),
  undone_by uuid,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index merges_survivor on merges (tenant_id, survivor_id, status);    -- undo-blocked check; merged-from history
create index merges_merged_ids on merges using gin (tenant_id, merged_ids);  -- was this record merged?

create table merge_undo_log (
  tenant_id uuid not null,
  merge_id uuid not null references merges (id),
  seq integer not null,
  table_name text not null,
  row_id uuid not null,
  column_name text not null,
  old_value jsonb,
  new_value jsonb,
  op text not null check (op in ('update', 'insert', 'delete')),
  primary key (tenant_id, merge_id, seq)      -- undo replays in reverse seq
);

-- 3.17 photos, market data ------------------------------------------------------------------------------------
create table photos (
  id uuid primary key,
  tenant_id uuid not null,
  property_id uuid not null references properties (id),
  origin text not null check (origin in ('call', 'visit', 'source_share', 'sheet_link', 'upload')),
  is_real boolean not null default false,
  status text not null check (status in ('pending_upload', 'ready', 'fetch_failed', 'rejected')),
  storage_path text not null,
  content_type text,
  size_bytes integer,
  width integer,
  height integer,
  sha256 text,
  has_text_detected boolean,
  source_url text,
  fetch_error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index photos_property on photos (tenant_id, property_id, created_at, id);                      -- list; 30-photo cap
create unique index photos_sha on photos (tenant_id, property_id, sha256) where status = 'ready';      -- duplicate image guard
create index photos_pending on photos (tenant_id, status, created_at) where status = 'pending_upload';  -- abandoned tickets

create table offer_photos (
  tenant_id uuid not null,
  offer_id uuid not null references offers (id),
  photo_id uuid not null references photos (id),
  sort integer not null default 0,
  primary key (tenant_id, offer_id, photo_id)   -- photos of an offer
);
create index offer_photos_photo on offer_photos (tenant_id, photo_id);  -- offers using a photo

create table market_data_points (
  id uuid primary key,
  tenant_id uuid not null,
  property_id uuid,
  offer_id uuid,
  deal_id uuid,
  demand_id uuid,
  micromarket_id uuid,
  locality text,
  deal_type text,
  segment text,
  property_type text,
  area_basis text,
  source text not null check (source in ('closed_by_us', 'closed_elsewhere', 'reported', 'lost_competing')),
  notes text,
  price_inr bigint,
  rent_monthly_inr bigint,
  area_sqft numeric(12, 2),
  observed_on date not null,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index market_data_micromarket on market_data_points (tenant_id, micromarket_id, observed_on desc, id desc);  -- ?micromarketId=
create index market_data_deal_segment on market_data_points (tenant_id, deal_type, segment, observed_on desc, id desc);  -- ?dealType=&segment=
create index market_data_list on market_data_points (tenant_id, observed_on desc, id desc);                          -- default list
create unique index market_data_deal on market_data_points (tenant_id, deal_id, source) where deal_id is not null;   -- idempotent close
create unique index market_data_demand on market_data_points (tenant_id, demand_id, source) where demand_id is not null;  -- lost_competing once
create unique index market_data_offer on market_data_points (tenant_id, offer_id, source)
  where offer_id is not null and source = 'closed_elsewhere';                                                        -- retired offer once

-- 3.19 ingestion ledgers and consumer state -------------------------------------------------------------------
create table upload_batches (
  id uuid primary key,
  tenant_id uuid not null,
  upload_id uuid not null,
  batch_no integer not null,
  status text not null default 'applied' check (status in ('applied')),
  rows_applied integer not null default 0,
  applied_at timestamptz not null default now()
);
create unique index upload_batches_batch on upload_batches (tenant_id, upload_id, batch_no);  -- batch-level idempotency

create table upload_migrations (
  id uuid primary key,
  tenant_id uuid not null,
  upload_id uuid not null,
  status text not null check (status in ('applying', 'applied')),
  entries_applied integer not null default 0,
  cursor text,                            -- intake migration-map page cursor (resumable)
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index upload_migrations_upload on upload_migrations (tenant_id, upload_id);  -- "is the map applied?"

create table inbound_versions (
  tenant_id uuid not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  last_version bigint not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, aggregate_type, aggregate_id)   -- ignore stale journeys/listings events (conventions §5)
);

-- Contact reveals (§4.14): the audit id per reveal and the 60/hour/user rate limit window. No PII values.
create table reveal_log (
  id uuid primary key,                    -- = auditId
  tenant_id uuid not null,
  user_id uuid not null,
  subject_type text not null,
  subject_id uuid not null,
  purpose text not null,
  fields text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index reveal_log_user on reveal_log (tenant_id, user_id, created_at desc);  -- 60 reveals/hour per user
