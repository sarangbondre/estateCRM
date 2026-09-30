// Row shapes of the journeys schema as the application sees them (LLD §3). Plain data: `date` columns are IsoDate
// strings, timestamps are Date, bigint/numeric are numbers. The adapters map Postgres types to these shapes.
import type { DemandStatus, OfferStatus } from '../domain/commercial.js';
import type { IsoDate } from '../domain/dates.js';
import type { DealStage } from '../domain/deals.js';

interface Common {
  id: string;
  tenant_id: string;
  created_at: Date;
  updated_at: Date;
}
interface Versioned {
  version: number;
}

export interface OfferViewRow extends Common {
  code: string;
  property_id: string;
  project_id: string | null;
  deal_type: string;
  market: string | null;
  segment: string | null;
  property_types: string[];
  micromarket: string | null;
  locality: string | null;
  city: string | null;
  outside_launch_area: boolean;
  possession_status: string | null;
  possession_date_raw: string | null;
  available_from: IsoDate | null;
  sale_price_inr_min: number | null;
  sale_price_inr_max: number | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
  area_sqft_min: number | null;
  area_sqft_max: number | null;
  unit_count: number | null;
  record_stage: string;
  has_real_photos: boolean;
  source_type: string | null;
  sourced_for_demand_id: string | null;
  owner_user_id: string | null;
  publication_level: string;
  price_sheet_date: IsoDate | null;
  contact_person_ids: string[];
  captured_on: IsoDate;
  last_seen_on: IsoDate;
  voided: boolean;
  publication_version: number;
  facts_version: number;
  stage_version: number;
  merged_into: string | null;
}

export interface DemandViewRow extends Common {
  code: string;
  deal_types: string[];
  market: string | null;
  segment: string | null;
  property_types: string[];
  micromarkets: string[];
  localities: string[];
  budget_inr_min: number | null;
  budget_inr_max: number | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
  area_sqft_min: number | null;
  area_sqft_max: number | null;
  move_in_from: IsoDate | null;
  move_in_by: IsoDate | null;
  outside_launch_area: boolean;
  record_stage: string;
  source_type: string | null;
  owner_user_id: string | null;
  touch_count: number;
  contact_person_ids: string[];
  voided: boolean;
  captured_on: IsoDate;
  last_seen_on: IsoDate;
  facts_version: number;
  merged_into: string | null;
}

export type MatchStatus = 'Suggested' | 'Confirmed' | 'Rejected' | 'Closed';
export interface MatchViewRow extends Common {
  code: string;
  demand_id: string;
  offer_ids: string[];
  is_bundle: boolean;
  score: number;
  status: MatchStatus;
  flags: string[];
  closed_reason: string | null;
  source_version: number;
}

export interface MatchOfferRow extends Common {
  match_id: string;
  offer_id: string;
  demand_id: string;
}

export interface PersonStateRow extends Common {
  flags: string[];
  flag_version: number;
  consecutive_no_answer: number;
  unreachable_at: Date | null;
  last_call_at: Date | null;
}

export interface SubjectContactRow extends Common {
  person_id: string;
  subject_type: 'offer' | 'demand';
  subject_id: string;
}

export interface StaffUserRow extends Common {
  role: string;
  active: boolean;
  display_name: string | null;
  source_version: number;
}

export interface LifeCurveRow extends Common, Versioned {
  subject_type: 'offer' | 'demand';
  subject_id: string;
  category_key: string;
  stage: 'Fresh' | 'Ageing' | 'Stale' | 'Expired' | 'Paused';
  day_count: number;
  last_confirmed_at: Date | null;
  last_confirmed_how: string | null;
  clock_floor: IsoDate;
  clock_starts_on: IsoDate | null;
  paused_until: IsoDate | null;
  availability_unknown: boolean;
  next_change_on: IsoDate | null;
  stage_changed_at: Date | null;
  frozen: boolean;
}

export interface OfferJourneyRow extends Common, Versioned {
  commercial_status: OfferStatus;
  commercial_changed_at: Date;
  inactive_reason: string | null;
  enquiry_count: number;
  open_match_count: number;
  confirmed_match_count: number;
}

