// Bundles (LLD §4.3, PRD §4.5, A-38, AS-D1): 2–3 offers whose combined area meets a Commercial / Industrial demand,
// co-located in the same building, the same micromarket or adjacent micromarkets (R-13), same deal type (JB-6),
// combined price within budget. A bundle is one match.
import { demandAcceptsNew } from './matchable.js';
import type { Hierarchy } from './micromarket.js';
import { budgetMaxFor, priceKeyOf } from './matchable.js';
import type { PairScore, ScoringContext } from './scoring.js';
import { areaFactor, combine, offerAreaSize, priceFactor, sortFlags } from './scoring.js';
import type { BundleGrouping, DemandMx, FactorName, FactorResult, MatchFlag, OfferMx } from './types.js';
import { FACTORS } from './types.js';

export const BUNDLE_SEGMENTS = ['Commercial', 'Industrial'];

/** Eligible demands: Commercial or Industrial, with area_sqft_min, accepting new suggestions. */
export function bundleEligible(d: DemandMx): boolean {
  return (
    BUNDLE_SEGMENTS.includes(d.segment ?? '') &&
    d.areaSqftMin !== null &&
    d.areaSqftMin > 0 &&
    demandAcceptsNew(d)
  );
}

/** A bundle member: an offer that passed filters 1–9 for the demand, with its single-pair score. */
export interface BundleMember {
  offer: OfferMx;
  pair: PairScore;
}

export interface BundleCandidate {
  offerIds: string[];
  offerSetKey: string;
  grouping: BundleGrouping;
  combinedAreaSqft: number;
  combinedPriceInr: number | null;
  combinedRentMonthlyInr: number | null;
  score: number;
  factors: FactorResult[];
  flags: MatchFlag[];
}

export const offerSetKeyOf = (ids: readonly string[]) => [...ids].sort().join(',');

/** The micromarket-level node of an offer (co-location); falls back to the raw micromarket text. */
export function micromarketKeyOf(o: OfferMx, h: Hierarchy): string | null {
  for (const k of o.mmPath) {
    const n = h.node(k);
    if (n?.level === 'micromarket') return n.key;
  }
  return o.micromarket ? `name:${o.micromarket.trim().toLowerCase()}` : null;
}

/** Co-location grouping of a set of offers, or null when they are not co-located. */
export function groupingOf(offers: readonly OfferMx[], h: Hierarchy): BundleGrouping | null {
  const first = offers[0];
  if (!first) return null;
  if (first.buildingKey && offers.every((o) => o.buildingKey === first.buildingKey)) return 'same_building';
  const mms = offers.map((o) => micromarketKeyOf(o, h));
  if (mms.some((m) => m === null)) return null;
  const keys = mms as string[];
  if (keys.every((k) => k === keys[0])) return 'same_micromarket';
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++)
      if (!h.sameOrAdjacent(keys[i] as string, keys[j] as string)) return null;
  return 'adjacent_micromarket';
}

const GROUPING_RANK: Record<BundleGrouping, number> = {
  same_building: 0,
  same_micromarket: 1,
  adjacent_micromarket: 2,
};

/**
 * Scores a set of offers as one bundle: §4.2 with area and price on the sums, the other factors averaged across
 * members. Returns null when the combined area is below the demand's minimum, above max × (1 + tol), or the combined
 * price exceeds the budget max.
 */
