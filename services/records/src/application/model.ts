// Stored shapes of the records schema (records LLD §3), as the application reads and writes them.
// snake_case = column names; `date` columns are `YYYY-MM-DD` strings; numeric/bigint are numbers.
// PII columns are marked; they never reach logs or events.

export interface Row {
  id: string;
  tenant_id: string;
  created_at: Date;
  updated_at: Date;
}
export interface Versioned extends Row {
  version: number;
}

export interface CodeSequenceRow {
  tenant_id: string;
  prefix: string;
  next_value: number;
  pad: number;
}

export interface MicromarketRow extends Versioned {
  parent_id: string | null;
  level: 'zone' | 'micromarket' | 'locality' | 'sub_locality';
  name: string;
  name_norm: string;
  aliases: string[];
  aliases_norm: string[];
  city: string;
  city_norm: string;
  in_launch_area: boolean;
}

export interface MicromarketAdjacencyRow {
  tenant_id: string;
  micromarket_id: string;
  adjacent_id: string;
  created_at: Date;
}

export interface ReferenceVersionRow {
  tenant_id: string;
  kind: string;
  version: number;
  recompute_status: 'queued' | 'running' | 'done' | null;
  recompute_cursor: unknown;
  updated_at: Date;
}

export interface LaunchAreaCityRow extends Row {
  city_norm: string;
  name: string;
  enabled: boolean;
  version: number;
}

export interface VocabularyReleaseRow extends Row {
  version: string;
  checksum: string;
  status: 'pending' | 'active' | 'superseded';
  content: unknown;
  activated_at: Date | null;
}

export interface PersonRow extends Versioned {
  code: string;
  name: string | null; // PII
  name_initials: string | null;
  company_name: string | null;
  company_norm: string | null;
  party_type: string | null;
  participant_role: string | null;
  other_contact: string | null; // PII
  flags: string[];
  dependencies: unknown;
  status: 'active' | 'merged';
  merged_into_id: string | null;
  last_activity_at: Date;
  purged_at: Date | null;
}

export interface PersonPhoneRow {
  id: string;
  tenant_id: string;
  person_id: string;
  phone_e164: string; // PII
  phone_hash: string;
  kind: 'phone' | 'whatsapp';
  is_primary: boolean;
  created_at: Date;
}

export interface PersonEmailRow {
  id: string;
  tenant_id: string;
  person_id: string;
  email: string; // PII
  email_hash: string;
  is_primary: boolean;
  created_at: Date;
}

export interface ProjectRow extends Versioned {
  code: string;
  name: string;
  name_norm: string;
  developer_person_id: string | null;
  developer_name: string | null;
  locality: string | null;
  locality_norm: string | null;
  city: string | null;
  city_norm: string | null;
  state: string | null;
  landmark: string | null;
  location_text: string | null;
  micromarket_id: string | null;
  rera_number: string | null;
  possession_date: string | null;
  amenities: string[];
  floor_plan_photo_ids: string[];
  latest_price_sheet_date: string | null;
  publication_level: string;
  publication_version: number;
  outside_launch_area: boolean;
  staff_edited_fields: string[];
}

export interface PropertyRow extends Versioned {
  code: string;
  segment: string | null;
  property_types: string[];
  property_detail: string | null;
  land_use: string | null;
  locality: string | null;
  locality_norm: string | null;
  micromarket_id: string | null;
  city: string | null;
  city_norm: string | null;
  state: string | null;
  landmark: string | null;
  location_text: string | null;
  building_name: string | null;
  building_norm: string | null;
  wing: string | null; // PII
  unit_no: string | null; // PII
  floor_no: number | null; // PII
  floor_band: 'Low' | 'Mid' | 'High' | null;
  parking: number | null;
  building_key: string | null;
  total_floors: number | null;
  area_sqft_min: number | null;
  area_sqft_max: number | null;
  area_basis: string | null;
  land_area_value: number | null;
  land_area_unit: string | null;
  land_area_sqft: number | null;
  area_text: string | null;
  bhk_min: number | null;
  bhk_max: number | null;
  features: string | null;
  amenities: string[];
  project_id: string | null;
  outside_launch_area: boolean;
  photo_count: number;
  has_real_photos: boolean;
  staff_edited_fields: string[];
  last_seen_at: Date | null;
  status: 'active' | 'merged';
  merged_into_id: string | null;
}

