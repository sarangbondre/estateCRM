// Plan validation (LLD §4.3): the plan must name an enabled catalogue template the caller's role may run; every
// filter, operator, group, metric and sort must be allowed by it; vocabulary values must be in the active release
// (legacy terms translated first, labels rejected); locality names resolve through the hierarchy; redaction
// placeholders are never filter values; periods resolve in IST; `me` restricts to the caller. Pure.
import { matchKey } from '@11e/vocabulary';
import { addDays, istDay, resolvePeriod } from '../dates.js';
import type { DayRange, PeriodPreset } from '../dates.js';
import { translateTerm } from './termTranslator.js';
import type { FieldSpec, GroupSpec, MetricFn, Op, PlanFilter, PlanTemplateDef, QueryPlan } from './types.js';

export interface VocabularyView {
  version: string;
  /** Field → allowed values (exact spelling) of the active release. */
  values: Readonly<Record<string, readonly string[]>>;
}

export interface LocationEntry {
  name: string;
  level: string;
}

/** Names and aliases (matchKey) → canonical node. Empty when the hierarchy hasn't been fetched yet. */
export type LocationIndex = ReadonlyMap<string, LocationEntry>;

export interface ValidationContext {
  role: string;
  userId: string;
  now: Date;
  vocabulary: VocabularyView;
  locations: LocationIndex;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ResolvedFilter {
  spec: FieldSpec;
  op: Op;
  /** Normalised: scalar, array (in), [a, b] (between) or null. */
  value: unknown;
  fixed?: boolean;
}

export interface ResolvedMetric {
  fn: MetricFn;
  field?: string;
  key: string;
  column: string | null;
}

export interface ValidatedPlan {
  /** The plan with canonical values (what "How I got this" shows). */
  plan: QueryPlan;
  template: PlanTemplateDef;
  filters: ResolvedFilter[];
  period: { column: string; type: 'date' | 'datetime'; range: DayRange; field: string } | null;
  me: string | null;
  groupBy: GroupSpec[];
  metrics: ResolvedMetric[];
  sort: { field: string; column: string; dir: 'asc' | 'desc' }[];
  translatedTerms: string[];
  filtersApplied: { field: string; label: string; value: string }[];
}

export type ValidationResult =
  | { ok: true; value: ValidatedPlan }
  | { ok: false; code: 'plan-not-in-catalogue' | 'plan-invalid' | 'unknown-vocabulary-value' | 'not-allowed-for-role'; errors: FieldError[] };

const PLACEHOLDER = /⟨[A-Z]+_\d+⟩|\[(PHONE|EMAIL|NAME|UNIT|URL|ID)_\d+\]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{2,5}-\d{1,8}$/i;
const PRESETS: readonly PeriodPreset[] = [
  'today',
  'this_week',
  'this_month',
  'this_quarter',
  'last_month',
  'last_30_days',
  'next_60_days',
  'custom',
];

export function displayValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(displayValue).join(', ');
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Validates a plan against a template (already looked up by planId). */
export function validatePlan(
  plan: QueryPlan,
  template: PlanTemplateDef | undefined,
  ctx: ValidationContext,
  options: { limit?: number; enabled?: boolean } = {},
): ValidationResult {
  if (!template || options.enabled === false || plan.templateVersion !== template.version)
    return {
      ok: false,
      code: 'plan-not-in-catalogue',
      errors: [{ field: 'planId', code: 'plan-not-in-catalogue', message: `${plan.planId} v${plan.templateVersion} is not in the catalogue` }],
    };
  if (!template.roles.includes(ctx.role))
    return {
      ok: false,
      code: 'not-allowed-for-role',
      errors: [{ field: 'planId', code: 'not-allowed-for-role', message: `${plan.planId} is not available to ${ctx.role}` }],
    };

  const errors: FieldError[] = [];
  const err = (field: string, code: string, message: string) => errors.push({ field, code, message });
  const translated: string[] = [];
  const specs = new Map(template.filters.map((f) => [f.field, f]));
  const resolved: ResolvedFilter[] = [];
  const canonicalFilters: PlanFilter[] = [];
  const implied: PlanFilter[] = [];

  const scalarValue = (spec: FieldSpec, raw: unknown, path: string): unknown => {
    if (typeof raw === 'string' && PLACEHOLDER.test(raw)) {
      err(path, 'placeholder-not-allowed', 'contact placeholders cannot be filter values (the read model holds no contacts)');
      return undefined;
    }
    if (spec.shape === 'location') {
      if (typeof raw !== 'string' || !raw.trim()) return void err(path, 'invalid-value', 'expected a locality name');
      if (!ctx.locations.size) return raw.trim();
      const hit = ctx.locations.get(matchKey(raw));
      if (!hit) return void err(path, 'unknown-location', `I don't know the locality "${raw.trim()}"`);
      return hit.name;
    }
    if (spec.vocabulary) {
      if (typeof raw !== 'string') return void err(path, 'invalid-value', 'expected a text value');
      const allowed = ctx.vocabulary.values[spec.vocabulary] ?? [];
      const t = translateTerm(spec.vocabulary, raw, allowed);
      if (!t) return void err(path, 'unknown-vocabulary-value', `"${raw}" is not a ${spec.vocabulary} value of release ${ctx.vocabulary.version}`);
      if (t.note) translated.push(t.note);
      for (const [f, v] of Object.entries(t.maps)) {
        if (f === spec.vocabulary) continue;
        const target = template.filters.find((s) => s.vocabulary === f && s.shape !== 'array') ?? template.filters.find((s) => s.vocabulary === f);
        if (target) implied.push({ field: target.field, op: 'eq', value: v });
      }
      return t.maps[spec.vocabulary];
    }
    if (spec.values) {
      if (typeof raw !== 'string') return void err(path, 'invalid-value', 'expected a text value');
      const hit = spec.values.find((v) => matchKey(v) === matchKey(raw));
      if (!hit) return void err(path, 'invalid-value', `"${raw}" is not one of ${spec.values.join(', ')}`);
      return hit;
    }
    switch (spec.type) {
      case 'number':
      case 'inr': {
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return void err(path, 'invalid-value', 'expected a non-negative number');
        if (spec.field === 'bhk' && Math.round(n * 2) !== n * 2) return void err(path, 'invalid-value', 'BHK comes in steps of 0.5');
        return spec.type === 'inr' ? Math.round(n) : n;
      }
      case 'date': {
        if (raw === 'today') return istDay(ctx.now);
        if (typeof raw !== 'string' || !DATE.test(raw)) return void err(path, 'invalid-value', 'expected a date YYYY-MM-DD');
        return raw;
      }
      case 'datetime': {
        if (raw === 'today') return istDay(ctx.now);
        if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) return void err(path, 'invalid-value', 'expected a date or date-time');
        return raw;
      }
      case 'boolean':
        if (typeof raw !== 'boolean') return void err(path, 'invalid-value', 'expected true or false');
        return raw;
      case 'user':
        if (typeof raw !== 'string' || !UUID.test(raw)) return void err(path, 'invalid-value', 'expected a user id');
        return raw.toLowerCase();
      case 'code':
        if (typeof raw !== 'string' || !CODE.test(raw.trim())) return void err(path, 'invalid-value', 'expected a display code like INV-00452');
        return raw.trim().toUpperCase();
      default:
        if (typeof raw !== 'string' || !raw.trim() || raw.length > 80) return void err(path, 'invalid-value', 'expected a short text value');
        return raw.trim();
    }
  };

