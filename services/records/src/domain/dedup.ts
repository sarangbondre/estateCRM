// Duplicate detection (records LLD §4.4 and §4.5, BRD dedup rules, US-07/US-08). Pure scoring over candidates that
// the repositories fetch through the dedup indexes. Thresholds are initial values (Q-R2).

export const PROPERTY_THRESHOLDS = { same: 0.85, uncertain: 0.6 } as const;
export const DEMAND_THRESHOLDS = { touch: 0.8, uncertain: 0.5 } as const;

export type PropertyReason = 'building' | 'floor' | 'area' | 'locality' | 'bhk' | 'price' | 'phone';

export interface PropertyFacts {
  id?: string;
  segment: string | null;
  propertyTypes: readonly string[];
  buildingNorm: string | null;
  micromarketId: string | null;
  localityNorm: string | null;
  floorNo: number | null;
  areaSqftMin: number | null;
  areaSqftMax: number | null;
  areaBasis: string | null;
  bhkMin: number | null;
  bhkMax: number | null;
  /** Asking price per deal type (sale price, or monthly rent for Lease). */
  prices: Readonly<Record<string, number | null>>;
  /** phone_hash of the parties. */
  phoneHashes: readonly string[];
}

export interface PropertyScore {
  score: number;
  reasons: PropertyReason[];
  buildingMatched: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function overlapWithin(
  aMin: number | null,
  aMax: number | null,
  bMin: number | null,
  bMax: number | null,
  tolerance: number,
): boolean {
  const a0 = aMin ?? aMax;
  const a1 = aMax ?? aMin;
  const b0 = bMin ?? bMax;
  const b1 = bMax ?? bMin;
  if (a0 === null || a1 === null || b0 === null || b1 === null) return false;
  // Ranges [a0,a1] and [b0,b1] overlap once each is widened by the tolerance.
  return a0 <= b1 * (1 + tolerance) && b0 <= a1 * (1 + tolerance);
}

function listsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.includes(x));
}

/** Score of `input` against `candidate`, or null when they cannot be the same property (segment / type rule). */
export function scoreProperty(input: PropertyFacts, candidate: PropertyFacts): PropertyScore | null {
  if ((input.segment ?? null) !== (candidate.segment ?? null)) return null;
  if (input.propertyTypes.length && candidate.propertyTypes.length && !listsOverlap(input.propertyTypes, candidate.propertyTypes)) {
    return null;
  }
  let score = 0;
  const reasons: PropertyReason[] = [];
  const buildingMatched =
    input.buildingNorm !== null && candidate.buildingNorm !== null && input.buildingNorm === candidate.buildingNorm;
  if (buildingMatched) {
    score += 0.4;
    reasons.push('building');
  }
  const sameArea =
    input.micromarketId !== null || candidate.micromarketId !== null
      ? input.micromarketId !== null && input.micromarketId === candidate.micromarketId
      : input.localityNorm !== null && input.localityNorm === candidate.localityNorm;
  if (sameArea) {
    score += 0.1;
    reasons.push('locality');
  }
  if (input.floorNo !== null && candidate.floorNo !== null && input.floorNo === candidate.floorNo) {
    score += 0.15;
    reasons.push('floor');
  }
  const basisKnown = input.areaBasis !== null && candidate.areaBasis !== null;
  if (!basisKnown || input.areaBasis === candidate.areaBasis) {
    const tolerance = basisKnown ? 0.05 : 0.1;
    if (overlapWithin(input.areaSqftMin, input.areaSqftMax, candidate.areaSqftMin, candidate.areaSqftMax, tolerance)) {
      score += 0.2;
      reasons.push('area');
    }
  }
  if (
    input.bhkMin !== null &&
    candidate.bhkMin !== null &&
    input.bhkMin === candidate.bhkMin &&
    (input.bhkMax ?? input.bhkMin) === (candidate.bhkMax ?? candidate.bhkMin)
  ) {
    score += 0.05;
    reasons.push('bhk');
  }
  const priceMatch = Object.entries(input.prices).some(([dealType, p]) => {
    const q = candidate.prices[dealType];
    return p !== null && q !== null && q !== undefined && p > 0 && Math.abs(p - q) / Math.max(p, q) <= 0.05;
  });
  if (priceMatch) {
    score += 0.05;
    reasons.push('price');
  }
  // A shared phone is supporting evidence only: it never decides alone (counted only when ≥ 0.50 without it).
  if (score >= 0.5 && listsOverlap(input.phoneHashes, candidate.phoneHashes)) {
    score += 0.05;
    reasons.push('phone');
  }
  return { score: round3(score), reasons, buildingMatched };
}

