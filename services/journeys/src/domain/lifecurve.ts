// Life curve (BRD §4.5, PRD §4.1, D-12, R-12; LLD §4.1): category keys, thresholds, stage evaluation and stage actions.
import { addDays, daysBetween, maxDate } from './dates.js';
import type { IsoDate } from './dates.js';

export type Stage = 'Fresh' | 'Ageing' | 'Stale' | 'Expired' | 'Paused';
export type SubjectType = 'offer' | 'demand';

export interface Thresholds {
  freshMaxDays: number;
  ageingMaxDays: number;
  staleMaxDays: number;
}

export const OFFER_CATEGORIES = [
  'lease_residential',
  'lease_commercial',
  'sale_secondary',
  'sale_primary',
  'industrial',
  'land_jv',
] as const;
export const DEMAND_CATEGORIES = [
  'lease_residential',
  'lease_commercial',
  'sale_secondary_any',
  'sale_primary',
  'industrial',
  'land_jv',
] as const;
export type OfferCategory = (typeof OFFER_CATEGORIES)[number];
export type DemandCategory = (typeof DEMAND_CATEGORIES)[number];
export type CategoryKey = `offer.${OfferCategory}` | `demand.${DemandCategory}`;

export interface ThresholdSettings {
  offer: Record<OfferCategory, Thresholds>;
  demand: Record<DemandCategory, Thresholds>;
  /** Upcoming offers start their clock this many days before availability (BRD §4.5). */
  upcomingLeadDays: number;
  /** Default Dormant revisit (A-41). */
  dormantRevisitDays: number;
}

const t = (freshMaxDays: number, ageingMaxDays: number, staleMaxDays: number): Thresholds => ({
  freshMaxDays,
  ageingMaxDays,
  staleMaxDays,
});

/** Seed values: LLD §4.1.1 (BRD §4.5 + D-12). */
export const DEFAULT_THRESHOLDS: ThresholdSettings = {
  offer: {
    industrial: t(45, 90, 120),
    land_jv: t(60, 120, 180),
    lease_residential: t(14, 30, 45),
    lease_commercial: t(30, 60, 90),
    sale_primary: t(30, 60, 90),
    sale_secondary: t(45, 90, 120),
  },
  demand: {
    industrial: t(45, 90, 120),
    land_jv: t(60, 120, 180),
    lease_residential: t(14, 21, 30),
    lease_commercial: t(30, 60, 90),
    sale_primary: t(30, 60, 120),
    sale_secondary_any: t(45, 90, 150),
  },
  upcomingLeadDays: 60,
  dormantRevisitDays: 60,
};

/** fresh < ageing < stale for every category (400 invalid-thresholds otherwise). */
export function thresholdErrors(s: ThresholdSettings): string[] {
  const errors: string[] = [];
  const check = (side: string, key: string, v: Thresholds) => {
    if (!(v.freshMaxDays < v.ageingMaxDays && v.ageingMaxDays < v.staleMaxDays))
      errors.push(`${side}.${key}`);
  };
  for (const k of OFFER_CATEGORIES) check('offer', k, s.offer[k]);
  for (const k of DEMAND_CATEGORIES) check('demand', k, s.demand[k]);
  return errors;
}

export interface OfferCategoryInput {
  segment: string | null;
  dealType: string;
  market: string | null;
}

/** First matching rule wins (LLD §4.1.1; JA-2: Industrial before Land/JV and Pagdi). */
export function offerCategory(o: OfferCategoryInput): OfferCategory {
  if (o.segment === 'Industrial') return 'industrial';
  if (o.segment === 'Land' || o.dealType === 'JV') return 'land_jv';
  if (o.dealType === 'Pagdi') return 'sale_secondary';
  if (o.dealType === 'Lease') return o.segment === 'Commercial' ? 'lease_commercial' : 'lease_residential';
  if (o.dealType === 'Sale' && o.market === 'Primary') return 'sale_primary';
  return 'sale_secondary';
}

export interface DemandCategoryInput {
  segment: string | null;
  dealTypes: readonly string[];
  market: string | null;
}

function demandCategoryFor(segment: string | null, dealType: string, market: string | null): DemandCategory {
  if (segment === 'Industrial') return 'industrial';
  if (segment === 'Land' || dealType === 'JV') return 'land_jv';
  if (dealType === 'Pagdi') return 'sale_secondary_any';
  if (dealType === 'Lease') return segment === 'Commercial' ? 'lease_commercial' : 'lease_residential';
  if (dealType === 'Sale' && market === 'Primary') return 'sale_primary';
  return 'sale_secondary_any';
}

/** Per deal type; several deal types take the shortest thresholds (smallest Stale limit), R-12. */
export function demandCategory(d: DemandCategoryInput, settings: ThresholdSettings): DemandCategory {
  const candidates = (d.dealTypes.length ? d.dealTypes : ['Sale']).map((dt) =>
    demandCategoryFor(d.segment, dt, d.market),
  );
  let best = candidates[0] as DemandCategory;
  for (const c of candidates) {
    const a = settings.demand[c];
    const b = settings.demand[best];
    if (
      a.staleMaxDays < b.staleMaxDays ||
      (a.staleMaxDays === b.staleMaxDays && a.ageingMaxDays < b.ageingMaxDays)
    )
      best = c;
  }
  return best;
}