export type RecordStatus = 'active' | 'merged' | 'voided';
export type VoidReason = 'side_changed' | 'scope_changed' | 'duplicate_discarded';
export type SourceType = 'Channel' | 'Digi' | 'Direct';
export type CaptureMode = 'uploaded' | 'typed_in';

export interface OfferRow extends Versioned {
  code: string;
  property_id: string;
  project_id: string | null;
  deal_type: string;
  market: string | null;
  sale_price_inr_min: number | null;
  sale_price_inr_max: number | null;
  sale_rate_inr: number | null;
  sale_rate_unit: string | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
  deposit_inr: number | null;
  current_rent_inr: number | null;
  rent_rate_psf: number | null;
  yield_pct: number | null;
  deposit_months: number | null;
  price_negotiable: boolean | null;
  price_text: string | null;
  sale_mode: string | null;
  tenancy_status: string | null;
  tenure: string | null;
  agreement_form: string | null;
  possession_status: string | null;
  furnishing: string | null;
  deadline_date: string | null;
  is_jodi: boolean | null;
  possession_date: string | null;
  possession_date_start: string | null;
  description: string | null; // PII-sensitive
  revenue_share_text: string | null;
  revenue_share_pct: number | null;
  unit_count: number | null;
  record_stage: string;
  publication_level: string;
  publication_version: number;
  source_type: SourceType;
  capture_mode: CaptureMode;
  side_evidence: string | null;
  needs_review: boolean;
  review_reason: string | null;
  review_reason_code: string | null;
  route_to_suggestion: string | null;
  sourced_for_demand_id: string | null;
  owner_user_id: string | null;
  ingested_record_id: string | null;
  source_ad_id: string | null;
  first_seen_date: string | null;
  last_seen_at: Date | null;
  times_seen: number;
  enquiry_count: number;
  sighting_count: number;
  second_source_count: number;
  has_price_gap: boolean;
  closed_at: Date | null;
  retired_at: Date | null;
  renewal_of_offer_id: string | null;
  retired_reason: string | null;
  staff_edited_fields: string[];
  status: RecordStatus;
  void_reason: VoidReason | null;
  merged_into_id: string | null;
}

export interface PriceSheetRow extends Row {
  project_id: string;
  sheet_date: string;
  received_via: string | null;
  lines: unknown;
  created_offers: string[];
  updated_offers: string[];
  price_changed_offers: string[];
  created_by: string;
}

export interface DemandRow extends Versioned {
  code: string;
  person_id: string | null;
  company_name: string | null;
  company_norm: string | null;
  deal_types: string[];
  market: string | null;
  segment: string | null;
  property_types: string[];
  micromarket_ids: string[];
  localities: string[];
  budget_inr_min: number | null;
  budget_inr_max: number | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
  area_sqft_min: number | null;
  area_sqft_max: number | null;
  area_basis: string | null;
  bhk_min: number | null;
  bhk_max: number | null;
  move_in_from: string | null;
  move_in_by: string | null;
  move_in_text: string | null;
  stated_tags: Record<string, unknown>;
  decision_maker: string | null;
  introducing_broker_person_id: string | null;
  shared_commission_note: string | null;
  shared_commission_pct: number | null;
  record_stage: string;
  publication_level: string;
  publication_version: number;
  owner_user_id: string | null;
  source_type: SourceType;
  capture_mode: CaptureMode;
  side_evidence: string | null;
  needs_review: boolean;
  review_reason: string | null;
  review_reason_code: string | null;
  first_touch_id: string | null;
  touch_count: number;
  ingested_record_id: string | null;
  source_ad_id: string | null;
  outside_launch_area: boolean;
  closed_at: Date | null;
  exit_state: 'Lost' | 'Dormant' | 'Invalid' | null;
  exit_version: number;
  last_seen_at: Date | null;
  staff_edited_fields: string[];
  status: RecordStatus;
  void_reason: VoidReason | null;
  merged_into_id: string | null;
}

export interface TouchRow {
  id: string;
  tenant_id: string;
  demand_id: string;
  source_type: SourceType;
  capture_mode: CaptureMode;
  source_detail: string | null;
  occurred_at: Date;
  is_first_touch: boolean;
  source_ad_id: string | null;
  enquiry_id: string | null;
  referrer_person_id: string | null;
  upload_id: string | null;
  row_id: string | null;
  created_at: Date;
}