export type PropertyDecision = 'new' | 'same_property' | 'uncertain';

export function propertyDecision(s: PropertyScore | null): PropertyDecision {
  if (!s) return 'new';
  if (s.score >= PROPERTY_THRESHOLDS.same && s.buildingMatched) return 'same_property';
  if (s.score >= PROPERTY_THRESHOLDS.uncertain) return 'uncertain';
  return 'new';
}

/** Best candidates first; only those ≥ the uncertain threshold matter to callers. */
export function rankProperties<T extends PropertyFacts>(
  input: PropertyFacts,
  candidates: readonly T[],
): { candidate: T; score: PropertyScore; decision: PropertyDecision }[] {
  return candidates
    .map((candidate) => {
      const score = scoreProperty(input, candidate);
      return score ? { candidate, score, decision: propertyDecision(score) } : null;
    })
    .filter((x): x is { candidate: T; score: PropertyScore; decision: PropertyDecision } => x !== null)
    .sort((a, b) => b.score.score - a.score.score);
}

// --- demands --------------------------------------------------------------------------------------------------

export interface DemandFacts {
  segment: string | null;
  dealTypes: readonly string[];
  propertyTypes: readonly string[];
  /** micromarket ids and normalised localities together. */
  places: readonly string[];
  budgetMin: number | null;
  budgetMax: number | null;
  rentMin: number | null;
  rentMax: number | null;
  areaMin: number | null;
  areaMax: number | null;
  bhkMin: number | null;
  bhkMax: number | null;
}

const blank = (a: number | null, b: number | null) => a === null && b === null;

/**
 * DemandMatcher (LLD §4.5): segment equal (required); deal_types 0.25, property_types 0.20, places 0.20, budget/rent
 * ±20% 0.15, area ±20% 0.15, bhk 0.05. A dimension stated on neither side does not contradict and scores in full;
 * stated on one side only scores half (assumption; thresholds are tunable, Q-R2).
 */
export function scoreDemand(input: DemandFacts, candidate: DemandFacts): number | null {
  if ((input.segment ?? null) !== (candidate.segment ?? null)) return null;
  let score = 0;
  const list = (a: readonly string[], b: readonly string[], w: number) => {
    if (!a.length && !b.length) return w;
    if (!a.length || !b.length) return w / 2;
    return listsOverlap(a, b) ? w : 0;
  };
  const range = (
    aMin: number | null,
    aMax: number | null,
    bMin: number | null,
    bMax: number | null,
    w: number,
    tol: number,
  ) => {
    if (blank(aMin, aMax) && blank(bMin, bMax)) return w;
    if (blank(aMin, aMax) || blank(bMin, bMax)) return w / 2;
    return overlapWithin(aMin, aMax, bMin, bMax, tol) ? w : 0;
  };
  score += list(input.dealTypes, candidate.dealTypes, 0.25);
  score += list(input.propertyTypes, candidate.propertyTypes, 0.2);
  score += list(input.places, candidate.places, 0.2);
  const money =
    blank(input.budgetMin, input.budgetMax) && blank(candidate.budgetMin, candidate.budgetMax)
      ? range(input.rentMin, input.rentMax, candidate.rentMin, candidate.rentMax, 0.15, 0.2)
      : range(input.budgetMin, input.budgetMax, candidate.budgetMin, candidate.budgetMax, 0.15, 0.2);
  score += money;
  score += range(input.areaMin, input.areaMax, candidate.areaMin, candidate.areaMax, 0.15, 0.2);
  if (!blank(input.bhkMin, input.bhkMax) && !blank(candidate.bhkMin, candidate.bhkMax)) {
    score += overlapWithin(input.bhkMin, input.bhkMax, candidate.bhkMin, candidate.bhkMax, 0) ? 0.05 : 0;
  } else {
    score += blank(input.bhkMin, input.bhkMax) && blank(candidate.bhkMin, candidate.bhkMax) ? 0.05 : 0.025;
  }
  return round3(score);
}

export type DemandDecision = 'touch' | 'new_with_candidate' | 'new';

/** phoneMatch: same person (by phone); company-only evidence needs ≥ 0.80 to become a candidate. */
export function demandDecision(score: number | null, evidence: 'phone' | 'company'): DemandDecision {
  if (score === null) return 'new';
  if (evidence === 'phone') {
    if (score >= DEMAND_THRESHOLDS.touch) return 'touch';
    if (score >= DEMAND_THRESHOLDS.uncertain) return 'new_with_candidate';
    return 'new';
  }
  return score >= DEMAND_THRESHOLDS.touch ? 'new_with_candidate' : 'new';
}
