// Queues (PRD §4.2, §4.3, D-10; LLD §4.3): sections, Should call ranking, daily plan and assignment policy.
import { daysBetween } from './dates.js';
import type { IsoDate } from './dates.js';

export const SUPPLY_SECTIONS = ['must_call', 'should_call', 'sourcing_requests', 'watchlist_tasks'] as const;
export const DEMAND_SECTIONS = [
  'to_contact',
  'to_qualify',
  'reconfirm_due',
  'needs_sourcing',
  'in_sourcing',
  'sourcing_requests_open',
  'open_matches',
  'proposals_out',
  'site_visits_this_week',
  'deals_follow_up',
  'dormant_revisits',
] as const;
export type SupplySection = (typeof SUPPLY_SECTIONS)[number];
export type DemandSection = (typeof DEMAND_SECTIONS)[number];
export type Section = SupplySection | DemandSection;
export type Team = 'supply' | 'demand';
export const ALL_SECTIONS: readonly Section[] = [...SUPPLY_SECTIONS, ...DEMAND_SECTIONS];

export function teamOf(section: Section): Team {
  return (SUPPLY_SECTIONS as readonly string[]).includes(section) ? 'supply' : 'demand';
}
export function isSection(s: string): s is Section {
  return (ALL_SECTIONS as readonly string[]).includes(s);
}
/** should_call is ordered by rank; every other section by (priority desc, due_at, id). */
export const isRankedSection = (s: Section) => s === 'should_call';

export type QueueReason =
  | 'enquiry'
  | 'match'
  | 'sourced_for'
  | 'new_capture'
  | 'reconfirm'
  | 'stale_public'
  | 'request_price_sheet'
  | 'srq'
  | 'watchlist'
  | 'first_contact'
  | 'qualify'
  | 'open_matches'
  | 'no_matches'
  | 'proposal_feedback'
  | 'visit'
  | 'follow_up'
  | 'revisit'
  | 'unreachable';

export type QueueSubjectType =
  | 'offer'
  | 'demand'
  | 'sourcing_request'
  | 'proposal'
  | 'site_visit'
  | 'deal'
  | 'watchlist_task';

export function teamForRole(role: string): Team | null {
  if (role === 'Supply agent') return 'supply';
  if (role === 'Demand agent') return 'demand';
  return null;
}
export const roleForTeam = (team: Team) => (team === 'supply' ? 'Supply agent' : 'Demand agent');

export interface QueueWeights {
  freshness: number;
  demandGap: number;
  sourceQuality: number;
  priceBand: number;
  stalePublicBoost: number;
  ageingReconfirmBoost: number;
  freshnessHorizonDays: number;
  demandGapCap: number;
  mustCallDueHours: number;
  maxAttempts: number;
}

export const DEFAULT_WEIGHTS: QueueWeights = {
  freshness: 0.25,
  demandGap: 0.35,
  sourceQuality: 0.2,
  priceBand: 0.2,
  stalePublicBoost: 15,
  ageingReconfirmBoost: 5,
  freshnessHorizonDays: 60,
  demandGapCap: 20,
  mustCallDueHours: 24,
  maxAttempts: 3,
};

export const DEFAULT_DAILY_CAPACITY = 40;

export function weightsValid(w: QueueWeights): boolean {
  return w.freshness + w.demandGap + w.sourceQuality + w.priceBand > 0;
}

export interface BudgetBand {
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
}

export interface RankInput {
  lastSeenOn: IsoDate;
  today: IsoDate;
  /** open demand − matching supply in the offer's cell; null when the cell is unknown */
  gap: number | null;
  /** source_quality.score; null → default 0.5 */
  sourceScore: number | null;
  dealType: string;
  salePriceInrMin: number | null;
  rentMonthlyInrMin: number | null;
  band: BudgetBand | null;
  boost: 'ageing' | 'stale_public' | 'none';
}