export interface EnquiryRow extends Row {
  code: string;
  person_id: string | null;
  source_export: string | null;
  campaign_ref: string | null;
  form_ref: string | null;
  listing_ref: string | null;
  offer_id: string | null;
  project_id: string | null;
  demand_id: string | null;
  touch_id: string | null;
  message: string | null; // PII
  received_at: Date;
  upload_id: string | null;
  row_id: string | null;
}

export type PartySubject = 'property' | 'offer' | 'demand' | 'project' | 'desk_item';
export interface RecordPartyRow {
  id: string;
  tenant_id: string;
  subject_type: PartySubject;
  subject_id: string;
  person_id: string;
  role: string;
  party_type_at_capture: string | null;
  created_at: Date;
}

export interface SourceAdRow extends Row {
  code: string;
  external_ref: string;
  source_channel: string | null;
  source_name: string | null;
  source_edition: string | null;
  source_supplement: string | null;
  source_files: string | null;
  source_language: string | null;
  source_date: string | null;
  source_page: number | null;
  ocr_used: boolean | null;
  extraction_confidence: number | null;
  extractor_notes: string | null;
  raw_text: string | null; // PII
  text_variants: string | null; // PII
  sender_name: string | null; // PII
  sender_phone: string | null; // PII
  sender_phone_hash: string | null;
  split_count: number;
  purged_at: Date | null;
}

export type SightingSubject = 'offer' | 'demand' | 'property' | 'person' | 'desk_item';
export interface SightingRow {
  id: string;
  tenant_id: string;
  subject_type: SightingSubject;
  subject_id: string;
  source_ad_id: string | null;
  upload_id: string | null;
  row_id: string | null;
  external_ref: string | null;
  split_index: string | null;
  source_type: string | null;
  source_name: string | null;
  seen_on: string;
  created_at: Date;
}

export interface SecondSourceRow extends Row {
  property_id: string;
  offer_id: string | null;
  source_ad_id: string | null;
  person_id: string | null;
  source_type: string | null;
  source_name: string | null;
  sale_price_inr_min: number | null;
  sale_price_inr_max: number | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
  price_gap_pct: number | null;
  price_gap: boolean;
  status: 'open' | 'accepted' | 'dismissed';
  seen_on: string;
  resolved_by: string | null;
  resolved_at: Date | null;
}

export type SubjectKind = 'offer' | 'demand' | 'desk_item' | 'person' | 'unrouted';
export interface IngestedRecordRow extends Row {
  external_source: 'extractor' | 'upload';
  external_ref: string;
  parent_external_ref: string | null;
  split_index: string | null;
  record_scope: string | null;
  source_channel: string | null;
  content_hash: string;
  primary_subject_type: SubjectKind | null;
  primary_subject_id: string | null;
  property_id: string | null;
  desk_item_id: string | null;
  source_ad_id: string | null;
  status: 'active' | 'rekeyed' | 'merged' | 'split';
  replaced_by_refs: string[] | null;
  last_upload_id: string | null;
  last_row_id: string | null;
}

export interface UnroutedRowRow extends Row {
  external_source: string;
  external_ref: string;
  upload_id: string | null;
  batch_no: number | null;
  row_id: string | null;
  row_snapshot: unknown; // PII
  status: 'waiting' | 'routed';
  routed_at: Date | null;
}

export type CandidateReason = 'possible_repeat' | 'property_match' | 'demand_similarity' | 'person_phone';
export type CandidateStatus = 'open' | 'pending_target' | 'merged' | 'different' | 'skipped';
export type AggregateKind = 'property' | 'offer' | 'demand' | 'person';
export interface MergeCandidateRow extends Row {
  aggregate_type: AggregateKind;
  left_id: string;
  right_id: string | null;
  right_external_ref: string | null;
  pair_low: string;
  pair_high: string;
  reason: CandidateReason;
  score: number;
  evidence: unknown;
  status: CandidateStatus;
  upload_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  note: string | null;
}

export interface MergeRow extends Row {
  aggregate_type: AggregateKind;
  survivor_id: string;
  merged_ids: string[];
  candidate_id: string | null;
  source: 'user' | 'migration_map' | 'demand_dedup';
  status: 'active' | 'undone';
  moved_counts: Record<string, number>;
  performed_by: string | null;
  performed_at: Date;
  undone_by: string | null;
  undone_at: Date | null;
}

