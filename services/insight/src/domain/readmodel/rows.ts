// Row shapes of the PII-free read model (LLD §3.1–3.2). Keys are the column names, so the projectors, the SQL compiler
// and the repositories share one vocabulary. Dates are ISO strings (date columns 'YYYY-MM-DD'), numbers are numbers.

export type Iso = string;

export interface OfferRow {
  id: string;
  code: string | null;
  property_id: string | null;
  project_id: string | null;
  deal_type: string | null;
  market: string | null;
  segment: string | null;
  property_types: string[];
  property_type_primary: string | null;
  bhk_min: number | null;
  bhk_max: number | null;
  area_sqft_min: number | null;
  area_sqft_max: number | null;
  area_basis: string | null;
  land_area_sqft: number | null;
  sale_price_inr_min: number | null;
  sale_price_inr_max: number | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
  deposit_inr: number | null;
  current_rent_inr: number | null;
  locality: string | null;
  micromarket: string | null;
  city: string | null;
  outside_launch_area: boolean;
  tenancy_status: string | null;
  sale_mode: string | null;
  possession_status: string | null;
  possession_date: string | null;
  possession_sort: string | null;
  furnishing: string | null;
  unit_count: number | null;
  source_type: string | null;
  owner_user_id: string | null;
  sourced_for_demand_id: string | null;
  contact_person_ids: string[];
  photo_count: number;
  has_real_photos: boolean;
  record_stage: string | null;
  verified_at: Iso | null;
  verified_by: string | null;
  void_reason: string | null;
  commercial_status: string | null;
  closed_at: Iso | null;
  closing_price_inr: number | null;
  retired_reason: string | null;
  life_stage: string | null;
  life_stage_since: Iso | null;
  life_day: number | null;
  last_confirmed_at: Iso | null;
  confirmed_how: string | null;
  publication_level: string | null;
  public_id: string | null;
  enquiry_count: number;
  match_suggested_count: number;
  match_confirmed_count: number;
  merged_into_id: string | null;
  created_at_src: Iso | null;
}

export interface DemandRow {
  id: string;
  code: string | null;
  deal_types: string[];
  deal_type_primary: string | null;
  market: string | null;
  segment: string | null;
  property_types: string[];
  property_type_primary: string | null;
  bhk_min: number | null;
  bhk_max: number | null;
  area_sqft_min: number | null;
  area_sqft_max: number | null;
  area_basis: string | null;
  budget_inr_min: number | null;
  budget_inr_max: number | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
  micromarkets: string[];
  localities: string[];
  move_in_by: string | null;
  stated_tags: Record<string, string>;
  outside_launch_area: boolean;
  record_stage: string | null;
  source_type: string | null;
  owner_user_id: string | null;
  contact_person_ids: string[];
  commercial_status: string | null;
  sourcing_since: Iso | null;
  exit_type: string | null;
  exit_reason: string | null;
  revisit_date: string | null;
  qualified_at: Iso | null;
  life_stage: string | null;
  life_stage_since: Iso | null;
  life_day: number | null;
  last_confirmed_at: Iso | null;
  publication_level: string | null;
  touch_count: number;
  match_suggested_count: number;
  match_confirmed_count: number;
  last_matching_at: Iso | null;
  last_match_count: number | null;
  void_reason: string | null;
  merged_into_id: string | null;
  created_at_src: Iso | null;
}

export interface MatchRow {
  id: string;
  code: string | null;
  demand_id: string | null;
  offer_ids: string[];
  is_bundle: boolean;
  score: number | null;
  flags: string[];
  status: string | null;
  close_reason: string | null;
  reject_reason: string | null;
  suggested_at: Iso | null;
  confirmed_at: Iso | null;
  closed_at: Iso | null;
}

export interface DealRow {
  id: string;
  code: string | null;
  demand_id: string | null;
  offer_id: string | null;
  status: string;
  stage: string | null;
  follow_up_date: string | null;
  overdue: boolean;
  owner_user_id: string | null;
  opened_at: Iso | null;
  closed_at: Iso | null;
  closing_price_inr: number | null;
  deal_type: string | null;
  lease_months: number | null;
  units_booked: number | null;
  cancel_reason: string | null;
  segment: string | null;
  property_type_primary: string | null;
  micromarket: string | null;
  locality: string | null;
  area_sqft: number | null;
}