export interface RankFactors {
  freshness: number;
  demandGap: number;
  sourceQuality: number;
  priceBand: number;
  boost: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Price band factor (LLD §4.3.3). No budget data in the cell → neutral 0.5 (assumption, docs silent). */
export function priceBandFactor(input: Pick<RankInput, 'dealType' | 'salePriceInrMin' | 'rentMonthlyInrMin' | 'band'>): number {
  if (input.dealType === 'JV') return 0.5;
  const price = input.dealType === 'Lease' ? input.rentMonthlyInrMin : input.salePriceInrMin;
  if (price === null || price === undefined) return 0.3;
  const b = input.band;
  if (!b || b.p25 === null || b.p75 === null) return 0.5;
  if (price >= b.p25 && price <= b.p75) return 1;
  if (b.p10 !== null && b.p90 !== null && price >= b.p10 && price <= b.p90) return 0.5;
  return 0.1;
}

/** rank = 100 × Σ(w·factor) / Σw + boost (LLD §4.3.3). */
export function computeRank(input: RankInput, w: QueueWeights): { rank: number; factors: RankFactors } {
  const days = Math.max(0, daysBetween(input.lastSeenOn, input.today));
  const F = clamp01(1 - days / w.freshnessHorizonDays);
  const G = input.gap === null ? 0 : clamp01(input.gap / w.demandGapCap);
  const S = clamp01(input.sourceScore ?? 0.5);
  const P = priceBandFactor(input);
  const boost =
    input.boost === 'stale_public' ? w.stalePublicBoost : input.boost === 'ageing' ? w.ageingReconfirmBoost : 0;
  const sum = w.freshness + w.demandGap + w.sourceQuality + w.priceBand || 1;
  const base = (100 * (w.freshness * F + w.demandGap * G + w.sourceQuality * S + w.priceBand * P)) / sum;
  const rank = Math.min(9999.99, Math.round((base + boost) * 100) / 100);
  return {
    rank,
    factors: { freshness: round3(F), demandGap: round3(G), sourceQuality: round3(S), priceBand: P, boost },
  };
}

/** Smoothed share of captures that became verified or matched in 90 days (LLD §4.3.3). */
export function sourceQualityScore(captured90d: number, verifiedOrMatched90d: number): number {
  return Math.round(((verifiedOrMatched90d + 2.5) / (captured90d + 5)) * 1000) / 1000;
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

/** Daily list (D-10): all Must call + Should call up to max(0, capacity − openMust − callsLoggedToday). */
export function dailyPlan(capacity: number, openMust: number, callsLoggedToday: number, eligibleShould: number) {
  const shouldSlots = Math.max(0, capacity - openMust - callsLoggedToday);
  const plannedShould = Math.min(eligibleShould, shouldSlots);
  return { shouldSlots, plannedShould, plannedToday: openMust + plannedShould };
}

/** Least-loaded active member; tie → lowest user id (LLD §4.3.5, JA-4). */
export function pickLeastLoaded(candidates: readonly { userId: string; openCount: number }[]): string | null {
  let best: { userId: string; openCount: number } | null = null;
  for (const c of candidates) {
    if (!best || c.openCount < best.openCount || (c.openCount === best.openCount && c.userId < best.userId))
      best = c;
  }
  return best?.userId ?? null;
}

const inr = (v: number) =>
  v >= 10_000_000 ? `₹${(v / 10_000_000).toFixed(2).replace(/\.?0+$/, '')} Cr` : v >= 100_000 ? `₹${(v / 100_000).toFixed(2).replace(/\.?0+$/, '')} L` : `₹${v}`;

/** Queue summary line from stored fields only, never contact PII (QueueItem.summary). */
export function offerSummary(o: {
  dealType: string;
  propertyTypes: readonly string[];
  micromarket: string | null;
  areaSqftMin: number | null;
  salePriceInrMin: number | null;
  rentMonthlyInrMin: number | null;
}): string {
  const parts = [o.dealType, o.propertyTypes[0], o.micromarket];
  if (o.areaSqftMin) parts.push(`${Math.round(o.areaSqftMin)} sq ft`);
  const price = o.dealType === 'Lease' ? o.rentMonthlyInrMin : o.salePriceInrMin;
  if (price) parts.push(o.dealType === 'Lease' ? `${inr(price)}/mo` : inr(price));
  return parts.filter(Boolean).join(' · ').slice(0, 200);
}

export function demandSummary(d: {
  dealTypes: readonly string[];
  propertyTypes: readonly string[];
  micromarkets: readonly string[];
  budgetInrMax: number | null;
  rentMonthlyInrMax: number | null;
}): string {
  const parts = [d.dealTypes.join('/'), d.propertyTypes[0], d.micromarkets.slice(0, 2).join(', ')];
  const budget = d.dealTypes.includes('Lease') ? d.rentMonthlyInrMax : d.budgetInrMax;
  if (budget) parts.push(`up to ${inr(budget)}`);
  return parts.filter(Boolean).join(' · ').slice(0, 200);
}
