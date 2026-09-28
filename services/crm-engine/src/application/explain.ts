// GET /v1/matches/{idOrCode}/explanation (US-28 "score and factor breakdown", R-CHAT-2): recomputed on read from the
// current projection with the weights version the match was scored with.
import { scoreBundle } from '../domain/bundles.js';
import type { BundleMember } from '../domain/bundles.js';
import { evaluateHardFilters } from '../domain/filters.js';
import { istDate } from '../domain/dates.js';
import { scorePair } from '../domain/scoring.js';
import type {
  BundleGrouping,
  FactorResult,
  FilterCheck,
  HardFilterName,
  MatchFlag,
} from '../domain/types.js';
import { DEFAULT_WEIGHTS } from '../domain/weights.js';
import type { Weights } from '../domain/weights.js';
import { notFoundError } from './errors.js';
import type { Clock, Store } from './ports.js';

export interface Explanation {
  matchId: string;
  code: string;
  score: number;
  weightsVersion: number;
  hardFilters: { filter: HardFilterName; passed: boolean; detail?: string }[];
  factors: FactorResult[];
  flags: { flag: MatchFlag; detail?: string }[];
  bundle: {
    grouping: BundleGrouping;
    combinedAreaSqft: number;
    combinedPriceInr: number | null;
    combinedRentMonthlyInr: number | null;
  } | null;
  computedAt: string;
}

const FLAG_DETAIL: Record<MatchFlag, string> = {
  price_above_budget: "the offer's price is above the demand's budget",
  reconfirm: 'an offer is Stale: reconfirm availability before proposing',
  area_basis_unknown: 'area basis unknown: compared with a ±25% tolerance, no conversion',
  market_unknown: 'the offer market (Primary / Secondary) is unknown',
};

/** One check per filter name: passed when every offer passed it; the first failing offer's detail. */
function mergeChecks(
  perOffer: { code: string; checks: FilterCheck[] }[],
  bundle: boolean,
): Explanation['hardFilters'] {
  const order: HardFilterName[] = [];
  const merged = new Map<HardFilterName, { passed: boolean; detail?: string }>();
  for (const { code, checks } of perOffer)
    for (const c of checks) {
      if (!merged.has(c.filter)) order.push(c.filter);
      const prev = merged.get(c.filter);
      const detail = c.detail ? (bundle ? `${code}: ${c.detail}` : c.detail).slice(0, 200) : undefined;
      if (!prev) merged.set(c.filter, { passed: c.passed, ...(detail ? { detail } : {}) });
      else if (prev.passed && !c.passed)
        merged.set(c.filter, { passed: false, ...(detail ? { detail } : {}) });
    }
  return order
    .slice(0, 12)
    .map((f) => ({ filter: f, ...(merged.get(f) as { passed: boolean; detail?: string }) }));
}

export async function explainMatch(
  store: Store,
  clock: Clock,
  tenantId: string,
  idOrCode: string,
): Promise<Explanation> {
  const m = await store.matches.get(tenantId, idOrCode);
  if (!m) throw notFoundError('match');
  const stored = await store.weights.version(tenantId, m.weightsVersion);
  const weights: Weights = stored
    ? { version: stored.version, factors: stored.factors, tuning: stored.tuning }
    : DEFAULT_WEIGHTS;
  const now = clock.now();
  const d = await store.mx.getDemand(tenantId, m.demandId);
  const offers = await store.mx.getOffers(tenantId, m.offerIds);
  const base = {
    matchId: m.id,
    code: m.code,
    weightsVersion: m.weightsVersion,
    computedAt: now.toISOString(),
  };
  if (!d || offers.length !== m.offerIds.length) {
    // subject merged or purged: the stored breakdown is the best explanation left
    return {
      ...base,
      score: m.score,
      hardFilters: [],
      factors: m.factors,
      flags: m.flags.map((f) => ({ flag: f, detail: FLAG_DETAIL[f] })),
      bundle: null,
    };
  }
  const ctx = { hierarchy: await store.hierarchy.load(tenantId), weights, today: istDate(now) };
  const ordered = m.offerIds.map((id) => offers.find((o) => o.id === id) as (typeof offers)[number]);
  const filters = ordered.map((o) => ({ offer: o, result: evaluateHardFilters(o, d) }));
  const hardFilters = mergeChecks(
    filters.map((f) => ({ code: f.offer.code, checks: f.result.checks })),
    m.isBundle,
  );
  const marketFlags = (o: (typeof ordered)[number]): MatchFlag[] =>
    o.dealType === 'Sale' && !o.market ? ['market_unknown'] : [];

  if (m.isBundle && m.bundleId) {
    const b = await store.bundles.get(tenantId, m.bundleId);
    if (b) {
      const members: BundleMember[] = ordered.map((o) => ({
        offer: o,
        pair: scorePair(o, d, ctx, marketFlags(o)),
      }));
      const scored = scoreBundle(members, b.grouping, d, ctx, false);
      if (scored)
        return {
          ...base,
          score: scored.score,
          hardFilters,
          factors: scored.factors,
          flags: scored.flags.map((f) => ({ flag: f, detail: FLAG_DETAIL[f] })),
          bundle: {
            grouping: b.grouping,
            combinedAreaSqft: scored.combinedAreaSqft,
            combinedPriceInr: scored.combinedPriceInr,
            combinedRentMonthlyInr: scored.combinedRentMonthlyInr,
          },
        };
    }
  }
  const o = ordered[0] as (typeof ordered)[number];
  const pair = scorePair(o, d, ctx, marketFlags(o));
  const priceNote = pair.factors.find((f) => f.factor === 'price')?.note;
  return {
    ...base,
    score: pair.score,
    hardFilters,
    factors: pair.factors,
    flags: pair.flags.map((f) => ({
      flag: f,
      detail: f === 'price_above_budget' && priceNote ? priceNote : FLAG_DETAIL[f],
    })),
    bundle: null,
  };
}
