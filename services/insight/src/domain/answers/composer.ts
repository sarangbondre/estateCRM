// Grounded answers (LLD §4.4): deterministic templates filled only from the validated plan and the query results —
// no model-written text. Labels come from the BRD §4.2 generator; numbers use the Indian format. Pure.
import { labelFor } from '../labels/labelGenerator.js';
import type { ValidatedPlan } from '../plans/validator.js';
import { displayValue } from '../plans/validator.js';
import { formatCount, formatInr, groupIndian } from './indianFormat.js';

export interface Figure {
  label: string;
  value: number;
  unit: 'count' | 'inr' | 'inr_per_month' | 'sqft' | 'days' | 'pct';
}

export interface Composed {
  text: string;
  figures: Figure[];
  /** Show the rows as a TableCard. */
  table: boolean;
  empty: boolean;
  suggestions: string[];
}

const PERIOD_WORDS: Record<string, string> = {
  today: 'today',
  this_week: 'this week',
  this_month: 'this month',
  this_quarter: 'this quarter',
  last_month: 'last month',
  last_30_days: 'in the last 30 days',
  next_60_days: 'in the next 60 days',
};

const NOUN: Record<string, [string, string]> = {
  offer: ['offer', 'offers'],
  demand: ['demand', 'demands'],
  match: ['match', 'matches'],
  deal: ['deal', 'deals'],
  market_price: ['close', 'closes'],
  daily_fact: ['activity', 'activities'],
  upload: ['upload', 'uploads'],
  gap: ['micromarket', 'micromarkets'],
  none: ['record', 'records'],
};

function valueOf(v: ValidatedPlan, field: string): unknown {
  return v.filters.find((f) => f.spec.field === field && (f.op === 'eq' || f.op === 'in'))?.value;
}

/** Natural description of what was asked, e.g. "For Rent 2 BHK Apartment offers in Andheri West that are active". */
export function phrase(v: ValidatedPlan, count = 2): string {
  const base = v.template.base;
  const [one, many] = NOUN[base] ?? ['record', 'records'];
  const noun = count === 1 ? one : many;
  const words: string[] = [];
  const dealType = valueOf(v, 'deal_type') ?? valueOf(v, 'demand_deal_type');
  const market = valueOf(v, 'market');
  const segment = valueOf(v, 'segment') ?? valueOf(v, 'demand_segment');
  const propertyType = valueOf(v, 'property_type') ?? valueOf(v, 'demand_property_type');
  if (typeof dealType === 'string' && (base === 'offer' || base === 'demand')) {
    // A BHK question is residential, so a Lease reads "For Rent" (BRD §4.2 label table).
    const labelSegment = (segment as string | undefined) ?? (v.filters.some((f) => f.spec.field === 'bhk') ? 'Residential' : null);
    const label = labelFor(base === 'offer' ? 'Supply' : 'Demand', dealType, market as string | null, labelSegment);
    words.push(label ?? dealType);
  } else if (typeof dealType === 'string' && base !== 'market_price') words.push(dealType);
  const bhk = v.filters.find((f) => f.spec.field === 'bhk');
  if (bhk && bhk.op === 'eq') words.push(`${displayValue(bhk.value)} BHK`);
  if (propertyType) words.push(displayValue(propertyType));
  else if (segment) words.push(displayValue(segment));
  words.push(noun);
  const location = valueOf(v, 'location');
  if (location) words.push(`in ${displayValue(location)}`);
  const clauses: string[] = [];
  for (const f of v.filters) {
    if (f.fixed) continue;
    const field = f.spec.field;
    if (['deal_type', 'market', 'segment', 'property_type', 'bhk', 'location', 'demand_deal_type', 'demand_segment', 'demand_property_type'].includes(field)) continue;
    const val = displayValue(f.value);
    switch (field) {
      case 'commercial_status':
      case 'life_stage':
      case 'status':
        clauses.push(f.op === 'in' && Array.isArray(f.value) && f.value.length > 3 ? 'that are active' : `that are ${val}`);
        break;
      case 'publication_level':
        clauses.push(`listed ${val}`);
        break;
      case 'days_in_sourcing':
        clauses.push(`${f.op === 'gte' ? 'for at least' : 'for at most'} ${val} days`);
        break;
      default: {
        const amount = f.spec.type === 'inr' ? formatInr(Number(f.value)) : val;
        const op = f.op === 'lte' ? 'up to ' : f.op === 'gte' ? 'at least ' : f.op === 'between' ? 'between ' : '';
        clauses.push(`with ${f.spec.label.toLowerCase()} ${op}${amount}`);
      }
    }
  }
  if (v.period) clauses.push(PERIOD_WORDS[v.plan.period?.preset ?? ''] ?? `from ${v.period.range.from} to ${v.period.range.to}`);
  if (v.me) clauses.push('of yours');
  return [...words, ...clauses].join(' ');
}

const num = (x: unknown) => (typeof x === 'number' ? x : Number(x ?? 0));

