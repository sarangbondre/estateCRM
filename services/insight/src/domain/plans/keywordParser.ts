// Keyword fallback (LLD §4.5): builds a plan from the REDACTED text without the model — used when the model is
// unavailable (credits, timeout, circuit open) or its output is invalid. Nothing matched → null (out of scope). Pure.
import type { PeriodPreset } from '../dates.js';
import type { PlannerDecision } from '../chat/modelOutput.js';
import { ACTIVE_OFFER_STATUSES } from './catalogue.js';
import type { PlanFilter, QueryPlan } from './types.js';

export interface KeywordContext {
  now: Date;
  /** Active release values per vocabulary field (property types, …). */
  vocabulary: Readonly<Record<string, readonly string[]>>;
  /** Known locality / micromarket names and aliases (as written in the hierarchy). */
  locations: readonly string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text: string, re: RegExp) => re.test(text);
const UNIT: Record<string, number> = { k: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 };

function money(n: string, unit: string): number {
  return Math.round(Number(n) * (UNIT[unit.toLowerCase()] ?? 1));
}

function period(text: string): PeriodPreset | undefined {
  if (has(text, /\bnext\s+60\s+days\b/)) return 'next_60_days';
  if (has(text, /\blast\s+30\s+days\b/)) return 'last_30_days';
  if (has(text, /\blast\s+month\b/)) return 'last_month';
  if (has(text, /\bthis\s+quarter\b/)) return 'this_quarter';
  if (has(text, /\bthis\s+month\b/)) return 'this_month';
  if (has(text, /\bthis\s+week\b/)) return 'this_week';
  if (has(text, /\btoday\b/)) return 'today';
  return undefined;
}

