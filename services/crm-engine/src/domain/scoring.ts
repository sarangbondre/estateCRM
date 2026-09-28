// Scoring (LLD §4.2) and flags (LLD §4.4): score = round(100 × Σ w·v / Σ w) over applicable factors, v ∈ [0, 1].
import { addDays, availabilityPeriod, maxDate } from './dates.js';
import type { Hierarchy } from './micromarket.js';
import { proximity } from './micromarket.js';
import { budgetMaxFor, budgetMinFor, isSalePriced, priceKeyOf } from './matchable.js';
import { statedTag } from './filters.js';
import type { DemandMx, FactorName, FactorResult, IsoDate, MatchFlag, OfferMx } from './types.js';
import { FACTORS } from './types.js';
import type { Weights } from './weights.js';

export interface ScoringContext {
  hierarchy: Hierarchy;
  weights: Weights;
  /** Today's IST date. */
  today: IsoDate;
}

interface FactorValue {
  applicable: boolean;
  value: number;
  note?: string;
}

const NA: FactorValue = { applicable: false, value: 0 };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** ₹ in lakhs / crores, e.g. 850000 → '₹8.5L', 24000000 → '₹2.4Cr'. */
export function formatInr(v: number): string {
  if (v >= 1e7) return `₹${round2(v / 1e7)}Cr`;
  if (v >= 1e5) return `₹${round2(v / 1e5)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

const rangeText = (min: number | null, max: number | null, fmt: (v: number) => string) =>
  min !== null && max !== null && min !== max ? `${fmt(min)}–${fmt(max)}` : fmt((max ?? min) as number);

// --- micromarket ------------------------------------------------------------------------------------------------------
export function micromarketFactor(o: OfferMx, d: DemandMx, ctx: ScoringContext): FactorValue {
  const p = proximity(ctx.hierarchy, o.mmPath, d);
  const prox = ctx.weights.tuning.proximity;
  const place = o.locality ?? o.micromarket ?? 'area';
  switch (p) {
    case 'sameLocality':
      return { applicable: true, value: prox.sameLocality, note: `${place}: same locality` };
    case 'sameMicromarket':
      return { applicable: true, value: prox.sameMicromarket, note: `${place}: same micromarket` };
    case 'coarserLevel':
      return { applicable: true, value: prox.coarserLevel, note: `${place}: overlap at a coarser level` };
    default:
      return { applicable: true, value: 0, note: `${place}: outside the demand's area` };
  }
}

// --- price -----------------------------------------------------------------------------------------------------------
/** Price value for an offer price p against budget max b (price is scored, never a hard filter: JB-3). */
export function priceValue(p: number | null, b: number, zeroPct: number): number {
  if (p === null) return 0.5;
  if (p <= b) return 1;
  return clamp01(1 - (p - b) / b / (zeroPct / 100));
}

export function priceFactor(
  price: number | null,
  dealType: string,
  d: DemandMx,
  ctx: ScoringContext,
): FactorValue & { aboveBudget: boolean } {
  const b = budgetMaxFor(d, dealType);
  if (b === null || b <= 0) return { ...NA, aboveBudget: false };
  const bMin = budgetMinFor(d, dealType);
  const what = isSalePriced(dealType) ? 'price' : 'rent';
  const note =
    price === null
      ? `${what} unknown vs budget ${rangeText(bMin, b, formatInr)}`
      : `${what} ${formatInr(price)} vs budget ${rangeText(bMin, b, formatInr)}`;
  return {
    applicable: true,
    value: priceValue(price, b, ctx.weights.tuning.priceOverBudgetZeroPct),
    note,
    aboveBudget: price !== null && price > b,
  };
}

// --- area ------------------------------------------------------------------------------------------------------------
export interface AreaRange {
  min: number;
  max: number;
}

/** The offer's area range, like with like: Land uses land_area_sqft, others area_sqft_min/max. */
export function offerAreaRange(
  o: Pick<OfferMx, 'segment' | 'landAreaSqft' | 'areaSqftMin' | 'areaSqftMax'>,
): AreaRange | null {
  if (o.segment === 'Land')
    return o.landAreaSqft !== null ? { min: o.landAreaSqft, max: o.landAreaSqft } : null;
  const min = o.areaSqftMin ?? o.areaSqftMax;
  const max = o.areaSqftMax ?? o.areaSqftMin;
  return min === null || max === null ? null : { min: Math.min(min, max), max: Math.max(min, max) };
}

/** The largest area an offer can contribute (bundles sum it). */
export function offerAreaSize(o: Parameters<typeof offerAreaRange>[0]): number | null {
  return offerAreaRange(o)?.max ?? null;
}

/**
 * Area value (LLD §4.2): ranges overlap → 1.0; else max(0, 1 − gap / (tol × nearest demand bound)).
 * tol = areaTolerancePct when both bases are known and equal; areaToleranceUnknownBasisPct when a basis is blank
 * (flag area_basis_unknown, R-14) or the bases differ (JB-2, no flag). No conversion between bases.
 */
