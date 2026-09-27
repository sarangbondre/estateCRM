// Database types of the insight schema (migrations 0001–0002) and the Postgres type mapping the rows expect.
import type { ColumnType } from 'kysely';
import pg from 'pg';
import type { IdempotencyKeysTable } from '@11e/db';
import type { JobLeasesTable } from '@11e/http';
import type { OutboxDb } from '@11e/outbox';
import type { RmTables } from '../domain/readmodel/rows.js';

/** Every column is optional on insert (defaults / the store decides what is required). */
type Table<R> = { [K in keyof R]: ColumnType<R[K], R[K] | undefined, R[K]> };
type Stamped<R> = Table<R & { tenant_id: string; created_at: Date; updated_at: Date }>;

type RmDb = { [K in keyof RmTables]: Stamped<RmTables[K]> };

export interface OfferRollupRow {
  dims_hash: string;
  segment: string | null;
  deal_type: string | null;
  market: string | null;
  property_type_primary: string | null;
  micromarket: string | null;
  owner_user_id: string | null;
  source_type: string | null;
  life_stage: string | null;
  commercial_status: string | null;
  record_stage: string | null;
  publication_level: string | null;
  outside_launch_area: boolean | null;
  sale_mode: string | null;
  tenancy_status: string | null;
  n: number;
}

export interface DemandRollupRow {
  dims_hash: string;
  segment: string | null;
  deal_type_primary: string | null;
  market: string | null;
  property_type_primary: string | null;
  micromarket: string | null;
  owner_user_id: string | null;
  source_type: string | null;
  life_stage: string | null;
  commercial_status: string | null;
  record_stage: string | null;
  exit_type: string | null;
  outside_launch_area: boolean | null;
  n: number;
}

export interface DailyFactRow {
  day: string;
  metric: string;
  dims_hash: string;
  segment: string | null;
  deal_type: string | null;
  market: string | null;
  source_type: string | null;
  owner_user_id: string | null;
  micromarket: string | null;
  reason: string | null;
  n: number;
}

export interface ConversationRow {
  id: string;
  code: string;
  user_id: string;
  title: string;
  message_count: number;
  last_message_at: Date;
  deleted_at: Date | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  redacted_text: string;
  redaction_counts: unknown;
  plan: unknown;
  how_i_got_this: unknown;
  cards: unknown;
  outcome: string | null;
  fallback_used: boolean;
  model: string | null;
  timings: unknown;
  idempotency_key: string | null;
}

export interface PlanTemplateRow {
  plan_id: string;
  version: number;
  kind: string;
  description: string;
  allowed_filters: unknown;
  allowed_group_by: string[];
  allowed_metrics: string[];
  allowed_sort: string[];
  base_table: string;
  max_rows: number;
  roles: string[];
  enabled: boolean;
  catalogue_version: string;
}

export interface ExportJobRow {
  id: string;
  code: string;
  requested_by: string;
  requester_role: string;
  plan: unknown;
  include_contacts: boolean;
  file_name: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'expired';
  estimated_rows: number | null;
  row_count: number | null;
  file_path: string | null;
  file_bytes: number | null;
  source_message_id: string | null;
  attempts: number;
  error_code: string | null;
  completed_at: Date | null;
  expires_at: Date | null;
}

export interface InsightDb extends OutboxDb, RmDb {
  idempotency_keys: IdempotencyKeysTable;
  job_leases: JobLeasesTable;
  schema_migrations: { version: string; name: string; checksum: string; applied_at: Date };
  rm_version: Stamped<{ aggregate_id: string; producer: string; version: number }>;
  rm_offer_rollup: Stamped<OfferRollupRow>;
  rm_demand_rollup: Stamped<DemandRollupRow>;
  rm_daily_fact: Stamped<DailyFactRow>;
  rm_state: Stamped<{
    last_event_at: Date | null;
    lag_seconds: number | null;
    events_applied: number;
    property_count: number | null;
    stock_counted_at: Date | null;
  }>;
  rm_queue_counts: Stamped<{ user_id: string; counts: unknown }>;
  rm_user: Stamped<{ user_id: string; role: string; active: boolean }>;
  conversation: Stamped<ConversationRow>;
  message: Stamped<MessageRow>;
  code_sequence: Stamped<{ prefix: string; next_value: number }>;
  plan_template: Stamped<PlanTemplateRow>;
  export_job: Stamped<ExportJobRow>;
  hf_usage: Stamped<{
    day: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    errors: number;
    timeouts: number;
    credits_exhausted_until: Date | null;
  }>;
  vocabulary_release: Stamped<{ version: string; checksum: string | null; content: unknown; active: boolean }>;
  micromarket_ref: Stamped<{
    id: string;
    parent_id: string | null;
    level: string;
    name: string;
    aliases: string[];
    city: string | null;
    in_launch_area: boolean;
    tree_version: number | null;
  }>;
  job_checkpoint: Stamped<{ job: string; cursor: string | null; run_date: string | null }>;
}

let configured = false;
/**
 * `date` stays 'YYYY-MM-DD' (IST business dates); bigint (INR, counts) and numeric (areas, BHK, scores) become numbers
 * (INR values are far below 2^53). Process-wide; called by the composition root and the tests.
 */
export function configurePgTypes(): void {
  if (configured) return;
  configured = true;
  pg.types.setTypeParser(1082, (v: string) => v);
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
}
