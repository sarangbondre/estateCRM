// Database types of the listings schema (migrations 0001 technical tables, 0002 business tables; LLD §3).
import type { ColumnType, Generated, IdempotencyKeysTable } from '@11e/db';
import type { JobLeasesTable } from '@11e/http';
import type { OutboxDb } from '@11e/outbox';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** numeric columns come back as strings from pg. */
type Numeric = ColumnType<string | null, number | string | null | undefined, number | string | null>;
type Json<T> = ColumnType<T, string, string>;

export interface OfferInputTable {
  tenant_id: string;
  id: string;
  code: string;
  property_id: string;
  project_id: string | null;
  deal_type: string;
  market: string | null;
  segment: string | null;
  property_types: string[];
  bhk_min: Numeric;
  bhk_max: Numeric;
  area_sqft_min: Numeric;
  area_sqft_max: Numeric;
  area_basis: string | null;
  land_area_sqft: Numeric;
  sale_price_inr_min: ColumnType<string | null, number | null | undefined, number | null>;
  sale_price_inr_max: ColumnType<string | null, number | null | undefined, number | null>;
  rent_monthly_inr_min: ColumnType<string | null, number | null | undefined, number | null>;
  rent_monthly_inr_max: ColumnType<string | null, number | null | undefined, number | null>;
  locality: string | null;
  micromarket: string | null;
  city: string | null;
  outside_launch_area: Generated<boolean>;
  tenancy_status: string | null;
  sale_mode: string | null;
  possession_status: string | null;
  furnishing: string | null;
  possession_date: string | null;
  unit_count: number | null;
  floor_band: string | null;
  total_floors: number | null;
  parking: number | null;
  amenities: Generated<string[]>;
  selected_photo_ids: Generated<string[]>;
  public_description_source: string | null;
  voided_reason: string | null;
  record_stage: string | null;
  has_real_photos: Generated<boolean>;
  commercial_status: string | null;
  life_stage: string | null;
  life_day: number | null;
  retired_reason: string | null;
  merged_into_id: string | null;
  records_version: Generated<number>;
  journeys_version: Generated<number>;
  scan_terms_fetched_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: NullableTimestamp;
}

export interface ProjectInputTable {
  tenant_id: string;
  id: string;
  code: string;
  name: string;
  developer_person_id: string | null;
  developer_name: string | null;
  city: string | null;
  micromarket: string | null;
  locality: string | null;
  rera_number: string | null;
  possession_date: string | null;
  amenities: Generated<string[]>;
  offer_ids: Generated<string[]>;
  records_version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: NullableTimestamp;
}

export interface DemandInputTable {
  tenant_id: string;
  id: string;
  code: string;
  deal_types: Generated<string[]>;
  market: string | null;
  segment: string | null;
  property_types: Generated<string[]>;
  micromarkets: Generated<string[]>;
  area_sqft_min: Numeric;
  area_sqft_max: Numeric;
  area_basis: string | null;
  budget_inr_min: ColumnType<string | null, number | null | undefined, number | null>;
  budget_inr_max: ColumnType<string | null, number | null | undefined, number | null>;
  rent_monthly_inr_min: ColumnType<string | null, number | null | undefined, number | null>;
  rent_monthly_inr_max: ColumnType<string | null, number | null | undefined, number | null>;
  move_in_by: string | null;
  outside_launch_area: Generated<boolean>;
  commercial_status: string | null;
  life_stage: string | null;
  exit_type: string | null;
  matched: Generated<boolean>;
  post_requested: Generated<boolean>;
  sourcing_request_id: string | null;
  voided_reason: string | null;
  merged_into_id: string | null;
  records_version: Generated<number>;
  journeys_version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: NullableTimestamp;
}

export interface PublicationTable {
  tenant_id: string;
  id: string;
  subject_type: string;
  subject_id: string;
  level: string;
  ceiling: string;
  ceiling_reasons: string[];
  life_stage: string | null;
  public_id: string | null;
  public_description: string | null; // PII-possible
  description_source: string;
  last_scan_id: string | null;
  last_change_reason: string | null;
  last_changed_by: string | null;
  published_at: NullableTimestamp;
  version: number;
  created_at: Generated<Date>;
  updated_at: Timestamp;
}