export function scoreBundle(
  members: readonly BundleMember[],
  grouping: BundleGrouping,
  d: DemandMx,
  ctx: ScoringContext,
  /** false for a manual bundle: area and budget limits are scored (and flagged), not enforced. */
  enforceLimits = true,
): BundleCandidate | null {
  const offers = members.map((m) => m.offer);
  const dealType = offers[0]?.dealType;
  if (!dealType || offers.some((o) => o.dealType !== dealType)) return null;
  const sizes = offers.map((o) => offerAreaSize(o));
  if (sizes.some((s) => s === null)) return null;
  const area = (sizes as number[]).reduce((s, v) => s + v, 0);
  const dMin = d.areaSqftMin ?? 0;
  if (enforceLimits && area < dMin) return null;
  if (
    enforceLimits &&
    d.areaSqftMax !== null &&
    area > d.areaSqftMax * (1 + ctx.weights.tuning.areaTolerancePct / 100)
  )
    return null;
  const prices = offers.map((o) => priceKeyOf(o));
  const combinedPrice = prices.some((p) => p === null)
    ? null
    : (prices as number[]).reduce((s, v) => s + v, 0);
  const budget = budgetMaxFor(d, dealType);
  if (enforceLimits && combinedPrice !== null && budget !== null && combinedPrice > budget) return null;

  const bases = new Set(offers.map((o) => o.areaBasis));
  const basis = bases.size === 1 ? (offers[0]?.areaBasis ?? null) : null;
  const areaF = areaFactor({ min: area, max: area }, basis, false, d, ctx);
  const priceF = priceFactor(combinedPrice, dealType, d, ctx);
  const avg = (f: FactorName) => {
    const vs = members.map((m) => m.pair.values[f]).filter((v) => v.applicable);
    if (!vs.length) return { applicable: false, value: 0 };
    return {
      applicable: true,
      value: vs.reduce((s, v) => s + v.value, 0) / vs.length,
      note: `average of ${vs.length} offers`,
    };
  };
  const values = Object.fromEntries(
    FACTORS.map((f) => [f, f === 'area' ? areaF : f === 'price' ? priceF : avg(f)]),
  ) as Record<FactorName, { applicable: boolean; value: number; note?: string }>;
  values.area = { ...areaF, note: `combined ${areaF.note ?? ''}`.trim() };
  const { score, factors } = combine(values, ctx.weights);
  const flags = new Set<MatchFlag>();
  for (const m of members) for (const f of m.pair.flags) if (f !== 'price_above_budget') flags.add(f);
  if (priceF.aboveBudget) flags.add('price_above_budget');
  if (areaF.basisUnknown) flags.add('area_basis_unknown');
  const lease = dealType === 'Lease';
  return {
    offerIds: [...offers.map((o) => o.id)].sort(),
    offerSetKey: offerSetKeyOf(offers.map((o) => o.id)),
    grouping,
    combinedAreaSqft: area,
    combinedPriceInr: lease ? null : combinedPrice,
    combinedRentMonthlyInr: lease ? combinedPrice : null,
    score,
    factors,
    flags: sortFlags([...flags]),
  };
}

