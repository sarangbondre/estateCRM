// Query-plan types (contract `QueryPlan`, `PlanTemplate`; LLD §3.3 catalogue, §4.3 validation). Pure data.
import type { PeriodPreset } from '../dates.js';

export type Op = 'eq' | 'in' | 'gte' | 'lte' | 'between' | 'is_null' | 'not_null';
export const OPS: readonly Op[] = ['eq', 'in', 'gte', 'lte', 'between', 'is_null', 'not_null'];

export type MetricFn = 'count' | 'avg' | 'median' | 'min' | 'max' | 'sum';

export interface PlanFilter {
  field: string;
  op: Op;
  value?: unknown;
}

export interface QueryPlan {
  planId: string;
  templateVersion: number;
  filters?: PlanFilter[];
  groupBy?: string[];
  metrics?: { fn: MetricFn; field?: string }[];
  sort?: { field: string; dir: 'asc' | 'desc' }[];
  period?: { preset?: PeriodPreset; from?: string; to?: string; field?: string };
  me?: boolean;
}

/**
 * How a filter field compiles (adapter SQL compiler):
 * - `scalar`: one column (text, enum, vocabulary, number, INR, date, datetime, boolean, user id, code);
 * - `array`: the row holds a list (property_types, deal_types) — eq = contains, in = overlaps;
 * - `range`: the row holds min/max columns — eq = inside, gte/lte = reaches, between = overlaps;
 * - `location`: micromarket or locality (arrays for demands), names resolved through the hierarchy;
 * - `days_since`: a timestamp compared with now − N days (gte N = at least N days ago).
 */
export type FieldShape = 'scalar' | 'array' | 'range' | 'location' | 'days_since';

/** Value type, for validation and output formatting. */
export type ValueType = 'text' | 'number' | 'inr' | 'date' | 'datetime' | 'boolean' | 'user' | 'code';

export interface FieldSpec {
  field: string;
  label: string;
  shape: FieldShape;
  type: ValueType;
  ops: readonly Op[];
  /** Controlled vocabulary field (x-vocabulary) whose active-release values are the only values accepted. */
  vocabulary?: string;
  /** Fixed value list for controlled non-vocabulary fields (status axes). */
  values?: readonly string[];
  /** scalar / array / days_since: the column; location: the micromarket column. */
  column?: string;
  /** range: min and max columns. */
  min?: string;
  max?: string;
  /** location: the locality column. */
  localityColumn?: string;
  /** location: columns are arrays (demands). */
  arrays?: boolean;
}

export type ColumnType =
  | 'string'
  | 'number'
  | 'integer'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'code'
  | 'label'
  | 'user'
  | 'inr';

export interface OutputColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** SQL column (qualified by the base alias); absent for generated columns (labels). */
  column?: string;
}

export interface GroupSpec {
  key: string;
  label: string;
  column: string;
  type: ColumnType;
}

export type Base = 'offer' | 'demand' | 'match' | 'deal' | 'market_price' | 'daily_fact' | 'upload' | 'gap' | 'none';
export type TemplateKind = 'list' | 'count' | 'group' | 'stats' | 'navigate' | 'export';

export interface PlanTemplateDef {
  planId: string;
  version: number;
  kind: TemplateKind;
  description: string;
  base: Base;
  /** Table name(s) for the catalogue row (base_table). */
  baseTable: string;
  filters: readonly FieldSpec[];
  groupBy: readonly GroupSpec[];
  /** Allowed metrics as 'count' or '<fn>:<field>'. */
  metrics: readonly string[];
  /** Metric fields → SQL column. */
  metricColumns?: Readonly<Record<string, string>>;
  sort: readonly string[];
  /** Sort field → SQL column. */
  sortColumns?: Readonly<Record<string, string>>;
  defaultSort?: { field: string; dir: 'asc' | 'desc' };
  defaultGroupBy?: readonly string[];
  defaultMetrics?: readonly { fn: MetricFn; field?: string }[];
  /** Date/datetime fields a period may apply to; the first is the default. */
  periodFields?: readonly { field: string; column: string; type: 'date' | 'datetime' }[];
  /** Column restricted to the caller when `me` is true. */
  meColumn?: string;
  /** Filters always applied (not visible to the model), e.g. is_bundle = true. */
  fixed?: readonly PlanFilter[];
  /** `me` is forced on (list_my_followups). */
  forceMe?: boolean;
  columns: readonly OutputColumn[];
  maxRows: number;
  roles: readonly string[];
  /** navigate / export: what it opens or wraps. */
  navigate?: { panel: string; targetService: string; targetOperation: string };
}