export function thresholdsFor(key: string, settings: ThresholdSettings): Thresholds {
  const [side, cat] = key.split('.') as [string, string];
  const table = side === 'offer' ? settings.offer : settings.demand;
  const found = (table as Record<string, Thresholds>)[cat];
  if (!found) throw new RangeError(`unknown category key ${key}`);
  return found;
}

export function stageForDay(day: number, th: Thresholds): Exclude<Stage, 'Paused'> {
  if (day <= th.freshMaxDays) return 'Fresh';
  if (day <= th.ageingMaxDays) return 'Ageing';
  if (day <= th.staleMaxDays) return 'Stale';
  return 'Expired';
}

export interface CurveInput {
  lastConfirmedDate: IsoDate | null;
  /** captured_on, or the latest price sheet for a project configuration */
  clockFloor: IsoDate;
  /** Upcoming offers: available_from − upcomingLeadDays */
  clockStartsOn: IsoDate | null;
  thresholds: Thresholds;
  today: IsoDate;
  /** Dormant demand */
  paused: boolean;
}

export interface CurveState {
  stage: Stage;
  dayCount: number;
  /** First date the stage can change; null when Expired or Paused. */
  nextChangeOn: IsoDate | null;
}

/** clock_date = max(last confirmed, floor, clock start); day = today − clock_date; stage by thresholds (LLD §4.1.2). */
export function evaluateCurve(input: CurveInput): CurveState {
  if (input.paused) return { stage: 'Paused', dayCount: 0, nextChangeOn: null };
  const floor = maxDate(input.clockFloor, input.clockStartsOn);
  const clockDate = maxDate(floor, input.lastConfirmedDate);
  const dayCount = Math.max(0, daysBetween(clockDate, input.today));
  const stage = stageForDay(dayCount, input.thresholds);
  const limit =
    stage === 'Fresh'
      ? input.thresholds.freshMaxDays
      : stage === 'Ageing'
        ? input.thresholds.ageingMaxDays
        : stage === 'Stale'
          ? input.thresholds.staleMaxDays
          : null;
  let nextChangeOn = limit === null ? null : addDays(clockDate, limit + 1);
  // Before an Upcoming clock starts the curve does not run; evaluate again on the start date (AS-S5).
  if (input.clockStartsOn && input.today < input.clockStartsOn && nextChangeOn !== null)
    nextChangeOn = input.clockStartsOn < nextChangeOn ? input.clockStartsOn : nextChangeOn;
  return { stage, dayCount, nextChangeOn };
}

/** Upcoming: the clock starts `lead` days before a future availability date (LLD §4.1.2). */
export function upcomingClockStart(
  availableFrom: IsoDate | null,
  today: IsoDate,
  leadDays: number,
): IsoDate | null {
  if (!availableFrom || availableFrom <= today) return null;
  return addDays(availableFrom, -leadDays);
}

export type StageAction =
  | { kind: 'queue'; section: 'should_call'; reason: 'reconfirm' | 'stale_public' | 'request_price_sheet'; boost: 'ageing' | 'stale_public' | 'none' }
  | { kind: 'queue'; section: 'reconfirm_due'; reason: 'reconfirm'; boost: 'none' }
  | { kind: 'availability_unknown' }
  | { kind: 'dormant_exit' };

export interface StageActionContext {
  publicationLevel: string | null;
  /** Sale, Primary offer with a project (a project configuration, AS-S6). */
  isProjectConfiguration: boolean;
}

/** Actions applied in the transaction that moves a curve into `to` (LLD §4.1.4). */
export function stageActions(subject: SubjectType, to: Stage, ctx: StageActionContext): StageAction[] {
  if (subject === 'offer') {
    const base = ctx.isProjectConfiguration ? 'request_price_sheet' : 'reconfirm';
    switch (to) {
      case 'Ageing':
        return [{ kind: 'queue', section: 'should_call', reason: base, boost: 'ageing' }];
      case 'Stale':
        return ctx.publicationLevel === 'Public'
          ? [{ kind: 'queue', section: 'should_call', reason: 'stale_public', boost: 'stale_public' }]
          : [{ kind: 'queue', section: 'should_call', reason: base, boost: 'none' }];
      case 'Expired':
        return [
          { kind: 'queue', section: 'should_call', reason: base, boost: 'none' },
          { kind: 'availability_unknown' },
        ];
      default:
        return [];
    }
  }
  switch (to) {
    case 'Ageing':
    case 'Stale':
      return [{ kind: 'queue', section: 'reconfirm_due', reason: 'reconfirm', boost: 'none' }];
    case 'Expired':
      return [{ kind: 'dormant_exit' }];
    default:
      return [];
  }
}