function* combinations<T>(items: readonly T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = start; i < items.length; i++) {
    acc.push(items[i] as T);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

/**
 * BundleFinder (LLD §4.3). `members` are offers that passed filters 1–9 for the demand ignoring area. Only offers
 * smaller than area_sqft_min that cannot be a single match (outside the area tolerance) qualify: "an offer that meets
 * the area alone is a single match". Groups: same buildingKey,
 * same micromarket, and each micromarket with its adjacent micromarkets; each capped at bundleCandidateCap largest.
 * Combinations of 2..bundleMaxOffers per group; the best bundlesPerDemand not sharing offers with a better one are kept.
 */
export function findBundles(
  d: DemandMx,
  members: readonly BundleMember[],
  ctx: ScoringContext,
): BundleCandidate[] {
  const t = ctx.weights.tuning;
  if (!bundleEligible(d) || t.bundlesPerDemand === 0) return [];
  const min = d.areaSqftMin as number;
  // Only offers too small to be a single match: below the minimum and outside the area tolerance on their own.
  const small = members.filter((m) => {
    const s = offerAreaSize(m.offer);
    return s !== null && s > 0 && s < min && m.pair.areaOutOfRange;
  });
  if (small.length < 2) return [];
  const h = ctx.hierarchy;
  const bySize = (a: BundleMember, b: BundleMember) =>
    (offerAreaSize(b.offer) as number) - (offerAreaSize(a.offer) as number) ||
    (a.offer.id < b.offer.id ? -1 : 1);

  const groups = new Map<string, BundleMember[]>();
  const add = (key: string, m: BundleMember) => {
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  };
  const byMm = new Map<string, BundleMember[]>();
  for (const m of small) {
    const dt = m.offer.dealType;
    if (m.offer.buildingKey) add(`b|${dt}|${m.offer.buildingKey}`, m);
    const mm = micromarketKeyOf(m.offer, h);
    if (mm) {
      add(`m|${dt}|${mm}`, m);
      const list = byMm.get(`${dt}|${mm}`) ?? [];
      list.push(m);
      byMm.set(`${dt}|${mm}`, list);
    }
  }
  const split = (k: string) => [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)] as const;
  for (const [dtMm, list] of byMm) {
    const [dt, mm] = split(dtMm);
    const neighbours: BundleMember[] = [];
    for (const [other, l] of byMm) {
      const [dt2, mm2] = split(other);
      if (other !== dtMm && dt2 === dt && h.sameOrAdjacent(mm, mm2)) neighbours.push(...l);
    }
    if (neighbours.length) for (const m of [...list, ...neighbours]) add(`a|${dtMm}`, m);
  }

  const seen = new Map<string, BundleCandidate>();
  for (const list of groups.values()) {
    const unique = [...new Map(list.map((m) => [m.offer.id, m])).values()]
      .sort(bySize)
      .slice(0, t.bundleCandidateCap);
    for (let k = 2; k <= t.bundleMaxOffers; k++) {
      for (const combo of combinations(unique, k)) {
        const key = offerSetKeyOf(combo.map((m) => m.offer.id));
        if (seen.has(key)) continue;
        const grouping = groupingOf(
          combo.map((m) => m.offer),
          h,
        );
        if (!grouping) continue;
        const b = scoreBundle(combo, grouping, d, ctx);
        if (b && b.score >= t.minScore) seen.set(key, b);
      }
    }
  }
  const ranked = [...seen.values()].sort(
    (a, b) =>
      b.score - a.score ||
      a.offerIds.length - b.offerIds.length ||
      GROUPING_RANK[a.grouping] - GROUPING_RANK[b.grouping] ||
      a.combinedAreaSqft - b.combinedAreaSqft ||
      (a.offerSetKey < b.offerSetKey ? -1 : 1),
  );
  const kept: BundleCandidate[] = [];
  const used = new Set<string>();
  for (const b of ranked) {
    if (kept.length >= t.bundlesPerDemand) break;
    if (b.offerIds.some((id) => used.has(id))) continue;
    kept.push(b);
    for (const id of b.offerIds) used.add(id);
  }
  return kept;
}

export type BundleRuleError =
  | 'bundle-too-large'
  | 'bundle-segment-not-allowed'
  | 'bundle-not-colocated'
  | 'bundle-mixed-deal-type'
  | 'bundle-area-insufficient';

/** Manual bundle (POST /v1/bundles) structural rules, in the LLD §6 order; hard filters are checked by the caller. */
export function manualBundleRuleError(
  d: DemandMx,
  offers: readonly OfferMx[],
  ctx: ScoringContext,
): BundleRuleError | null {
  if (offers.length < 2 || offers.length > ctx.weights.tuning.bundleMaxOffers) return 'bundle-too-large';
  if (!BUNDLE_SEGMENTS.includes(d.segment ?? '')) return 'bundle-segment-not-allowed';
  if (new Set(offers.map((o) => o.dealType)).size > 1) return 'bundle-mixed-deal-type';
  if (!groupingOf(offers, ctx.hierarchy)) return 'bundle-not-colocated';
  const sizes = offers.map((o) => offerAreaSize(o) ?? 0);
  if (d.areaSqftMin !== null && sizes.reduce((s, v) => s + v, 0) < d.areaSqftMin)
    return 'bundle-area-insufficient';
  return null;
}