export interface DemandJourneyRow extends Common, Versioned {
  commercial_status: DemandStatus;
  commercial_changed_at: Date;
  exit_type: 'Lost' | 'Dormant' | 'Invalid' | null;
  exit_reason_code: string | null;
  exit_reason: string | null;
  competing_terms: string | null;
  competing_price_inr: number | null;
  exit_flag_person: boolean;
  exit_person_id: string | null;
  revisit_date: IsoDate | null;
  exited_at: Date | null;
  exited_by: string | null;
  qualified_at: Date | null;
  qualification: Record<string, unknown> | null;
  first_contacted_at: Date | null;
  unreachable: boolean;
}

export interface CapacityRow extends Common, Versioned {
  user_id: string;
  team: 'supply' | 'demand';
  daily_calls: number;
  updated_by: string | null;
}

export interface QueueItemRow extends Common, Versioned {
  team: 'supply' | 'demand';
  section: string;
  subject_type: string;
  subject_id: string;
  subject_code: string | null;
  offer_id: string | null;
  demand_id: string | null;
  assignee_user_id: string | null;
  reason: string;
  reason_ref: string | null;
  priority: number;
  due_at: Date | null;
  rank_score: number | null;
  rank_factors: Record<string, number> | null;
  rank_dirty: boolean;
  attempts: number;
  next_call_date: IsoDate | null;
  status: 'open' | 'done' | 'cancelled';
  closed_at: Date | null;
  closed_reason: string | null;
}

export interface QueueCounterRow extends Common {
  user_id: string;
  section: string;
  open_count: number;
  overdue_count: number;
  changed_at: Date | null;
  emitted_at: Date | null;
}

export interface CallRow extends Common {
  code: string;
  subject_type: 'offer' | 'demand';
  subject_id: string;
  person_id: string | null;
  queue_item_id: string | null;
  channel: 'call' | 'meeting';
  outcome: 'confirmed' | 'no_answer' | 'already_gone' | 'unwilling';
  attempt_no: number;
  known_price_inr: number | null;
  next_call_date: IsoDate | null;
  notes: string | null;
  logged_by: string;
  logged_at: Date;
}

export interface DemandGapRow extends Common {
  segment: string;
  deal_type: string;
  micromarket: string;
  open_demand: number;
  matching_supply: number;
  gap: number;
  budget_p10: number | null;
  budget_p25: number | null;
  budget_p75: number | null;
  budget_p90: number | null;
  computed_at: Date;
}

export interface SourceQualityRow extends Common {
  source_type: string;
  captured_90d: number;
  verified_or_matched_90d: number;
  score: number;
  computed_at: Date;
}

export type SrqStatus = 'Open' | 'In progress' | 'Fulfilled' | 'Cancelled';
export interface SourcingRequestRow extends Common, Versioned {
  code: string;
  demand_id: string;
  requested_by: string;
  assignee_user_id: string;
  due_date: IsoDate;
  priority: 'High' | 'Normal' | 'Low';
  status: SrqStatus;
  post_anonymously: boolean;
  offer_ids: string[];
  notes: string | null;
  closed_at: Date | null;
}

export interface ProposalRow extends Common, Versioned {
  code: string;
  demand_id: string;
  status: 'Preparing' | 'Ready' | 'Sent' | 'Failed';
  cover_note: string | null;
  snapshot: unknown;
  snapshot_at: Date | null;
  snapshot_attempts: number;
  pdf_status: 'none' | 'queued' | 'ready' | 'failed';
  pdf_path: string | null;
  pdf_generated_at: Date | null;
  sent_at: Date | null;
  sent_channel: string | null;
  created_by: string;
}

export interface ProposalOptionRow extends Common {
  proposal_id: string;
  position: number;
  match_id: string;
  offer_ids: string[];
  feedback: string | null;
  feedback_note: string | null;
}

export interface ProposalLinkRow extends Common {
  proposal_id: string;
  token_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  created_by: string;
  open_count: number;
  last_opened_at: Date | null;
  url_hint: string | null;
}

export interface ProposalLinkOpenRow extends Common {
  link_id: string;
  opened_at: Date;
  ip_hash: Buffer | null;
  ua_family: string | null;
}

export interface SiteVisitRow extends Common, Versioned {
  code: string;
  demand_id: string;
  offer_ids: string[];
  scheduled_at: Date;
  attendee_user_ids: string[];
  status: 'Scheduled' | 'Completed' | 'Cancelled';
  outcome: string | null;
  visited_offer_ids: string[];
  preferred_offer_id: string | null;
  notes: string | null;
  completed_at: Date | null;
  created_by: string;
}