export interface PublicItemTable {
  tenant_id: string;
  id: string;
  public_id: string;
  subject_type: string;
  level: string;
  payload: Json<Record<string, unknown>>;
  payload_hash: string;
  deal_type: string | null;
  deal_types: string[] | null;
  market: string | null;
  segment: string | null;
  city: string | null;
  micromarket: string | null;
  locality: string | null;
  micromarket_path: string[];
  property_types: string[];
  bhk_min: Numeric;
  bhk_max: Numeric;
  area_sqft_min: Numeric;
  area_sqft_max: Numeric;
  sale_price_inr_min: ColumnType<string | null, number | null | undefined, number | null>;
  rent_monthly_inr_min: ColumnType<string | null, number | null | undefined, number | null>;
  price_sort_inr: ColumnType<string | null, number | null | undefined, number | null>;
  possession_sort: ColumnType<Date | null, string | null | undefined, string | null>;
  sale_mode: string | null;
  tenancy_status: string | null;
  furnishing: string | null;
  project_public_id: string | null;
  published_at: Timestamp;
  created_at: Generated<Date>;
  updated_at: Timestamp;
}

export interface ChangeFeedTable {
  tenant_id: string;
  id: string;
  seq: ColumnType<string, never, never>;
  public_id: string;
  subject_type: string;
  change_type: string;
  level: string | null;
  occurred_at: Timestamp;
  created_at: Generated<Date>;
}

export interface PhotoTable {
  tenant_id: string;
  id: string;
  property_id: string;
  origin: string;
  is_real: boolean;
  source_storage_path: string;
  has_text_detected: boolean | null;
  status: string;
  private_path: string | null;
  public_path: string | null;
  public_name: string | null;
  width: number | null;
  height: number | null;
  sort_order: number;
  attempts: number;
  created_at: Generated<Date>;
  updated_at: NullableTimestamp;
}

export interface PrivateTermTable {
  tenant_id: string;
  id: string;
  property_id: string;
  kind: string;
  token_hash: string; // sensitive
  ngram: number;
  salt_key_id: string;
  fetched_at: Timestamp;
  created_at: Generated<Date>;
}

export interface PrivacyScanTable {
  tenant_id: string;
  id: string;
  subject_type: string;
  subject_id: string;
  text_sha256: string;
  rules_version: string;
  result: string;
  findings: Json<unknown[]>;
  scanned_by: string;
  created_at: Timestamp;
}

export interface SettingsTable {
  tenant_id: string;
  id: string;
  maharera_agent_number: string | null;
  subject_to_confirmation_note: string;
  version: number;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Timestamp;
}

export interface ApiKeyTable {
  tenant_id: string;
  id: string;
  name: string;
  prefix: string;
  key_hash: string; // sensitive
  status: string;
  rate_limit_rps: number;
  burst: number;
  allowed_origins: string[];
  grace_ends_at: NullableTimestamp;
  replaced_by_key_id: string | null;
  last_used_at: NullableTimestamp;
  created_by: string;
  revoked_at: NullableTimestamp;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RateLimitBucketTable {
  api_key_id: string;
  tenant_id: string;
  tokens: ColumnType<string, number | string, number | string>;
  refilled_at: Timestamp;
}

export interface MergeLogTable {
  tenant_id: string;
  id: string;
  merge_id: string;
  subject_type: string;
  subject_id: string;
  prior: Json<Record<string, unknown>>;
  created_at: Generated<Date>;
}

export interface VocabularyReleaseTable {
  tenant_id: string;
  id: string;
  version: string;
  checksum: string;
  values: Json<Record<string, unknown>>;
  micromarkets: Json<Record<string, string[]>>;
  active: boolean;
  created_at: Generated<Date>;
  updated_at: NullableTimestamp;
}

export interface JobCheckpointTable {
  name: string;
  cursor: Json<Record<string, unknown>>;
  updated_at: Timestamp;
}

export interface ListingsDb extends OutboxDb {
  idempotency_keys: IdempotencyKeysTable;
  job_leases: JobLeasesTable;
  schema_migrations: { version: string; name: string; checksum: string; applied_at: Date };
  offer_input: OfferInputTable;
  project_input: ProjectInputTable;
  demand_input: DemandInputTable;
  publication: PublicationTable;
  public_item: PublicItemTable;
  change_feed: ChangeFeedTable;
  photo: PhotoTable;
  private_term: PrivateTermTable;
  privacy_scan: PrivacyScanTable;
  settings: SettingsTable;
  api_key: ApiKeyTable;
  rate_limit_bucket: RateLimitBucketTable;
  merge_log: MergeLogTable;
  vocabulary_release: VocabularyReleaseTable;
  job_checkpoint: JobCheckpointTable;
}
