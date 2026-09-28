// Database types of the crm_engine schema (migrations 0001–0002). node-postgres returns numeric/bigint as strings and
// date as a local-midnight Date; the repositories map rows to domain values (src/adapters/store.ts).
import type { ColumnType, Generated } from 'kysely';
import type { IdempotencyKeysTable } from '@11e/db';
import type { JobLeasesTable } from '@11e/http';
import type { OutboxDb } from '@11e/outbox';

type Num = ColumnType<string | number | null, number | null | undefined, number | null>;
type NumReq = ColumnType<string | number, number, number>;
type DateCol = ColumnType<Date | string | null, string | null | undefined, string | null>;
type Json = ColumnType<unknown, string, string>;
type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type ReadOnly<T> = ColumnType<T, never, never>;

export interface OfferMxTable {
  id: string;
  tenant_id: string;
  code: string;
  property_id: string;
  project_id: string | null;
  building_key: string | null;
  deal_type: string;
  market: string | null;
  segment: string | null;
  property_types: string[];
  bhk_min: Num;
  bhk_max: Num;
  area_sqft_min: Num;
  area_sqft_max: Num;
  area_basis: string | null;
  land_area_sqft: Num;
  sale_price_inr_min: Num;
  sale_price_inr_max: Num;
  rent_monthly_inr_min: Num;
  rent_monthly_inr_max: Num;
  deposit_inr: Num;
  current_rent_inr: Num;
  price_key: Num;
  micromarket: string | null;
  locality: string | null;
  mm_path: string[];
  zone: string | null;
  outside_launch_area: boolean;
  tenancy_status: string | null;
  sale_mode: string | null;
  possession_status: string | null;
  possession_date_raw: string | null;
  tenure: string | null;
  agreement_form: string | null;
  is_jodi: boolean | null;
  parking: number | null;
  amenities: string[];
  floor_band: string | null;
  total_floors: number | null;
  price_sheet_date: DateCol;
  last_seen_date: DateCol;
  available_from: DateCol;
  available_to: DateCol;
  furnishing: string | null;
  unit_count: number | null;
  record_stage: string | null;
  life_stage: string;
  commercial_status: string;
  voided: boolean;
  merged_into: string | null;
  match_keys: string[];
  is_matchable: ReadOnly<boolean>;
  facts_version: number;
  price_version: number;
  life_version: number;
  commercial_version: number;
  created_at: Generated<Date>;
  updated_at: Ts;
}

export interface DemandMxTable {
  id: string;
  tenant_id: string;
  code: string;
  deal_types: string[];
  market: string | null;
  segment: string | null;
  property_types: string[];
  bhk_min: Num;
  bhk_max: Num;
  area_sqft_min: Num;
  area_sqft_max: Num;
  area_basis: string | null;
  budget_inr_min: Num;
  budget_inr_max: Num;
  rent_monthly_inr_min: Num;
  rent_monthly_inr_max: Num;
  micromarkets: string[];
  localities: string[];
  mm_expanded: string[];
  move_in_from: DateCol;
  move_in_by: DateCol;
  stated_tags: Json;
  outside_launch_area: boolean;
  record_stage: string | null;
  qualified: boolean;
  owner_user_id: string | null;
  life_stage: string;
  commercial_status: string;
  exit_type: string | null;
  voided: boolean;
  merged_into: string | null;
  match_keys: string[];
  is_matchable: ReadOnly<boolean>;
  accepts_new: ReadOnly<boolean>;
  facts_version: number;
  life_version: number;
  status_version: number;
  created_at: Generated<Date>;
  updated_at: Ts;
}

export interface MicromarketNodesTable {
  id: string;
  tenant_id: string;
  node_key: string;
  level: string;
  name: string;
  name_keys: string[];
  parent_key: string | null;
  path: string[];
  adjacent_keys: string[];
  in_launch_area: boolean;
  release_version: number;
  created_at: Generated<Date>;
  updated_at: Ts;
}

export interface ReferenceStateTable {
  tenant_id: string;
  mm_version: number;
  mm_loaded_at: TsNull;
  mm_requested_version: number | null;
  vocabulary_version: string | null;
  updated_at: Ts;
}

export interface VocabularyCacheTable {
  id: string;
  tenant_id: string;
  version: string;
  checksum: string;
  body: Json;
  active: boolean;
  created_at: Generated<Date>;
}