  const filters = plan.filters ?? [];
  filters.forEach((f, i) => {
    const path = `plan.filters[${i}]`;
    const spec = specs.get(f.field);
    if (!spec) return err(`${path}.field`, 'field-not-allowed', `${f.field} is not a filter of ${template.planId}`);
    if (!spec.ops.includes(f.op)) return err(`${path}.op`, 'op-not-allowed', `${f.op} is not allowed on ${f.field}`);
    let value: unknown;
    if (f.op === 'is_null' || f.op === 'not_null') value = null;
    else if (f.op === 'in') {
      const list = Array.isArray(f.value) ? f.value : [f.value];
      if (!list.length || list.length > 50) return err(`${path}.value`, 'invalid-value', 'in needs 1–50 values');
      value = list.map((v, j) => scalarValue(spec, v, `${path}.value[${j}]`));
    } else if (f.op === 'between') {
      if (!Array.isArray(f.value) || f.value.length !== 2) return err(`${path}.value`, 'invalid-value', 'between needs [from, to]');
      value = f.value.map((v, j) => scalarValue(spec, v, `${path}.value[${j}]`));
    } else {
      if (Array.isArray(f.value)) return err(`${path}.value`, 'invalid-value', `${f.op} needs a single value`);
      value = scalarValue(spec, f.value, `${path}.value`);
    }
    resolved.push({ spec, op: f.op, value });
    canonicalFilters.push({ field: f.field, op: f.op, value: f.op === 'is_null' || f.op === 'not_null' ? null : value });
  });
  // Implied values from translated terms ("resale" → market Secondary) unless the plan set that field itself.
  for (const imp of implied) {
    if (canonicalFilters.some((f) => f.field === imp.field)) continue;
    const spec = specs.get(imp.field);
    if (!spec) continue;
    resolved.push({ spec, op: 'eq', value: imp.value });
    canonicalFilters.push(imp);
  }
  for (const fx of template.fixed ?? []) {
    const spec = specs.get(fx.field) ?? {
      field: fx.field,
      label: fx.field,
      shape: 'scalar' as const,
      type: typeof fx.value === 'boolean' ? ('boolean' as const) : ('text' as const),
      ops: [fx.op],
      column: `b.${fx.field}`,
    };
    resolved.push({ spec, op: fx.op, value: fx.value ?? null, fixed: true });
  }