export interface DealRow extends Common, Versioned {
  code: string;
  demand_id: string;
  offer_id: string;
  match_id: string | null;
  multi_unit: boolean;
  stage: DealStage;
  agreed_terms: Record<string, unknown>;
  next_action: string | null;
  follow_up_date: IsoDate | null;
  closing_price_inr: number | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason_code: string | null;
  cancel_reason: string | null;
  owner_user_id: string | null;
  created_by: string;
}

export interface DealEventRow extends Common {
  deal_id: string;
  kind: 'stage' | 'follow_up' | 'terms' | 'cancel';
  from_stage: string | null;
  to_stage: string | null;
  note: string | null;
  next_action: string | null;
  follow_up_date: IsoDate | null;
  at: Date;
  by_user: string;
}

export interface LeaseRenewalRow extends Common {
  deal_id: string;
  offer_id: string;
  property_id: string;
  lease_start_date: IsoDate;
  lease_months: number;
  due_on: IsoDate;
  available_from: IsoDate;
  status: 'scheduled' | 'emitted' | 'cancelled';
  emitted_at: Date | null;
}

export interface NotificationRow extends Common {
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  subject_type: string | null;
  subject_id: string | null;
  subject_code: string | null;
  dedupe_key: string | null;
  dedupe_count: number;
  read_at: Date | null;
}

/** CR-012: a crm_notes value imported from an upload row (one per upload row). `note` is PII possible. */
export interface SubjectNoteRow extends Common {
  subject_type: 'offer' | 'demand' | 'person' | 'property';
  subject_id: string;
  source: 'upload';
  upload_id: string;
  upload_code: string | null;
  row_no: number;
  label: string;
  note: string | null;
  imported_at: Date;
}

export interface WatchlistTaskRow extends Common, Versioned {
  watchlist_item_id: string;
  watchlist_code: string | null;
  signal_type: string | null;
  deadline_date: IsoDate | null;
  assignee_user_id: string | null;
  due_date: IsoDate | null;
  status: 'Open' | 'Done' | 'Cancelled';
  outcome: string | null;
  completed_at: Date | null;
  completed_by: string | null;
}

export interface SettingsRow extends Common, Versioned {
  kind: 'life_curve_thresholds' | 'queue_weights';
  body: Record<string, unknown>;
  updated_by: string | null;
}

export interface MergeLogRow extends Common {
  merge_id: string;
  table_name: string;
  row_id: string;
  before: Record<string, unknown>;
  undone_at: Date | null;
}

/** Tenant-scoped entity tables addressable by id through the generic row port. */
export interface Tables {
  offer_view: OfferViewRow;
  demand_view: DemandViewRow;
  match_view: MatchViewRow;
  match_offers: MatchOfferRow;
  person_state: PersonStateRow;
  subject_contacts: SubjectContactRow;
  staff_users: StaffUserRow;
  life_curve: LifeCurveRow;
  offer_journey: OfferJourneyRow;
  demand_journey: DemandJourneyRow;
  capacities: CapacityRow;
  queue_items: QueueItemRow;
  queue_counters: QueueCounterRow;
  calls: CallRow;
  demand_gap: DemandGapRow;
  source_quality: SourceQualityRow;
  sourcing_requests: SourcingRequestRow;
  proposals: ProposalRow;
  proposal_options: ProposalOptionRow;
  proposal_links: ProposalLinkRow;
  proposal_link_opens: ProposalLinkOpenRow;
  site_visits: SiteVisitRow;
  deals: DealRow;
  deal_events: DealEventRow;
  lease_renewals: LeaseRenewalRow;
  notifications: NotificationRow;
  watchlist_tasks: WatchlistTaskRow;
  subject_notes: SubjectNoteRow;
  settings: SettingsRow;
  merge_log: MergeLogRow;
}
export type TableName = keyof Tables;

/** Columns the database fills in when omitted on insert. */
export type Defaulted = 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'version';
export type NewRow<T extends TableName> = Omit<Tables[T], Defaulted | DefaultedOf<T>> &
  Partial<Pick<Tables[T], Extract<Defaulted | DefaultedOf<T>, keyof Tables[T]>>>;