export interface MergeUndoLogRow {
  tenant_id: string;
  merge_id: string;
  seq: number;
  table_name: string;
  row_id: string;
  column_name: string;
  old_value: unknown;
  new_value: unknown;
  op: 'update' | 'insert' | 'delete';
}

export type Desk = 'business' | 'capital' | 'archive' | 'watchlist';
export interface DeskItemRow extends Versioned {
  code: string;
  desk: Desk;
  record_scope: string;
  side: string | null;
  deal_types: string[];
  sector: string | null;
  includes_property: string | null;
  signal_type: string | null;
  party_type: string | null;
  business_description: string | null; // PII-sensitive
  business_description_redacted: string | null;
  deadline_date: string | null;
  linked_property_id: string | null;
  person_id: string | null;
  assignee_user_id: string | null;
  archived_at: Date | null;
  note: string | null;
  outside_launch_area: boolean;
  ingested_record_id: string | null;
  staff_edited_fields: string[];
  status: 'active' | 'voided';
}

export interface PhotoRow extends Row {
  property_id: string;
  origin: 'call' | 'visit' | 'source_share' | 'sheet_link' | 'upload';
  is_real: boolean;
  status: 'pending_upload' | 'ready' | 'fetch_failed' | 'rejected';
  storage_path: string;
  content_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  has_text_detected: boolean | null;
  source_url: string | null;
  fetch_error: string | null;
  created_by: string | null;
}

export interface OfferPhotoRow {
  tenant_id: string;
  offer_id: string;
  photo_id: string;
  sort: number;
}

export type MarketSource = 'closed_by_us' | 'closed_elsewhere' | 'reported' | 'lost_competing';
export interface MarketDataRow extends Row {
  property_id: string | null;
  offer_id: string | null;
  deal_id: string | null;
  demand_id: string | null;
  micromarket_id: string | null;
  locality: string | null;
  deal_type: string | null;
  segment: string | null;
  property_type: string | null;
  area_basis: string | null;
  source: MarketSource;
  notes: string | null;
  price_inr: number | null;
  rent_monthly_inr: number | null;
  area_sqft: number | null;
  observed_on: string;
  voided_at: Date | null;
}

export interface UploadBatchRow {
  id: string;
  tenant_id: string;
  upload_id: string;
  batch_no: number;
  status: 'applied';
  rows_applied: number;
  applied_at: Date;
}

export interface UploadMigrationRow extends Row {
  upload_id: string;
  status: 'applying' | 'applied';
  entries_applied: number;
  cursor: string | null;
  applied_at: Date | null;
}

export interface InboundVersionRow {
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  last_version: number;
  updated_at: Date;
}

export interface RevealLogRow {
  id: string;
  tenant_id: string;
  user_id: string;
  subject_type: string;
  subject_id: string;
  purpose: string;
  fields: string[];
  created_at: Date;
}

/** Every business table by name (for generic repositories). */
export interface Tables {
  code_sequences: CodeSequenceRow;
  micromarkets: MicromarketRow;
  micromarket_adjacency: MicromarketAdjacencyRow;
  reference_versions: ReferenceVersionRow;
  launch_area_cities: LaunchAreaCityRow;
  vocabulary_releases: VocabularyReleaseRow;
  persons: PersonRow;
  person_phones: PersonPhoneRow;
  person_emails: PersonEmailRow;
  projects: ProjectRow;
  properties: PropertyRow;
  offers: OfferRow;
  price_sheets: PriceSheetRow;
  demands: DemandRow;
  desk_items: DeskItemRow;
  touches: TouchRow;
  enquiries: EnquiryRow;
  record_parties: RecordPartyRow;
  source_ads: SourceAdRow;
  sightings: SightingRow;
  second_sources: SecondSourceRow;
  ingested_records: IngestedRecordRow;
  unrouted_rows: UnroutedRowRow;
  merge_candidates: MergeCandidateRow;
  merges: MergeRow;
  merge_undo_log: MergeUndoLogRow;
  photos: PhotoRow;
  offer_photos: OfferPhotoRow;
  market_data_points: MarketDataRow;
  upload_batches: UploadBatchRow;
  upload_migrations: UploadMigrationRow;
  inbound_versions: InboundVersionRow;
  reveal_log: RevealLogRow;
}