  // group by / metrics / sort
  const groupBy: GroupSpec[] = [];
  for (const [i, g] of (plan.groupBy ?? template.defaultGroupBy ?? []).entries()) {
    const spec = template.groupBy.find((s) => s.key === g);
    if (!spec) err(`plan.groupBy[${i}]`, 'group-by-not-allowed', `${g} is not a grouping of ${template.planId}`);
    else groupBy.push(spec);
  }
  if (template.kind === 'group' && !groupBy.length && template.base !== 'gap')
    err('plan.groupBy', 'group-by-required', `${template.planId} needs a groupBy`);
  const metrics: ResolvedMetric[] = [];
  const metricList = plan.metrics?.length ? plan.metrics : (template.defaultMetrics ?? (template.kind === 'stats' ? [] : []));
  for (const [i, m] of metricList.entries()) {
    const key = m.fn === 'count' ? 'count' : `${m.fn}:${m.field ?? ''}`;
    if (!template.metrics.includes(key)) {
      err(`plan.metrics[${i}]`, 'metric-not-allowed', `${key} is not a metric of ${template.planId}`);
      continue;
    }
    metrics.push({ fn: m.fn, ...(m.field ? { field: m.field } : {}), key, column: m.field ? (template.metricColumns?.[m.field] ?? null) : null });
  }
  if (template.kind === 'stats' && !metrics.length) {
    const priceField = resolved.some((r) => r.spec.field === 'deal_type' && r.value === 'Lease') ? 'rent_monthly_inr' : 'price_inr';
    for (const fn of ['avg', 'median', 'min', 'max'] as const)
      metrics.push({ fn, field: priceField, key: `${fn}:${priceField}`, column: template.metricColumns?.[priceField] ?? null });
    metrics.push({ fn: 'count', key: 'count', column: null });
  }
  const sort: ValidatedPlan['sort'] = [];
  for (const [i, s] of (plan.sort ?? []).entries()) {
    const column = template.sortColumns?.[s.field];
    if (!template.sort.includes(s.field) || !column) err(`plan.sort[${i}]`, 'sort-not-allowed', `${s.field} is not a sort of ${template.planId}`);
    else sort.push({ field: s.field, column, dir: s.dir });
  }
  if (!sort.length && template.defaultSort) {
    const column = template.sortColumns?.[template.defaultSort.field];
    if (column) sort.push({ ...template.defaultSort, column });
  }
  if (options.limit !== undefined && options.limit > Math.max(template.maxRows, 1))
    err('limit', 'limit-too-large', `at most ${template.maxRows} rows`);