export interface MarketPriceRow {
  id: string;
  source: string;
  offer_id: string | null;
  deal_type: string | null;
  segment: string | null;
  property_type_primary: string | null;
  micromarket: string | null;
  locality: string | null;
  area_sqft: number | null;
  price_inr: number | null;
  rent_monthly_inr: number | null;
  occurred_at: Iso;
  void: boolean;
}

export interface SourcingRequestRow {
  id: string;
  code: string | null;
  demand_id: string | null;
  assignee_user_id: string | null;
  due_date: string | null;
  priority: string | null;
  status: string;
}

export interface ProposalRow {
  id: string;
  demand_id: string | null;
  match_ids: string[];
  sent_at: Iso | null;
  feedback: Record<string, string>;
}

export interface SiteVisitRow {
  id: string;
  demand_id: string | null;
  offer_ids: string[];
  scheduled_for: Iso | null;
  preferred_offer_id: string | null;
  completed_at: Iso | null;
}

export interface CallRow {
  id: string;
  subject_type: string;
  subject_id: string;
  outcome: string;
  attempt: number | null;
  person_unreachable: boolean;
  called_by: string | null;
  occurred_at: Iso;
}

export interface TouchRow {
  id: string;
  demand_id: string;
  source_type: string | null;
  capture_mode: string | null;
  is_first_touch: boolean;
  occurred_at: Iso;
}

export interface EnquiryRow {
  id: string;
  code: string | null;
  offer_id: string | null;
  project_id: string | null;
  demand_id: string | null;
  campaign_ref: string | null;
  received_at: Iso;
}

export interface ProjectRow {
  id: string;
  code: string | null;
  name: string | null;
  rera_number: string | null;
  locality: string | null;
  micromarket: string | null;
  city: string | null;
  possession_date: string | null;
  offer_ids: string[];
  latest_sheet_date: string | null;
}

export interface UploadRow {
  id: string;
  code: string | null;
  mode: string | null;
  source_type: string | null;
  source_detail: string | null;
  row_count: number | null;
  accepted: number | null;
  rejected: number | null;
  needs_review: number | null;
  unchanged: number | null;
  rejection_reasons: Record<string, number>;
  status: string;
  anonymised: boolean;
  uploaded_by: string | null;
  started_at: Iso | null;
  finished_at: Iso | null;
  fail_reason: string | null;
}

export interface ReviewItemRow {
  id: string;
  upload_id: string | null;
  reason_code: string | null;
  detail_code: string | null;
  status: string;
  action: string | null;
  resolved_by: string | null;
  resolved_at: Iso | null;
}

export interface MergeCandidateRow {
  id: string;
  kind: string;
  aggregate_type: string | null;
  raised_at: Iso;
}

export interface RowStatRow {
  id: string;
  upload_id: string;
  record_scope: string | null;
  side: string | null;
  review_reason_code: string | null;
  needs_review: boolean;
  source_name: string | null;
  possible_repeat: boolean;
  count: number;
}

export interface DeskItemRow {
  id: string;
  code: string | null;
  record_scope: string | null;
  deal_types: string[];
  side: string | null;
  sector: string | null;
  participant_role: string | null;
  linked_property_id: string | null;
  status: string;
  assignee_user_id: string | null;
}

export interface WatchlistItemRow {
  id: string;
  code: string | null;
  signal_type: string | null;
  deadline_date: string | null;
  task_open: boolean;
}

export interface PersonFlagRow {
  id: string;
  person_id: string;
  flag: string;
  active: boolean;
  occurred_at: Iso;
}

/** Tables keyed by (tenant_id, id) that the projectors write through the generic store. */
export interface RmTables {
  rm_offer: OfferRow;
  rm_demand: DemandRow;
  rm_match: MatchRow;
  rm_deal: DealRow;
  rm_market_price: MarketPriceRow;
  rm_sourcing_request: SourcingRequestRow;
  rm_proposal: ProposalRow;
  rm_site_visit: SiteVisitRow;
  rm_call: CallRow;
  rm_touch: TouchRow;
  rm_enquiry: EnquiryRow;
  rm_project: ProjectRow;
  rm_upload: UploadRow;
  rm_review_item: ReviewItemRow;
  rm_merge_candidate: MergeCandidateRow;
  rm_row_stat: RowStatRow;
  rm_desk_item: DeskItemRow;
  rm_watchlist_item: WatchlistItemRow;
  rm_person_flag: PersonFlagRow;
}
export type RmTable = keyof RmTables;
