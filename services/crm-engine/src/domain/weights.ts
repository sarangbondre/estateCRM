// Match weights and tunables (LLD §4.2, contract schema Weights). Versioned; Admin-editable (PUT /v1/weights).
import type { FactorName } from './types.js';

export interface Tuning {
  minScore: number;
  topNPerDemand: number;
  areaTolerancePct: number;
  areaToleranceUnknownBasisPct: number;
  priceOverBudgetZeroPct: number;
  timingSoonDays: number;
  bundleMaxOffers: number;
  bundleCandidateCap: number;
  bundlesPerDemand: number;
  rejectedResuggestMinGain: number;
  proximity: { sameLocality: number; sameMicromarket: number; coarserLevel: number };
}

export interface WeightsBody {
  factors: Record<FactorName, number>;
  tuning: Tuning;
}

export interface Weights extends WeightsBody {
  version: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  version: 0,
  factors: { micromarket: 0.25, price: 0.25, area: 0.2, bhk: 0.1, timing: 0.1, furnishing: 0.1 },
  tuning: {
    minScore: 40,
    topNPerDemand: 20,
    areaTolerancePct: 15,
    areaToleranceUnknownBasisPct: 25,
    priceOverBudgetZeroPct: 20,
    timingSoonDays: 30,
    bundleMaxOffers: 3,
    bundleCandidateCap: 30,
    bundlesPerDemand: 3,
    rejectedResuggestMinGain: 10,
    proximity: { sameLocality: 1, sameMicromarket: 0.85, coarserLevel: 0.6 },
  },
};

type Range = [min: number, max: number, integer?: boolean];
const TUNING_RANGES: Record<Exclude<keyof Tuning, 'proximity'>, Range> = {
  minScore: [0, 100, true],
  topNPerDemand: [1, 50, true],
  areaTolerancePct: [0, 100],
  areaToleranceUnknownBasisPct: [0, 100],
  priceOverBudgetZeroPct: [1, 100],
  timingSoonDays: [0, 365, true],
  bundleMaxOffers: [2, 3, true],
  bundleCandidateCap: [5, 60, true],
  bundlesPerDemand: [0, 10, true],
  rejectedResuggestMinGain: [0, 100, true],
};

export interface WeightsProblem {
  field: string;
  code: string;
}

/** `weights-invalid` (LLD §6): all factor weights zero, or a tunable out of range. */
export function validateWeights(body: WeightsBody): WeightsProblem[] {
  const problems: WeightsProblem[] = [];
  const values = Object.entries(body.factors);
  for (const [k, v] of values)
    if (!(v >= 0 && v <= 1)) problems.push({ field: `factors.${k}`, code: 'out-of-range' });
  if (values.every(([, v]) => v === 0)) problems.push({ field: 'factors', code: 'all-zero' });
  for (const [k, [min, max, int]] of Object.entries(TUNING_RANGES)) {
    const v = body.tuning[k as keyof typeof TUNING_RANGES];
    if (typeof v !== 'number' || !(v >= min && v <= max) || (int && !Number.isInteger(v)))
      problems.push({ field: `tuning.${k}`, code: 'out-of-range' });
  }
  for (const [k, v] of Object.entries(body.tuning.proximity))
    if (!(v >= 0 && v <= 1)) problems.push({ field: `tuning.proximity.${k}`, code: 'out-of-range' });
  return problems;
}

/** Fills tunables a client omitted with the defaults (the contract marks them with defaults). */
export function withDefaults(body: {
  factors: Record<FactorName, number>;
  tuning: Partial<Omit<Tuning, 'proximity'>> & { proximity?: Partial<Tuning['proximity']> };
}): WeightsBody {
  const d = DEFAULT_WEIGHTS.tuning;
  return {
    factors: { ...body.factors },
    tuning: {
      ...d,
      ...Object.fromEntries(
        Object.entries(body.tuning).filter(([k, v]) => k !== 'proximity' && v !== undefined),
      ),
      proximity: { ...d.proximity, ...(body.tuning.proximity ?? {}) },
    } as Tuning,
  };
}