export function compose(v: ValidatedPlan, rows: Record<string, unknown>[], total: number | null, capped: boolean, exportRequested = false): Composed {
  const kind = v.template.kind;
  const suggestions = v.filters
    .filter((f) => !f.fixed)
    .slice(0, 3)
    .map((f) => `Try without ${f.spec.label.toLowerCase()} (${displayValue(f.value)})`);
  if (kind === 'count') {
    const n = num(rows[0]?.['count']);
    if (!n) return { text: `No ${phrase(v)} found.`, figures: [{ label: 'Count', value: 0, unit: 'count' }], table: false, empty: true, suggestions };
    return {
      text: `There ${n === 1 ? 'is' : 'are'} ${formatCount(n, capped)} ${phrase(v, n)}.`,
      figures: [{ label: 'Count', value: n, unit: 'count' }],
      table: false,
      empty: false,
      suggestions: [],
    };
  }
  if (!rows.length) return { text: `No ${phrase(v)} found.`, figures: [], table: false, empty: true, suggestions };
  if (kind === 'list') {
    const n = total ?? rows.length;
    const lead = n > rows.length ? `Here are ${rows.length} of ${formatCount(n, capped)} ${phrase(v, n)}.` : `Here ${n === 1 ? 'is the' : 'are the'} ${formatCount(n)} ${phrase(v, n)}.`;
    const tail = exportRequested ? ` Use Excel to download all ${formatCount(n, capped)} rows.` : '';
    return { text: lead + tail, figures: [{ label: 'Rows', value: n, unit: 'count' }], table: true, empty: false, suggestions: [] };
  }
  if (v.template.base === 'gap') {
    const top = rows.slice(0, 3).map((r) => `${displayValue(r['micromarket'] ?? 'no micromarket')} (${num(r['open_demand'])} vs ${num(r['supply'])})`);
    return {
      text: `Open demand exceeds matching supply in ${rows.length} micromarket${rows.length === 1 ? '' : 's'} for ${phrase(v).replace(/ micromarkets$/, '') || 'this classification'}: ${top.join(', ')}.`,
      figures: rows.slice(0, 3).map((r) => ({ label: displayValue(r['micromarket']), value: num(r['gap']), unit: 'count' as const })),
      table: true,
      empty: false,
      suggestions: [],
    };
  }
  if (kind === 'stats') {
    const r = rows[0] ?? {};
    const field = v.metrics.find((m) => m.field)?.field ?? 'price_inr';
    const perMonth = field === 'rent_monthly_inr';
    const count = num(r['count']);
    if (!count) return { text: `No ${phrase(v)} found.`, figures: [], table: false, empty: true, suggestions };
    const f = (k: string) => num(r[`${k}_${field}`]);
    const unit = perMonth ? '/month' : '';
    const what = perMonth ? 'closed rent' : 'closed price';
    return {
      text: `Average ${what} for ${phrase(v, 2).replace(/ closes/, '')}: ${formatInr(f('avg'))}${unit} across ${groupIndian(count)} close${count === 1 ? '' : 's'} (median ${formatInr(f('median'))}; range ${formatInr(f('min'))}–${formatInr(f('max'))}).`,
      figures: [
        { label: 'Average', value: f('avg'), unit: perMonth ? 'inr_per_month' : 'inr' },
        { label: 'Median', value: f('median'), unit: perMonth ? 'inr_per_month' : 'inr' },
        { label: 'Lowest', value: f('min'), unit: perMonth ? 'inr_per_month' : 'inr' },
        { label: 'Highest', value: f('max'), unit: perMonth ? 'inr_per_month' : 'inr' },
        { label: 'Closes', value: count, unit: 'count' },
      ],
      table: false,
      empty: false,
      suggestions: [],
    };
  }
  // group
  const g = v.groupBy[0];
  const m = v.metrics[0];
  const mKey = m ? m.key.replace(':', '_') : 'count';
  if (g?.type === 'user') {
    const totalN = rows.reduce((s, r) => s + num(r[mKey]), 0);
    return {
      text: `${groupIndian(totalN)} in total across ${rows.length} ${g.label.toLowerCase()}${rows.length === 1 ? '' : 's'} (${phrase(v)}); the table shows each one.`,
      figures: [{ label: 'Total', value: totalN, unit: 'count' }],
      table: true,
      empty: false,
      suggestions: [],
    };
  }
  const top = rows.slice(0, 3).map((r) => `${displayValue(g ? (r[g.key] ?? 'not set') : '')} (${groupIndian(num(r[mKey]))})`);
  return {
    text: `${g?.label ?? 'Group'} with the most ${phrase(v)}: ${top.join(', ')}.`,
    figures: rows.slice(0, 3).map((r) => ({ label: displayValue(g ? r[g.key] : ''), value: num(r[mKey]), unit: 'count' as const })),
    table: true,
    empty: false,
    suggestions: [],
  };
}

/** ≈ 40-character token chunks on word boundaries (each ≤ 400 characters, contract TokenEvent). */
export function chunks(text: string, size = 40): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/(\s+)/)) {
    if (cur.length + word.length > size && cur) {
      out.push(cur);
      cur = '';
    }
    cur += word;
    while (cur.length > 400) {
      out.push(cur.slice(0, 400));
      cur = cur.slice(400);
    }
  }
  if (cur) out.push(cur);
  return out;
}