export function areaValue(
  offer: AreaRange,
  dMin: number | null,
  dMax: number | null,
  tolPct: number,
): number {
  const lo = dMin ?? 0;
  const hi = dMax ?? Number.POSITIVE_INFINITY;
  if (offer.max >= lo && offer.min <= hi) return 1;
  const tol = tolPct / 100;
  if (offer.min > hi) {
    const gap = offer.min - hi;
    return tol === 0 ? 0 : clamp01(1 - gap / (tol * hi));
  }
  const gap = lo - offer.max;
  return tol === 0 || lo === 0 ? 0 : clamp01(1 - gap / (tol * lo));
}

export function areaFactor(
  offerRange: AreaRange | null,
  offerBasis: OfferMx['areaBasis'],
  isLand: boolean,
  d: DemandMx,
  ctx: ScoringContext,
): FactorValue & { basisUnknown: boolean } {
  if (!offerRange || (d.areaSqftMin === null && d.areaSqftMax === null))
    return { ...NA, basisUnknown: false };
  const t = ctx.weights.tuning;
  const basisUnknown = !isLand && (offerBasis === null || d.areaBasis === null);
  const sameBasis = isLand || (!basisUnknown && offerBasis === d.areaBasis);
  const tolPct = sameBasis ? t.areaTolerancePct : t.areaToleranceUnknownBasisPct;
  const value = areaValue(offerRange, d.areaSqftMin, d.areaSqftMax, tolPct);
  const fmt = (v: number) => `${Math.round(v).toLocaleString('en-IN')} sq ft`;
  const basis = (b: string | null) => (isLand ? 'land' : (b ?? 'basis unknown'));
  return {
    applicable: true,
    value,
    basisUnknown,
    note: `${rangeText(offerRange.min, offerRange.max, fmt)} ${basis(offerBasis)} vs ${rangeText(d.areaSqftMin, d.areaSqftMax, fmt)} ${basis(d.areaBasis)} (±${tolPct}%)`,
  };
}

// --- bhk -------------------------------------------------------------------------------------------------------------
export function bhkFactor(o: OfferMx, d: DemandMx): FactorValue {
  if (d.segment !== 'Residential') return NA;
  const oMin = o.bhkMin ?? o.bhkMax;
  const oMax = o.bhkMax ?? o.bhkMin;
  const dMin = d.bhkMin ?? d.bhkMax;
  const dMax = d.bhkMax ?? d.bhkMin;
  if (oMin === null || oMax === null || dMin === null || dMax === null) return NA;
  const gap = oMax < dMin ? dMin - oMax : oMin > dMax ? oMin - dMax : 0;
  const value = gap === 0 ? 1 : gap <= 0.5 ? 0.6 : gap <= 1 ? 0.3 : 0;
  return {
    applicable: true,
    value,
    note: `${rangeText(oMin, oMax, String)} BHK vs ${rangeText(dMin, dMax, String)} BHK`,
  };
}

// --- timing ----------------------------------------------------------------------------------------------------------
/**
 * Timing (LLD §4.2): available (period end, or today if Ready/blank) ≤ move_in_by − timingSoonDays → 1.0;
 * ≤ move_in_by → 0.7; available earlier than move_in_from − 90 days → × 0.8. An offer whose month straddles
 * move_in_by (period start ≤ move_in_by < period end) passes filter 9 and scores 0.4 (assumption, see README).
 */
export function timingFactor(
  o: Pick<OfferMx, 'possessionDateRaw' | 'possessionStatus'>,
  d: DemandMx,
  ctx: ScoringContext,
): FactorValue {
  if (!d.moveInBy) return NA;
  const period = availabilityPeriod(o.possessionDateRaw, o.possessionStatus);
  const available = period ? maxDate(period.to, ctx.today) : ctx.today;
  let value: number;
  if (available <= addDays(d.moveInBy, -ctx.weights.tuning.timingSoonDays)) value = 1;
  else if (available <= d.moveInBy) value = 0.7;
  else value = 0.4;
  if (d.moveInFrom && available < addDays(d.moveInFrom, -90)) value *= 0.8;
  return {
    applicable: true,
    value: round2(value),
    note: `available ${period ? `from ${period.from}` : 'now'} vs needed by ${d.moveInBy}`,
  };
}

// --- furnishing and must-haves -----------------------------------------------------------------------------------------
const FURNISHING_ORDER = ['Furnished', 'Semi Furnished', 'Unfurnished', 'Bare Shell'];

export function furnishingValue(stated: string, offered: string | null): number {
  if (!offered) return 0.5;
  const a = FURNISHING_ORDER.findIndex((f) => f.toLowerCase() === stated.trim().toLowerCase());
  const b = FURNISHING_ORDER.findIndex((f) => f.toLowerCase() === offered.trim().toLowerCase());
  if (a < 0 || b < 0) return stated.trim().toLowerCase() === offered.trim().toLowerCase() ? 1 : 0.2;
  const diff = Math.abs(a - b);
  return diff === 0 ? 1 : diff === 1 ? 0.5 : 0.2;
}

