// RunQuery and GetPlanCatalogue (LLD §4.1 steps 4–5, §4.4 "How I got this"): validate a plan against the catalogue
// and the active vocabulary, run it on the read model and shape the contract's QueryResult. No model involved.
import { CATALOGUE, CATALOGUE_VERSION, templateOf } from '../domain/plans/catalogue.js';
import { describePlan } from '../domain/plans/describe.js';
import type { ColumnType, OutputColumn, PlanTemplateDef, QueryPlan } from '../domain/plans/types.js';
import { validatePlan } from '../domain/plans/validator.js';
import type { ValidatedPlan, ValidationResult } from '../domain/plans/validator.js';
import { labelFor } from '../domain/labels/labelGenerator.js';
import type { CatalogueRepo, Clock, ExecResult, QueryExecutor, ReadModelInfo, ReferenceData } from './ports.js';

export interface Caller {
  tenantId: string;
  userId: string;
  role: string;
}

export interface QueryDeps {
  refs: ReferenceData;
  executor: QueryExecutor;
  info: ReadModelInfo;
  catalogue: CatalogueRepo;
  clock: Clock;
}

export const SOURCE = '11 Estates read model (insight)';

export interface HowIGotThis {
  plan: QueryPlan;
  description: string;
  filtersApplied: { field: string; label: string; value: string }[];
  source: typeof SOURCE;
  rowCount: number;
  dataAsOf: string;
  catalogueVersion: string;
  vocabularyVersion: string;
  fallbackUsed: boolean;
  translatedTerms: string[];
}

export interface QueryResult {
  columns: { key: string; label: string; type: ColumnType }[];
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  howIGotThis: HowIGotThis;
}

export async function validateFor(
  deps: QueryDeps,
  caller: Caller,
  plan: QueryPlan,
  options: { limit?: number } = {},
): Promise<{ result: ValidationResult; vocabularyVersion: string }> {
  const [vocabulary, locations, disabled] = await Promise.all([
    deps.refs.vocabulary(caller.tenantId),
    deps.refs.locations(caller.tenantId),
    deps.catalogue.disabled(caller.tenantId),
  ]);
  const template = templateOf(plan.planId, plan.templateVersion) ?? templateOf(plan.planId);
  const result = validatePlan(
    plan,
    template,
    { role: caller.role, userId: caller.userId, now: deps.clock.now(), vocabulary, locations },
    { enabled: !disabled.has(plan.planId), ...(options.limit !== undefined ? { limit: options.limit } : {}) },
  );
  return { result, vocabularyVersion: vocabulary.version };
}

const METRIC_LABEL: Record<string, string> = { avg: 'Average', median: 'Median', min: 'Lowest', max: 'Highest', sum: 'Total' };

function metricColumn(key: string): { key: string; label: string; type: ColumnType } {
  if (key === 'count') return { key: 'count', label: 'Count', type: 'integer' };
  const [fn = '', field = ''] = key.split(':');
  const type: ColumnType = field.endsWith('_inr') ? 'inr' : field === 'n' || fn === 'sum' ? 'integer' : 'number';
  return { key: `${fn}_${field}`, label: `${METRIC_LABEL[fn] ?? fn} ${field === 'n' ? '' : field.replace(/_/g, ' ')}`.trim(), type };
}

export function columnsOf(v: ValidatedPlan): { key: string; label: string; type: ColumnType }[] {
  const t = v.template;
  if (t.kind === 'count') return [{ key: 'count', label: 'Count', type: 'integer' }];
  if (t.kind === 'group' || t.kind === 'stats') {
    if (t.base === 'gap') return t.columns.map(strip);
    return [...v.groupBy.map((g) => ({ key: g.key, label: g.label, type: g.type })), ...v.metrics.map((m) => metricColumn(m.key))];
  }
  return t.columns.map(strip);
}
const strip = (c: OutputColumn) => ({ key: c.key, label: c.label, type: c.type });

/** Projects executor rows onto the output columns and generates labels (never stored). */
export function shapeRows(v: ValidatedPlan, exec: ExecResult): Record<string, unknown>[] {
  const keys = columnsOf(v).map((c) => c.key);
  const side = v.template.base === 'offer' ? 'Supply' : v.template.base === 'demand' ? 'Demand' : null;
  return exec.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k === 'label' && side) out[k] = labelFor(side, row['_deal_type'] as string | null, row['_market'] as string | null, row['_segment'] as string | null);
      else out[k] = row[k] ?? null;
    }
    return out;
  });
}

