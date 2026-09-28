// Plan → plain-English "How I got this" description (LLD §4.4). Generated from the validated plan only. Pure.
import { displayValue } from './validator.js';
import type { ValidatedPlan } from './validator.js';

const SUBJECT: Record<string, string> = {
  offer: 'Offers',
  demand: 'Demands',
  match: 'Matches',
  deal: 'Deals',
  market_price: 'Closed and known prices',
  daily_fact: 'Daily activity',
  upload: 'Uploads',
  gap: 'Open demand vs matching supply',
  none: 'Records',
};

const OP_TEXT: Record<string, string> = {
  eq: '=',
  in: 'in',
  gte: '≥',
  lte: '≤',
  between: 'between',
  is_null: 'is empty',
  not_null: 'is set',
};

export function describePlan(v: ValidatedPlan): string {
  const parts = v.filters.map((f) => {
    const name = f.spec.label.toLowerCase();
    if (f.op === 'is_null' || f.op === 'not_null') return `${name} ${OP_TEXT[f.op]}`;
    if (f.op === 'between' && Array.isArray(f.value)) return `${name} between ${displayValue(f.value[0])} and ${displayValue(f.value[1])}`;
    return `${name} ${OP_TEXT[f.op]} ${displayValue(f.value)}`;
  });
  if (v.period) parts.push(`${v.period.field.replace(/_/g, ' ')} from ${v.period.range.from} to ${v.period.range.to} (IST)`);
  if (v.me) parts.push('owned by you');
  let text = SUBJECT[v.template.base] ?? 'Records';
  if (parts.length) text += ` where ${parts.join(', ')}`;
  switch (v.template.kind) {
    case 'count':
      text += ', counted';
      break;
    case 'list':
      if (v.sort[0]) text += `, sorted by ${v.sort[0].field.replace(/_/g, ' ')} ${v.sort[0].dir === 'asc' ? 'ascending' : 'descending'}`;
      break;
    case 'group':
      if (v.groupBy.length) text += `, grouped by ${v.groupBy.map((g) => g.label.toLowerCase()).join(' and ')}`;
      if (v.metrics.length) text += ` (${v.metrics.map((m) => m.key.replace(':', ' of ')).join(', ')})`;
      break;
    case 'stats':
      text += `, ${v.metrics.map((m) => m.key.replace(':', ' of ')).join(', ')}`;
      break;
    default:
      break;
  }
  if (v.template.base === 'gap') text += '; only micromarkets where open demand exceeds supply';
  return text;
}
