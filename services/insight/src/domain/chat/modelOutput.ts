// The planner's reply (LLD §4.1 step 3): exactly one JSON object `{kind: plan|action|navigate|refusal|clarify, …}`.
// The model output is untrusted input: anything that doesn't parse into this shape is rejected (→ keyword fallback).
import type { MetricFn, Op, PlanFilter, QueryPlan } from '../plans/types.js';

export type PlannerDecision =
  | { kind: 'plan'; plan: QueryPlan; exportRequested: boolean }
  | { kind: 'action'; cardType: string; slots: Record<string, string | number | boolean> }
  | { kind: 'navigate'; planId: 'open_my_queue' | 'open_record'; code?: string }
  | { kind: 'refusal' }
  | { kind: 'clarify'; question: string };

/** JSON schema sent as `response_format` (union of the five kinds). */
export const PLANNER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['plan', 'action', 'navigate', 'refusal', 'clarify'] },
    planId: { type: 'string' },
    params: {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          items: {
            type: 'object',
            required: ['field', 'op'],
            properties: { field: { type: 'string' }, op: { type: 'string' }, value: {} },
          },
        },
        groupBy: { type: 'array', items: { type: 'string' } },
        metrics: { type: 'array', items: { type: 'object', properties: { fn: { type: 'string' }, field: { type: 'string' } } } },
        sort: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, dir: { type: 'string' } } } },
        period: { type: 'object', properties: { preset: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, field: { type: 'string' } } },
        me: { type: 'boolean' },
        export: { type: 'boolean' },
        listPlanId: { type: 'string' },
        code: { type: 'string' },
      },
    },
    cardType: { type: 'string' },
    slots: { type: 'object' },
    question: { type: 'string' },
  },
} as const;

const OPS: readonly Op[] = ['eq', 'in', 'gte', 'lte', 'between', 'is_null', 'not_null'];
const FNS: readonly MetricFn[] = ['count', 'avg', 'median', 'min', 'max', 'sum'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

/** Parses the model's text (JSON) into a decision, or null when it is not a well-formed reply. */
export function parsePlannerOutput(text: string): PlannerDecision | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  switch (raw['kind']) {
    case 'refusal':
      return { kind: 'refusal' };
    case 'clarify': {
      const q = str(raw['question'], 300);
      return q ? { kind: 'clarify', question: q } : null;
    }
    case 'navigate': {
      const planId = raw['planId'];
      const params = isObj(raw['params']) ? raw['params'] : {};
      if (planId === 'open_my_queue') return { kind: 'navigate', planId };
      const code = str(params['code'], 20);
      if (planId === 'open_record' && code) return { kind: 'navigate', planId, code };
      return null;
    }
    case 'action': {
      const cardType = str(raw['cardType'], 8);
      const slots = isObj(raw['slots']) ? raw['slots'] : {};
      if (!cardType) return null;
      const clean: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(slots)) {
        if (typeof v === 'string' && v.length <= 200) clean[k] = v;
        else if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
      }
      return { kind: 'action', cardType, slots: clean };
    }
    case 'plan': {
      const params = isObj(raw['params']) ? raw['params'] : {};
      let planId = str(raw['planId'], 60);
      if (!planId) return null;
      let exportRequested = params['export'] === true;
      if (planId === 'export_list') {
        planId = str(params['listPlanId'], 60) ?? 'list_offers';
        exportRequested = true;
      }
      const plan: QueryPlan = { planId, templateVersion: 1 };
      if (Array.isArray(params['filters'])) {
        const filters: PlanFilter[] = [];
        for (const f of params['filters'].slice(0, 20)) {
          if (!isObj(f) || typeof f['field'] !== 'string' || !OPS.includes(f['op'] as Op)) return null;
          filters.push({ field: f['field'], op: f['op'] as Op, value: f['value'] ?? null });
        }
        plan.filters = filters;
      }
      if (Array.isArray(params['groupBy'])) plan.groupBy = params['groupBy'].filter((g): g is string => typeof g === 'string').slice(0, 2);
      if (Array.isArray(params['metrics'])) {
        const metrics: NonNullable<QueryPlan['metrics']> = [];
        for (const m of params['metrics'].slice(0, 4)) {
          if (!isObj(m) || !FNS.includes(m['fn'] as MetricFn)) return null;
          metrics.push({ fn: m['fn'] as MetricFn, ...(typeof m['field'] === 'string' ? { field: m['field'] } : {}) });
        }
        plan.metrics = metrics;
      }
      if (Array.isArray(params['sort'])) {
        const sort: NonNullable<QueryPlan['sort']> = [];
        for (const s of params['sort'].slice(0, 2))
          if (isObj(s) && typeof s['field'] === 'string') sort.push({ field: s['field'], dir: s['dir'] === 'asc' ? 'asc' : 'desc' });
        plan.sort = sort;
      }
      if (isObj(params['period'])) {
        const p = params['period'];
        const period: NonNullable<QueryPlan['period']> = {};
        if (typeof p['preset'] === 'string') period.preset = p['preset'] as NonNullable<QueryPlan['period']>['preset'] & string;
        if (typeof p['from'] === 'string') period.from = p['from'];
        if (typeof p['to'] === 'string') period.to = p['to'];
        if (typeof p['field'] === 'string') period.field = p['field'];
        plan.period = period;
      }
      if (params['me'] === true) plan.me = true;
      return { kind: 'plan', plan, exportRequested };
    }
    default:
      return null;
  }
}
