// Liveness rules and derived projection fields (LLD §3.2, §4.1 row 3, §4.5).
import type { DemandMx, OfferMx } from './types.js';

/** offer_mx.is_matchable: not outside the launch area, not Expired, not Closed/Inactive, not merged or voided. */
export function offerIsMatchable(
  o: Pick<OfferMx, 'outsideLaunchArea' | 'lifeStage' | 'commercialStatus' | 'mergedInto' | 'voided'>,
): boolean {
  return (
    !o.outsideLaunchArea &&
    o.lifeStage !== 'Expired' &&
    o.commercialStatus !== 'Closed' &&
    o.commercialStatus !== 'Inactive' &&
    o.mergedInto === null &&
    !o.voided
  );
}

/** demand_mx.is_matchable: not exited, not Closed, not Expired/Paused, not merged or voided, inside the launch area. */
export function demandIsMatchable(
  d: Pick<
    DemandMx,
    'outsideLaunchArea' | 'exitType' | 'commercialStatus' | 'lifeStage' | 'mergedInto' | 'voided'
  >,
): boolean {
  return (
    !d.outsideLaunchArea &&
    d.exitType === null &&
    d.commercialStatus !== 'Closed' &&
    d.lifeStage !== 'Expired' &&
    d.lifeStage !== 'Paused' &&
    d.mergedInto === null &&
    !d.voided
  );
}

/** demand_mx.accepts_new: matchable and not Stale (a Stale demand keeps its matches but gets no new suggestions). */
export function demandAcceptsNew(d: Parameters<typeof demandIsMatchable>[0]): boolean {
  return demandIsMatchable(d) && d.lifeStage !== 'Stale';
}

/** True for deal types priced as a sale (price_key = sale price); Lease is priced as monthly rent. */
export const isSalePriced = (dealType: string) => dealType !== 'Lease';

/**
 * price_key (LLD §3.2, §4.2): Sale/Pagdi/JV → sale_price_inr_min, else max; Lease → rent_monthly_inr_min, else max.
 */
export function priceKeyOf(
  o: Pick<
    OfferMx,
    'dealType' | 'salePriceInrMin' | 'salePriceInrMax' | 'rentMonthlyInrMin' | 'rentMonthlyInrMax'
  >,
): number | null {
  return isSalePriced(o.dealType)
    ? (o.salePriceInrMin ?? o.salePriceInrMax)
    : (o.rentMonthlyInrMin ?? o.rentMonthlyInrMax);
}

/** The demand's budget max for a deal type: Sale/Pagdi → budget_inr_max; Lease → rent_monthly_inr_max; JV → none. */
export function budgetMaxFor(
  d: Pick<DemandMx, 'budgetInrMax' | 'rentMonthlyInrMax'>,
  dealType: string,
): number | null {
  if (dealType === 'JV') return null;
  return dealType === 'Lease' ? d.rentMonthlyInrMax : d.budgetInrMax;
}

export function budgetMinFor(
  d: Pick<DemandMx, 'budgetInrMin' | 'rentMonthlyInrMin'>,
  dealType: string,
): number | null {
  if (dealType === 'JV') return null;
  return dealType === 'Lease' ? d.rentMonthlyInrMin : d.budgetInrMin;
}

/**
 * Candidate keys (see migration 0002 index note): "<tenant>|<segment>|<deal_type>|<node>". An offer's keys use its
 * deal type and mm_path; a demand's keys use each of its deal types and mm_expanded. Two rows can match only if their
 * keys overlap (same tenant, segment, deal type and an overlapping micromarket node: filters 4, 6, 8).
 */
export function matchKeysOf(
  tenantId: string,
  segment: string | null,
  dealTypes: readonly string[],
  nodes: readonly string[],
): string[] {
  if (!segment || !dealTypes.length || !nodes.length) return [];
  const out: string[] = [];
  for (const dt of dealTypes) for (const n of nodes) out.push(`${tenantId}|${segment}|${dt}|${n}`);
  return [...new Set(out)].sort();
}

export const offerMatchKeys = (o: Pick<OfferMx, 'tenantId' | 'segment' | 'dealType' | 'mmPath'>) =>
  matchKeysOf(o.tenantId, o.segment, [o.dealType], o.mmPath);

export const demandMatchKeys = (d: Pick<DemandMx, 'tenantId' | 'segment' | 'dealTypes' | 'mmExpanded'>) =>
  matchKeysOf(d.tenantId, d.segment, d.dealTypes, d.mmExpanded);