export function parseKeywords(redacted: string, ctx: KeywordContext): PlannerDecision | null {
  const text = ` ${redacted.toLowerCase().replace(/[?!]|,(?!\d)/g, ' ').replace(/\s+/g, ' ')} `;
  const filters: PlanFilter[] = [];
  const add = (field: string, op: PlanFilter['op'], value: unknown) => {
    if (!filters.some((f) => f.field === field)) filters.push({ field, op, value });
  };

  // ---- side and intent
  const demandSide = has(text, /\b(requirements?|wants|looking for|client needs|demands?)\b/);
  const matchIntent = has(text, /\bmatch(es|ing)?\b/) && has(text, /\brequirements?\b/);
  const exportRequested = has(text, /\b(excel|export|download|xlsx|spreadsheet)\b/);
  const howMany = has(text, /\bhow many\b|\bcount\b|\bnumber of\b/);
  const preset = period(text);

  // ---- classification
  let dealType: string | undefined;
  if (has(text, /\bresale\b/)) {
    dealType = 'Sale';
    add('market', 'eq', 'Secondary');
  } else if (has(text, /\bnew projects?\b/)) {
    dealType = 'Sale';
    add('market', 'eq', 'Primary');
  } else if (has(text, /\b(lease|rent|rental|leave and licen[cs]e)\b/)) dealType = 'Lease';
  else if (has(text, /\b(sale|buy|purchase)\b/)) dealType = 'Sale';
  else if (has(text, /\bpagdi\b/)) dealType = 'Pagdi';
  const segment = ['residential', 'commercial', 'industrial', 'land'].find((s) => has(text, new RegExp(`\\b${s}\\b`)));
  const propertyTypes = (ctx.vocabulary['property_type'] ?? []).filter((t) => has(text, new RegExp(`\\b${esc(t.toLowerCase())}(e?s)?\\b`)));
  if (!propertyTypes.length && has(text, /\b(flats?|apartments?)\b/)) propertyTypes.push('Apartment');
  const bhk = /\b(\d(?:\.5)?)\s*bhk\b/.exec(text)?.[1] ?? (has(text, /\b1\s*rk\b/) ? '0.5' : undefined);
  const price = /\b(under|below|upto|up to|less than|within|<|above|over|more than|>)\s*(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k|l|lakhs?|lacs?|cr|crores?)\b/.exec(text);
  const area = /\b(?:(above|over|more than|at least|under|below|upto|up to|less than|of|around|about)\s+)?(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|square feet)\b/.exec(text);
  const lifeStage = ['fresh', 'ageing', 'stale', 'expired'].find((s) => has(text, new RegExp(`\\b${s}\\b`)));
  const publication = ['public', 'anonymous', 'private'].find((s) => has(text, new RegExp(`\\b${s}\\b`)));
  // Longest names first; a shorter name inside text already matched by a longer one ("Andheri" in "Andheri West")
  // isn't a second place.
  const taken: [number, number][] = [];
  const locations = [...ctx.locations]
    .sort((a, b) => b.length - a.length)
    .filter((l) => {
      const m = new RegExp(`\\b${esc(l.toLowerCase())}\\b`).exec(text);
      if (!m) return false;
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (taken.some(([a, b]) => span[0] >= a && span[1] <= b)) return false;
      taken.push(span);
      return true;
    });
  const location = locations[0];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const classify = (prefix = '') => {
    if (dealType) add(`${prefix}deal_type`, 'eq', dealType);
    if (segment) add(`${prefix}segment`, 'eq', cap(segment));
    if (propertyTypes[0]) add(`${prefix}property_type`, propertyTypes.length > 1 ? 'in' : 'eq', propertyTypes.length > 1 ? propertyTypes : propertyTypes[0]);
  };
  const areaFilter = (field: string) => {
    if (!area?.[2]) return;
    const n = Number(area[2].replace(/,/g, ''));
    const word = area[1] ?? '';
    add(field, /above|over|more|least/.test(word) ? 'gte' : /under|below|upto|up to|less/.test(word) ? 'lte' : 'eq', n);
  };
  const plan = (planId: string, extra: Partial<QueryPlan> = {}): PlannerDecision => ({
    kind: 'plan',
    plan: { planId, templateVersion: 1, ...(filters.length ? { filters } : {}), ...extra },
    exportRequested,
  });

  // ---- intents with their own template
  if (has(text, /\bmy queue\b/)) return { kind: 'navigate', planId: 'open_my_queue' };
  if (has(text, /\bfollow[- ]?ups?\b/)) {
    if (has(text, /\b(overdue|due|today)\b/)) add('follow_up_date', 'lte', 'today');
    return plan('list_my_followups');
  }
  if (has(text, /\bbundles?\b/)) {
    if (has(text, /\bsuggested\b/)) add('status', 'eq', 'Suggested');
    if (propertyTypes[0]) add('demand_property_type', 'eq', propertyTypes[0]);
    if (segment) add('demand_segment', 'eq', cap(segment));
    areaFilter('demand_area_sqft');
    return plan('list_bundles');
  }
  if (has(text, /\b(more|higher) (open )?demand than\b|\bdemand vs\.? supply\b|\bsupply gap\b|\bgap\b/)) {
    classify();
    return plan('supply_demand_gap');
  }
  if (has(text, /\b(average|avg|median|mean)\b/) && has(text, /\b(rent|price|closed|sold|leased)\b/)) {
    if (!dealType && has(text, /\brent\b/)) dealType = 'Lease';
    classify();
    if (location) add('location', 'eq', location);
    return plan('closed_price_stats', preset ? { period: { preset } } : {});
  }
  if (has(text, /\bsource type|\bsources?\b|\bchannel\b/) && has(text, /\bqualified\b/)) {
    return plan('source_quality', preset ? { period: { preset, field: 'qualified_at' } } : {});
  }
  if (has(text, /\b(each|per|every)\b.*\bagent\b|\bagent\b.*\beach\b/)) {
    const metric = has(text, /\bverif/) ? 'offer_verified' : has(text, /\bcalls?\b/) ? 'calls_logged' : has(text, /\bclos/) ? 'deal_closed' : 'offer_verified';
    add('metric', 'eq', metric);
    return plan('agent_activity', { groupBy: ['owner_user_id'], ...(preset ? { period: { preset } } : {}) });
  }
  if (has(text, /\buploads?\b/)) return plan('upload_quality', preset ? { period: { preset } } : {});

  // ---- offers / demands
  const side = matchIntent ? 'offer' : demandSide ? 'demand' : 'offer';
  classify();
  if (bhk) add('bhk', 'eq', Number(bhk));
  if (price?.[2] && price[3]) {
    const value = money(price[2], price[3]);
    const field = side === 'demand' ? (dealType === 'Lease' ? 'rent_monthly_inr' : 'budget_inr') : dealType === 'Lease' ? 'rent_monthly_inr' : 'sale_price_inr';
    add(field, /above|over|more|>/.test(price[1] ?? '') ? 'gte' : 'lte', value);
  }
  areaFilter('area_sqft');
  if (location) add('location', locations.length > 1 ? 'in' : 'eq', locations.length > 1 ? locations : location);
  if (lifeStage) add('life_stage', 'eq', cap(lifeStage));
  let periodField: string | undefined;
  if (side === 'offer') {
    if (publication) add('publication_level', 'eq', cap(publication));
    if (has(text, /\bupcoming\b/)) {
      add('commercial_status', 'eq', 'Upcoming');
      if (has(text, /\bavailable\b/)) periodField = 'available_from';
    } else if (has(text, /\bactive\b/)) add('commercial_status', 'in', ACTIVE_OFFER_STATUSES);
    if (lifeStage && has(text, /\b(turned|became|went|moved)\b/)) periodField = 'life_stage_since';
  } else {
    if (has(text, /\bsourcing\b/)) add('commercial_status', 'eq', 'Sourcing');
    const days = /\b(?:more than|over|at least)\s+(\d+)\s+days\b/.exec(text)?.[1];
    if (days && has(text, /\bsourcing\b/)) add('days_in_sourcing', 'gte', Number(days));
    if (has(text, /\bqualified\b/)) periodField = 'qualified_at';
  }
  const mine = has(text, /\b(my|mine)\b/);
  // A place or a date alone is not a question about our data ("weather in Powai today").
  const anything =
    filters.some((f) => f.field !== 'location') || demandSide || matchIntent || has(text, /\b(offers?|inventory|listings?|supply|properties|available)\b/);
  if (!anything) return null;
  const kind = howMany && !exportRequested ? 'count' : 'list';
  return plan(`${kind}_${side === 'offer' ? 'offers' : 'demands'}`, {
    ...(preset ? { period: { preset, ...(periodField ? { field: periodField } : {}) } } : {}),
    ...(mine ? { me: true } : {}),
  });
}

/**
 * Keywords first (CR-017): the parser's decision is used without the model unless it fell back to a generic offer/demand
 * list or count while the question asks for something those can't express: rankings, breakdowns, comparisons or trends
 * ("which localities have the most…", "by BHK", "compare…"). Dedicated intents (gap, prices, sources, agents…) always win.
 */
const ANALYTIC = /\b(most|least|top|highest|lowest|best|worst|rank(ing)?|by|per|each|compare[ds]?|comparison|versus|vs\.?|trends?|breakdown|split|distribution|group(ed)?|which\s+(localit(y|ies)|micromarkets?|areas?|agents?|sources?|segments?|cities))\b/;
const GENERIC = new Set(['list_offers', 'count_offers', 'list_demands', 'count_demands']);

export function keywordsSuffice(redacted: string, decision: PlannerDecision | null): boolean {
  if (!decision || decision.kind === 'refusal' || decision.kind === 'clarify') return false;
  if (decision.kind !== 'plan' || !GENERIC.has(decision.plan.planId)) return true;
  return !ANALYTIC.test(redacted.toLowerCase());
}