  // period
  let period: ValidatedPlan['period'] = null;
  if (plan.period) {
    const pf = plan.period.field
      ? template.periodFields?.find((p) => p.field === plan.period?.field)
      : template.periodFields?.[0];
    const preset = plan.period.preset ?? (plan.period.from ? 'custom' : undefined);
    if (!pf) err('plan.period.field', 'period-field-not-allowed', `${template.planId} has no period field ${plan.period.field ?? ''}`.trim());
    else if (!preset || !PRESETS.includes(preset)) err('plan.period.preset', 'invalid-value', 'unknown period preset');
    else {
      const range = resolvePeriod(preset, ctx.now, { from: plan.period.from, to: plan.period.to });
      if (!range || !DATE.test(range.from) || !DATE.test(range.to) || range.from > range.to)
        err('plan.period', 'invalid-value', 'custom periods need from ≤ to (YYYY-MM-DD)');
      else period = { column: pf.column, type: pf.type, range, field: pf.field };
    }
  }
  let me: string | null = null;
  if (plan.me || template.forceMe) {
    if (!template.meColumn) err('plan.me', 'me-not-supported', `${template.planId} cannot be restricted to you`);
    else me = ctx.userId;
  }

  if (errors.length) {
    const vocabOnly = errors.every((e) => e.code === 'unknown-vocabulary-value');
    return { ok: false, code: vocabOnly ? 'unknown-vocabulary-value' : 'plan-invalid', errors };
  }

  const canonical: QueryPlan = { planId: plan.planId, templateVersion: plan.templateVersion };
  if (canonicalFilters.length) canonical.filters = canonicalFilters;
  if (plan.groupBy?.length) canonical.groupBy = plan.groupBy;
  if (plan.metrics?.length) canonical.metrics = plan.metrics;
  if (plan.sort?.length) canonical.sort = plan.sort;
  if (plan.period && period) canonical.period = { ...plan.period, field: period.field };
  if (me) canonical.me = true;

  const filtersApplied = resolved.map((r) => ({
    field: r.spec.field,
    label: r.spec.label,
    value: r.op === 'is_null' ? 'none' : r.op === 'not_null' ? 'any' : `${opWord(r.op)}${displayValue(r.value)}`,
  }));
  if (period) filtersApplied.push({ field: period.field, label: 'Period', value: `${period.range.from} to ${period.range.to}` });
  if (me) filtersApplied.push({ field: 'me', label: 'Owner', value: 'you' });

  return {
    ok: true,
    value: { plan: canonical, template, filters: resolved, period, me, groupBy, metrics, sort, translatedTerms: translated, filtersApplied },
  };
}

function opWord(op: Op): string {
  switch (op) {
    case 'gte':
      return '≥ ';
    case 'lte':
      return '≤ ';
    case 'between':
      return 'between ';
    case 'in':
      return 'any of ';
    default:
      return '';
  }
}

/** The IST day after `day` (exclusive upper bound for datetime periods). */
export const dayAfter = (day: string): string => addDays(day, 1);