/** Must-have keys inside statedTags (C-10 default): `parking` (minimum count) and `amenity:<name>`. */
export function mustHaves(tags: Readonly<Record<string, string>>): {
  parking: number | null;
  amenities: string[];
} {
  const p = statedTag(tags, 'parking');
  const parking = p !== undefined && /^\d+$/.test(p.trim()) ? Number(p.trim()) : null;
  const amenities = Object.entries(tags)
    .filter(([k, v]) => /^amenity:/i.test(k.trim()) && !/^(false|no|0)$/i.test(v.trim()))
    .map(([k]) => k.trim().slice('amenity:'.length).trim())
    .filter((a) => a.length > 0);
  return { parking, amenities };
}

export function furnishingFactor(
  o: Pick<OfferMx, 'furnishing' | 'parking' | 'amenities'>,
  d: DemandMx,
): FactorValue {
  const stated = statedTag(d.statedTags, 'furnishing');
  const must = mustHaves(d.statedTags);
  const parts: number[] = [];
  const notes: string[] = [];
  if (stated !== undefined) {
    parts.push(furnishingValue(stated, o.furnishing));
    notes.push(`${o.furnishing ?? 'furnishing unknown'} vs ${stated}`);
  }
  if (must.parking !== null) {
    parts.push(o.parking === null ? 0.5 : o.parking >= must.parking ? 1 : 0);
    notes.push(`parking ${o.parking ?? '?'} vs ${must.parking}`);
  }
  for (const a of must.amenities) {
    const have = o.amenities.map((x) => x.toLowerCase());
    parts.push(have.length === 0 ? 0.5 : have.includes(a.toLowerCase()) ? 1 : 0);
    notes.push(`${a} ${have.length === 0 ? 'unknown' : have.includes(a.toLowerCase()) ? 'yes' : 'no'}`);
  }
  if (!parts.length) return NA;
  return {
    applicable: true,
    value: round2(parts.reduce((s, v) => s + v, 0) / parts.length),
    note: notes.join('; ').slice(0, 200),
  };
}

// --- combine ---------------------------------------------------------------------------------------------------------
export function combine(
  values: Record<FactorName, FactorValue>,
  weights: Weights,
): { score: number; factors: FactorResult[] } {
  const applicable = FACTORS.filter((f) => values[f].applicable);
  const sumW = applicable.reduce((s, f) => s + weights.factors[f], 0);
  let raw: number;
  if (sumW > 0) raw = (100 * applicable.reduce((s, f) => s + weights.factors[f] * values[f].value, 0)) / sumW;
  else
    raw = applicable.length
      ? (100 * applicable.reduce((s, f) => s + values[f].value, 0)) / applicable.length
      : 0;
  const factors = FACTORS.map((f): FactorResult => {
    const v = values[f];
    const w = weights.factors[f];
    const points = v.applicable && sumW > 0 ? (100 * w * v.value) / sumW : 0;
    return {
      factor: f,
      weight: w,
      value: round2(clamp01(v.value)),
      points: round2(points),
      applicable: v.applicable,
      ...(v.note ? { note: v.note.slice(0, 200) } : {}),
    };
  });
  return { score: Math.max(0, Math.min(100, Math.round(raw))), factors };
}

export interface PairScore {
  score: number;
  factors: FactorResult[];
  flags: MatchFlag[];
  /** Area applicable and beyond tolerance (value 0): not suggested as a single match (see README assumptions). */
  areaOutOfRange: boolean;
  /** Per-factor values, for bundle averaging. */
  values: Record<FactorName, FactorValue>;
}

/** Scores one (offer, demand) pair that passed the hard filters. `filterFlags` come from filter 5 (market_unknown). */
export function scorePair(
  o: OfferMx,
  d: DemandMx,
  ctx: ScoringContext,
  filterFlags: readonly MatchFlag[] = [],
): PairScore {
  const price = priceFactor(priceKeyOf(o), o.dealType, d, ctx);
  const area = areaFactor(offerAreaRange(o), o.areaBasis, o.segment === 'Land', d, ctx);
  const values: Record<FactorName, FactorValue> = {
    micromarket: micromarketFactor(o, d, ctx),
    price,
    area,
    bhk: bhkFactor(o, d),
    timing: timingFactor(o, d, ctx),
    furnishing: furnishingFactor(o, d),
  };
  const { score, factors } = combine(values, ctx.weights);
  const flags = new Set<MatchFlag>(filterFlags);
  if (price.aboveBudget) flags.add('price_above_budget');
  if (area.applicable && area.basisUnknown) flags.add('area_basis_unknown');
  if (o.lifeStage === 'Stale') flags.add('reconfirm');
  return {
    score,
    factors,
    flags: sortFlags([...flags]),
    areaOutOfRange: area.applicable && area.value === 0,
    values,
  };
}

const FLAG_ORDER: MatchFlag[] = ['price_above_budget', 'reconfirm', 'area_basis_unknown', 'market_unknown'];
export const sortFlags = (flags: readonly MatchFlag[]): MatchFlag[] =>
  FLAG_ORDER.filter((f) => flags.includes(f));