/** Per-table columns with database defaults (optional on insert). */
type DefaultedOf<T extends TableName> = T extends 'offer_view'
  ? 'property_types' | 'outside_launch_area' | 'record_stage' | 'has_real_photos' | 'publication_level' | 'contact_person_ids' | 'voided' | 'publication_version' | 'facts_version' | 'stage_version' | 'merged_into'
  : T extends 'demand_view'
    ? 'property_types' | 'micromarkets' | 'localities' | 'outside_launch_area' | 'record_stage' | 'touch_count' | 'contact_person_ids' | 'voided' | 'facts_version' | 'merged_into'
    : T extends 'match_view'
      ? 'is_bundle' | 'flags' | 'closed_reason'
      : T extends 'person_state'
        ? 'flags' | 'flag_version' | 'consecutive_no_answer' | 'unreachable_at' | 'last_call_at'
        : T extends 'life_curve'
          ? 'day_count' | 'availability_unknown' | 'frozen' | 'paused_until' | 'stage_changed_at' | 'last_confirmed_at' | 'last_confirmed_how' | 'clock_starts_on' | 'next_change_on'
          : T extends 'offer_journey'
            ? 'inactive_reason' | 'enquiry_count' | 'open_match_count' | 'confirmed_match_count'
            : T extends 'demand_journey'
              ? 'exit_type' | 'exit_reason_code' | 'exit_reason' | 'competing_terms' | 'competing_price_inr' | 'exit_flag_person' | 'exit_person_id' | 'revisit_date' | 'exited_at' | 'exited_by' | 'qualified_at' | 'qualification' | 'first_contacted_at' | 'unreachable'
              : T extends 'queue_items'
                ? 'subject_code' | 'offer_id' | 'demand_id' | 'reason_ref' | 'priority' | 'due_at' | 'rank_score' | 'rank_factors' | 'rank_dirty' | 'attempts' | 'next_call_date' | 'status' | 'closed_at' | 'closed_reason'
                : T extends 'queue_counters'
                  ? 'open_count' | 'overdue_count' | 'changed_at' | 'emitted_at'
                  : T extends 'sourcing_requests'
                    ? 'post_anonymously' | 'offer_ids' | 'notes' | 'closed_at'
                    : T extends 'proposals'
                      ? 'cover_note' | 'snapshot' | 'snapshot_at' | 'snapshot_attempts' | 'pdf_status' | 'pdf_path' | 'pdf_generated_at' | 'sent_at' | 'sent_channel'
                      : T extends 'proposal_options'
                        ? 'feedback' | 'feedback_note'
                        : T extends 'proposal_links'
                          ? 'revoked_at' | 'open_count' | 'last_opened_at' | 'url_hint'
                          : T extends 'site_visits'
                            ? 'attendee_user_ids' | 'outcome' | 'visited_offer_ids' | 'preferred_offer_id' | 'notes' | 'completed_at'
                            : T extends 'deals'
                              ? 'match_id' | 'multi_unit' | 'agreed_terms' | 'next_action' | 'follow_up_date' | 'closing_price_inr' | 'closed_at' | 'cancelled_at' | 'cancel_reason_code' | 'cancel_reason' | 'owner_user_id'
                              : T extends 'deal_events'
                                ? 'from_stage' | 'to_stage' | 'note' | 'next_action' | 'follow_up_date'
                                : T extends 'lease_renewals'
                                  ? 'emitted_at'
                                  : T extends 'notifications'
                                    ? 'body' | 'subject_type' | 'subject_id' | 'subject_code' | 'dedupe_key' | 'dedupe_count' | 'read_at'
                                    : T extends 'watchlist_tasks'
                                      ? 'watchlist_code' | 'signal_type' | 'deadline_date' | 'assignee_user_id' | 'due_date' | 'outcome' | 'completed_at' | 'completed_by'
                                      : T extends 'capacities'
                                        ? 'daily_calls' | 'updated_by'
                                        : T extends 'settings'
                                          ? 'updated_by'
                                          : T extends 'merge_log'
                                            ? 'undone_at'
                                            : T extends 'calls'
                                              ? 'person_id' | 'queue_item_id' | 'known_price_inr' | 'next_call_date' | 'notes'
                                              : T extends 'staff_users'
                                                ? 'display_name'
                                                : T extends 'demand_gap'
                                                  ? 'budget_p10' | 'budget_p25' | 'budget_p75' | 'budget_p90'
                                                  : T extends 'proposal_link_opens'
                                                    ? 'ip_hash' | 'ua_family'
                                                    : T extends 'subject_notes'
                                                      ? 'source' | 'upload_code' | 'note'
                                                      : never;