export interface CodeSequencesTable {
  tenant_id: string;
  prefix: string;
  next_value: ColumnType<string | number, number | undefined, number>;
}

export interface MatchesTable {
  id: string;
  tenant_id: string;
  code: string;
  demand_id: string;
  offer_ids: string[];
  offer_set_key: string;
  is_bundle: boolean;
  bundle_id: string | null;
  score: number;
  rank: number | null;
  factors: Json;
  flags: string[];
  status: string;
  closed_reason: string | null;
  closed_by_deal_id: string | null;
  prior_status: string | null;
  rejected_reason: string | null;
  rejected_score: number | null;
  rejected_facts_version: number | null;
  origin: string;
  weights_version: number;
  confirmed_by: string | null;
  confirmed_at: TsNull;
  open_deal_id: string | null;
  proposal_sent_at: TsNull;
  visited_at: TsNull;
  version: number;
  created_at: Ts;
  updated_at: Ts;
}

export interface MatchOffersTable {
  id: string;
  tenant_id: string;
  match_id: string;
  offer_id: string;
  demand_id: string;
  status: string;
  score: number;
}

export interface BundlesTable {
  id: string;
  tenant_id: string;
  code: string;
  demand_id: string;
  offer_ids: string[];
  grouping: string;
  combined_area_sqft: NumReq;
  combined_price_inr: Num;
  combined_rent_monthly_inr: Num;
  origin: string;
  created_by: string | null;
  match_id: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface ExclusionsTable {
  id: string;
  tenant_id: string;
  demand_id: string;
  offer_id: string;
  reason: string;
  available_from: DateCol;
  move_in_by: DateCol;
  computed_at: Ts;
}

export interface FeedbackTable {
  id: string;
  tenant_id: string;
  match_id: string;
  demand_id: string;
  action: string;
  source: string;
  reason_code: string | null;
  score: number;
  factors: Json;
  weights_version: number;
  by_user: string;
  at: Ts;
}

export interface WeightsTable {
  id: string;
  tenant_id: string;
  version: number;
  body: Json;
  active: boolean;
  created_by: string | null;
  created_at: Ts;
}

export interface MatchingRunsTable {
  id: string;
  tenant_id: string;
  scope: string;
  subject_id: string | null;
  trigger: string;
  status: string;
  candidates: number | null;
  suggested: number | null;
  closed: number | null;
  excluded: number | null;
  error: string | null;
  requested_by: string | null;
  created_at: Ts;
  started_at: TsNull;
  finished_at: TsNull;
}

export interface RescorePendingTable {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  reasons: string[];
  run_id: string | null;
  enqueued_at: Ts;
}

export interface DealsTable {
  id: string;
  tenant_id: string;
  demand_id: string;
  offer_id: string;
  status: string;
  units_booked: number | null;
  closed_at: TsNull;
  created_at: Generated<Date>;
  updated_at: Ts;
}

export interface AggregateVersionsTable {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  version: number;
}

export interface JobRunsTable {
  id: string;
  tenant_id: string | null;
  job: string;
  run_date: DateCol;
  cursor: string | null;
  processed: number;
  done: boolean;
  started_at: Ts;
  finished_at: TsNull;
}

export interface MergeLogTable {
  id: string;
  tenant_id: string;
  merge_id: string;
  table_name: string;
  row_id: string;
  before: Json;
  undone_at: TsNull;
  created_at: Generated<Date>;
}

export interface CrmEngineDb extends OutboxDb {
  idempotency_keys: IdempotencyKeysTable;
  job_leases: JobLeasesTable;
  schema_migrations: { version: string; name: string; checksum: string; applied_at: Date };
  code_sequences: CodeSequencesTable;
  offer_mx: OfferMxTable;
  demand_mx: DemandMxTable;
  micromarket_nodes: MicromarketNodesTable;
  reference_state: ReferenceStateTable;
  vocabulary_cache: VocabularyCacheTable;
  matches: MatchesTable;
  match_offers: MatchOffersTable;
  bundles: BundlesTable;
  exclusions: ExclusionsTable;
  feedback: FeedbackTable;
  weights: WeightsTable;
  matching_runs: MatchingRunsTable;
  rescore_pending: RescorePendingTable;
  deals: DealsTable;
  aggregate_versions: AggregateVersionsTable;
  job_runs: JobRunsTable;
  merge_log: MergeLogTable;
}
