// Matching of one demand against a set of offers (LLD §4.5 RescoreSubject steps 2–3): hard filters → exclusions,
// scoring of survivors, bundle search; and the evaluation map the lifecycle merge consumes.
import type { BundleCandidate, BundleMember } from './bundles.js';
import { findBundles, offerSetKeyOf, scoreBundle } from './bundles.js';
import { evaluateHardFilters } from './filters.js';
import type { FilterOutcome } from './filters.js';
import type { MatchState, PairEval } from './lifecycle.js';
import { offerCloseCause } from './lifecycle.js';
import type { PairScore, ScoringContext } from './scoring.js';
import { scorePair } from './scoring.js';
import type { BundleGrouping, DemandMx, ExclusionReason, FilterCheck, IsoDate, OfferMx } from './types.js';

export interface ExclusionPlan {
  offerId: string;
  reason: ExclusionReason;
  availableFrom: IsoDate | null;
  moveInBy: IsoDate | null;
  detail: string;
}

export interface SingleResult {
  offer: OfferMx;
  filter: FilterOutcome;
  pair?: PairScore;
  eval: PairEval;
}

export interface DemandRunResult {
  singles: Map<string, SingleResult>;
  bundles: BundleCandidate[];
  evaluations: Map<string, PairEval>;
  exclusions: ExclusionPlan[];
}

/** Maximum exclusion rows kept per demand (LLD §4.1). */
export const MAX_EXCLUSIONS = 50;

/** Filters and scores one pair; the lifecycle evaluation of the single-offer set. */
export function evaluateSingle(o: OfferMx, d: DemandMx, ctx: ScoringContext): SingleResult {
  const filter = evaluateHardFilters(o, d, { requireAcceptsNew: true });
  if (filter.kind === 'skip')
    return { offer: o, filter, eval: { kind: 'fail', closeCause: offerCloseCause(o) } };
  if (filter.kind === 'exclude' && filter.reason !== 'demand_stale')
    return { offer: o, filter, eval: { kind: 'fail', closeCause: offerCloseCause(o) } };
  // pass, or demand_stale (existing matches of a Stale demand are still re-scored; no new ones are created)
  const flags =
    filter.kind === 'pass'
      ? filter.flags
      : o.dealType === 'Sale' && !o.market
        ? (['market_unknown'] as const)
        : [];
  const pair = scorePair(o, d, ctx, flags);
  return {
    offer: o,
    filter,
    pair,
    eval: {
      kind: 'pass',
      score: pair.score,
      factors: pair.factors,
      flags: pair.flags,
      suggestible: pair.score >= ctx.weights.tuning.minScore && !pair.areaOutOfRange,
      factsVersion: o.factsVersion,
    },
  };
}

function exclusionOf(r: SingleResult, d: DemandMx): ExclusionPlan | null {
  if (r.filter.kind !== 'exclude') return null;
  const last = r.filter.checks[r.filter.checks.length - 1] as FilterCheck;
  return {
    offerId: r.offer.id,
    reason: r.filter.reason,
    availableFrom: r.filter.availableFrom,
    moveInBy: d.moveInBy,
    detail: (last.detail ?? r.filter.reason).slice(0, 200),
  };
}

/** Existing bundle matches are re-validated with their members' current evaluations. */
export function evaluateExistingBundle(
  m: Pick<MatchState, 'offerIds'>,
  grouping: BundleGrouping,
  singles: ReadonlyMap<string, SingleResult>,
  d: DemandMx,
  ctx: ScoringContext,
): PairEval {
  const members: BundleMember[] = [];
  for (const id of m.offerIds) {
    const s = singles.get(id);
    if (!s) return { kind: 'fail', closeCause: null };
    if (!s.pair) return { kind: 'fail', closeCause: s.eval.kind === 'fail' ? s.eval.closeCause : null };
    members.push({ offer: s.offer, pair: s.pair });
  }
  const b = scoreBundle(members, grouping, d, ctx);
  if (!b) return { kind: 'fail', closeCause: null };
  return {
    kind: 'pass',
    score: b.score,
    factors: b.factors,
    flags: b.flags,
    suggestible: b.score >= ctx.weights.tuning.minScore,
    factsVersion: Math.max(...members.map((x) => x.offer.factsVersion)),
  };
}

/**
 * Demand-side run: `offers` = candidates (live and Expired/Inactive ones for exclusions) plus the offers of the
 * demand's existing matches. `existingBundles` = the demand's bundle matches with their grouping.
 */
export function runDemand(
  d: DemandMx,
  offers: readonly OfferMx[],
  existingBundles: readonly {
    match: Pick<MatchState, 'offerIds' | 'offerSetKey'>;
    grouping: BundleGrouping;
  }[],
  ctx: ScoringContext,
  existingKeys: ReadonlySet<string> = new Set(),
): DemandRunResult {
  const singles = new Map<string, SingleResult>();
  const evaluations = new Map<string, PairEval>();
  const exclusions: ExclusionPlan[] = [];
  for (const o of offers) {
    if (singles.has(o.id)) continue;
    const r = evaluateSingle(o, d, ctx);
    singles.set(o.id, r);
    evaluations.set(offerSetKeyOf([o.id]), r.eval);
    const ex = exclusionOf(r, d);
    // A Stale demand keeps its matches: demand_stale is recorded only for pairs it has no match for yet.
    if (ex && !(ex.reason === 'demand_stale' && existingKeys.has(offerSetKeyOf([o.id])))) exclusions.push(ex);
  }
  // Bundle members: offers passing filters 1–9 (area ignored) that are live.
  const members: BundleMember[] = [];
  for (const r of singles.values())
    if (r.filter.kind === 'pass' && r.pair) members.push({ offer: r.offer, pair: r.pair });
  const bundles = findBundles(d, members, ctx);
  for (const b of bundles)
    evaluations.set(b.offerSetKey, {
      kind: 'pass',
      score: b.score,
      factors: b.factors,
      flags: b.flags,
      suggestible: b.score >= ctx.weights.tuning.minScore,
      factsVersion: Math.max(...b.offerIds.map((id) => singles.get(id)?.offer.factsVersion ?? 0)),
    });
  for (const eb of existingBundles)
    if (!evaluations.has(eb.match.offerSetKey))
      evaluations.set(eb.match.offerSetKey, evaluateExistingBundle(eb.match, eb.grouping, singles, d, ctx));
  exclusions.sort((a, b) => (a.offerId < b.offerId ? -1 : 1));
  return { singles, bundles, evaluations, exclusions: exclusions.slice(0, MAX_EXCLUSIONS) };
}