export function howIGotThis(
  v: ValidatedPlan,
  meta: { rowCount: number; dataAsOf: Date | null; now: Date; vocabularyVersion: string; fallbackUsed: boolean },
): HowIGotThis {
  return {
    plan: v.plan,
    description: describePlan(v),
    filtersApplied: v.filtersApplied,
    source: SOURCE,
    rowCount: meta.rowCount,
    dataAsOf: (meta.dataAsOf ?? meta.now).toISOString(),
    catalogueVersion: CATALOGUE_VERSION,
    vocabularyVersion: meta.vocabularyVersion,
    fallbackUsed: meta.fallbackUsed,
    translatedTerms: v.translatedTerms,
  };
}

export type RunQueryOutcome =
  | { ok: true; result: QueryResult; validated: ValidatedPlan; exec: ExecResult }
  | { ok: false; code: Exclude<ValidationResult, { ok: true }>['code'] | 'not-a-data-plan'; errors: { field: string; code: string; message: string }[] };

/** Executes an already validated plan and builds the QueryResult. */
export async function execute(
  deps: QueryDeps,
  caller: Caller,
  v: ValidatedPlan,
  options: { limit?: number; cursor?: string | null; withTotal?: boolean; vocabularyVersion: string; fallbackUsed?: boolean },
): Promise<{ result: QueryResult; exec: ExecResult }> {
  const now = deps.clock.now();
  const [exec, dataAsOf] = await Promise.all([
    deps.executor.execute(caller.tenantId, v, {
      now,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.withTotal ? { withTotal: true } : {}),
    }),
    deps.info.dataAsOf(caller.tenantId),
  ]);
  const rows = shapeRows(v, exec);
  const rowCount = v.template.kind === 'count' ? Number(exec.total ?? 0) : (exec.total ?? rows.length);
  return {
    exec,
    result: {
      columns: columnsOf(v),
      rows,
      nextCursor: exec.nextCursor,
      howIGotThis: howIGotThis(v, {
        rowCount,
        dataAsOf,
        now,
        vocabularyVersion: options.vocabularyVersion,
        fallbackUsed: options.fallbackUsed ?? false,
      }),
    },
  };
}

/** POST /v1/queries: one page of a validated data plan. */
export async function runQuery(
  deps: QueryDeps,
  caller: Caller,
  plan: QueryPlan,
  options: { limit?: number; cursor?: string | null },
): Promise<RunQueryOutcome> {
  const { result, vocabularyVersion } = await validateFor(deps, caller, plan, options.limit !== undefined ? { limit: options.limit } : {});
  if (!result.ok) return result;
  const v = result.value;
  if (v.template.kind === 'navigate' || v.template.kind === 'export')
    return {
      ok: false,
      code: 'not-a-data-plan',
      errors: [{ field: 'plan.planId', code: 'not-a-data-plan', message: `${v.template.planId} does not return rows` }],
    };
  const { result: qr, exec } = await execute(deps, caller, v, {
    ...options,
    withTotal: v.template.kind === 'list',
    vocabularyVersion,
  });
  return { ok: true, result: qr, validated: v, exec };
}

export interface CatalogueItem {
  planId: string;
  version: number;
  description: string;
  kind: PlanTemplateDef['kind'];
  allowedFilters: { field: string; ops: string[]; vocabulary: string | null }[];
  allowedGroupBy: string[];
  allowedMetrics: string[];
  allowedSort: string[];
  maxRows: number;
  roles: string[];
}

export function catalogueItem(t: PlanTemplateDef): CatalogueItem {
  return {
    planId: t.planId,
    version: t.version,
    description: t.description,
    kind: t.kind,
    allowedFilters: t.filters.map((f) => ({ field: f.field, ops: [...f.ops], vocabulary: f.vocabulary ?? null })),
    allowedGroupBy: t.groupBy.map((g) => g.key),
    allowedMetrics: [...t.metrics],
    allowedSort: [...t.sort],
    maxRows: t.maxRows,
    roles: [...t.roles],
  };
}

/** GET /v1/chat/plan-catalogue: the templates the caller's role may run (tenant-disabled ones hidden). */
export async function planCatalogue(deps: QueryDeps, caller: Caller) {
  const disabled = await deps.catalogue.disabled(caller.tenantId);
  return {
    catalogueVersion: CATALOGUE_VERSION,
    items: CATALOGUE.filter((t) => t.roles.includes(caller.role) && !disabled.has(t.planId)).map(catalogueItem),
  };
}
