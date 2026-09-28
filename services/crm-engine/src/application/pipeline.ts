// Re-scoring pipeline (LLD §4.5): RescoreSubject for a demand (candidates → filters → scores → bundles → merge →
// top-N → events) and for an offer (the offer against its candidate demands). Runs inside one transaction; every
// match change writes its event to the outbox in that transaction.
import { istDate } from '../domain/dates.js';
import { bundleEligible, offerSetKeyOf } from '../domain/bundles.js';
import type { BundleCandidate } from '../domain/bundles.js';
import { MAX_EXCLUSIONS, evaluateSingle, runDemand } from '../domain/engine.js';
import type { ExclusionPlan } from '../domain/engine.js';
import { isOpen, planMerge } from '../domain/lifecycle.js';
import type { MatchEventIntent, MergePlan, NewMatchPlan, PairEval } from '../domain/lifecycle.js';
import { budgetMaxFor, demandIsMatchable, demandMatchKeys, offerMatchKeys } from '../domain/matchable.js';
import type { ScoringContext } from '../domain/scoring.js';
import { offerAreaSize } from '../domain/scoring.js';
import type { DemandMx } from '../domain/types.js';
import { DEFAULT_WEIGHTS } from '../domain/weights.js';
import type { Weights } from '../domain/weights.js';
import type {
  BundleRecord,
  Clock,
  DemandRecord,
  MatchRecord,
  OfferRecord,
  RunRecord,
  Store,
} from './ports.js';

/** Candidate query cap (LLD §4.5 step 2); price narrowing when hit. */
export const CANDIDATE_LIMIT = 5000;
/** Expired / Inactive offers read for exclusions per run. */
export const UNLIVE_LIMIT = 200;
/** Matches loaded per demand (all statuses). */
export const DEMAND_MATCH_LIMIT = 2000;
/** Matches loaded per offer. */
export const OFFER_MATCH_LIMIT = 2000;

const newId = () => globalThis.crypto.randomUUID();

export async function weightsFor(store: Store, tenantId: string): Promise<Weights> {
  const w = await store.weights.active(tenantId);
  return w ? { version: w.version, factors: w.factors, tuning: w.tuning } : DEFAULT_WEIGHTS;
}

export async function scoringContext(store: Store, clock: Clock, tenantId: string): Promise<ScoringContext> {
  return {
    hierarchy: await store.hierarchy.load(tenantId),
    weights: await weightsFor(store, tenantId),
    today: istDate(clock.now()),
  };
}

export interface RunStats {
  candidates: number;
  suggested: number;
  closed: number;
  excluded: number;
}

/** Applies a merge plan: inserts (with bundle rows for engine bundles), updates and their events. */
export async function applyPlan(
  store: Store,
  clock: Clock,
  demand: DemandMx,
  plan: MergePlan,
  originals: ReadonlyMap<string, MatchRecord>,
  weightsVersion: number,
  bundles: ReadonlyMap<string, BundleCandidate>,
): Promise<MatchRecord[]> {
  const now = clock.now();
  const byId = new Map<string, MatchRecord>();
  for (const u of plan.updates) {
    const orig = originals.get(u.id);
    if (!orig) continue;
    const saved = await store.matches.update({ ...orig, ...u, weightsVersion });
    byId.set(saved.id, saved);
  }
  for (const e of plan.events) await publishIntent(store, e, byId, originals);
  const inserted: MatchRecord[] = [];
  for (const ins of plan.inserts)
    inserted.push(
      await insertEngineMatch(store, demand, ins, weightsVersion, bundles.get(ins.offerSetKey), now),
    );
  return [...byId.values(), ...inserted];
}

async function insertEngineMatch(
  store: Store,
  demand: DemandMx,
  ins: NewMatchPlan,
  weightsVersion: number,
  bundle: BundleCandidate | undefined,
  now: Date,
): Promise<MatchRecord> {
  const offerIds = ins.offerSetKey.split(',');
  const matchId = newId();
  let bundleId: string | null = null;
  if (offerIds.length > 1 && bundle) {
    const b: BundleRecord = {
      id: newId(),
      tenantId: demand.tenantId,
      code: await store.matches.nextCode(demand.tenantId, 'BND'),
      demandId: demand.id,
      offerIds,
      grouping: bundle.grouping,
      combinedAreaSqft: bundle.combinedAreaSqft,
      combinedPriceInr: bundle.combinedPriceInr,
      combinedRentMonthlyInr: bundle.combinedRentMonthlyInr,
      origin: 'engine',
      createdBy: null,
      matchId,
      createdAt: now,
    };
    await store.bundles.insert(b);
    bundleId = b.id;
  }
  const m: MatchRecord = {
    id: matchId,
    tenantId: demand.tenantId,
    code: await store.matches.nextCode(demand.tenantId, 'MAT'),
    demandId: demand.id,
    offerIds,
    offerSetKey: ins.offerSetKey,
    isBundle: offerIds.length > 1,
    bundleId,
    score: ins.score,
    rank: ins.rank,
    factors: ins.factors,
    flags: ins.flags,
    status: 'Suggested',
    closedReason: null,
    closedByDealId: null,
    priorStatus: null,
    rejectedReason: null,
    rejectedScore: null,
    rejectedFactsVersion: null,
    origin: 'engine',
    weightsVersion,
    confirmedBy: null,
    confirmedAt: null,
    openDealId: null,
    proposalSentAt: null,
    visitedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await store.matches.insert(m);
  await store.events.publish({ type: 'match.suggested.v1', match: m });
  return m;
}

export async function publishIntent(
  store: Store,
  e: MatchEventIntent,
  saved: ReadonlyMap<string, MatchRecord>,
  originals: ReadonlyMap<string, MatchRecord>,
): Promise<void> {
  const match = saved.get(e.matchId) ?? originals.get(e.matchId);
  if (!match) return;
  switch (e.type) {
    case 'suggested':
      return store.events.publish({ type: 'match.suggested.v1', match });
    case 'closed':
      return store.events.publish({ type: 'match.closed.v1', match, reason: e.reason });
    case 'reopened':
      return store.events.publish({ type: 'match.reopened.v1', match, reason: e.reason });
    case 'flagged':
      return store.events.publish({ type: 'match.flagged.v1', match, flag: e.flag, cleared: e.cleared });
  }
}

function exclusionRows(demandId: string, rows: readonly ExclusionPlan[], now: Date) {
  return rows.slice(0, MAX_EXCLUSIONS).map((e) => ({
    demandId,
    offerId: e.offerId,
    reason: e.reason,
    availableFrom: e.availableFrom,
    moveInBy: e.moveInBy,
    computedAt: now,
  }));
}

/** Loads live candidates for a demand (5,000 cap; price narrowing when the cap is hit). */
async function offerCandidates(store: Store, d: DemandMx, weights: Weights): Promise<OfferRecord[]> {
  const keys = demandMatchKeys(d);
  const first = await store.mx.offerCandidates(d.tenantId, keys, CANDIDATE_LIMIT);
  if (first.length < CANDIDATE_LIMIT) return first;
  const budgets = d.dealTypes.map((dt) => budgetMaxFor(d, dt)).filter((b): b is number => b !== null);
  if (!budgets.length) return first;
  const cap = Math.max(...budgets) * (1 + weights.tuning.priceOverBudgetZeroPct / 100);
  return store.mx.offerCandidates(d.tenantId, keys, CANDIDATE_LIMIT, Math.round(cap));
}

/**
 * RescoreSubject for a demand (LLD §4.5 steps 1–6). With a run, the run is completed and
 * demand.matching_completed.v1 is published (inventory check / manual re-run).
 */
export async function rescoreDemand(
  store: Store,
  clock: Clock,
  tenantId: string,
  demandId: string,
  runId: string | null = null,
): Promise<RunStats | null> {
  const d = await store.mx.getDemand(tenantId, demandId);
  const run = runId ? await store.runs.get(tenantId, runId) : null;
  if (!d) {
    if (run)
      await store.runs.update(tenantId, run.id, {
        status: 'failed',
        error: 'demand not found',
        finishedAt: clock.now(),
      });
    return null;
  }
  const ctx = await scoringContext(store, clock, tenantId);
  const existing = await store.matches.listForDemand(tenantId, d.id, DEMAND_MATCH_LIMIT);
  const originals = new Map(existing.map((m) => [m.id, m]));
  const stats: RunStats = { candidates: 0, suggested: 0, closed: 0, excluded: 0 };

  if (!demandIsMatchable(d)) {
    const plan = planMerge(d, existing, new Map(), ctx.weights.tuning);
    await applyPlan(store, clock, d, plan, originals, ctx.weights.version, new Map());
    stats.closed = plan.counts.closed;
  } else {
    const live = await offerCandidates(store, d, ctx.weights);
    const unlive = await store.mx.unliveOfferCandidates(tenantId, demandMatchKeys(d), UNLIVE_LIMIT);
    const have = new Set([...live, ...unlive].map((o) => o.id));
    const missing = [...new Set(existing.flatMap((m) => m.offerIds))].filter((id) => !have.has(id));
    const extra = missing.length ? await store.mx.getOffers(tenantId, missing) : [];
    const bundleIds = existing.filter((m) => m.isBundle && m.bundleId).map((m) => m.bundleId as string);
    const bundles = bundleIds.length ? await store.bundles.getMany(tenantId, bundleIds) : [];
    const grouping = new Map(bundles.map((b) => [b.id, b.grouping]));
    const existingBundles = existing
      .filter((m) => m.isBundle && m.bundleId && grouping.has(m.bundleId))
      .map((m) => ({ match: m, grouping: grouping.get(m.bundleId as string) as BundleRecord['grouping'] }));
    const result = runDemand(
      d,
      [...live, ...unlive, ...extra],
      existingBundles,
      ctx,
      new Set(existing.map((m) => m.offerSetKey)),
    );
    const plan = planMerge(d, existing, result.evaluations, ctx.weights.tuning);
    const found = new Map(result.bundles.map((b) => [b.offerSetKey, b]));
    await applyPlan(store, clock, d, plan, originals, ctx.weights.version, found);
    await store.exclusions.replaceForDemand(
      tenantId,
      d.id,
      exclusionRows(d.id, result.exclusions, clock.now()),
    );
    stats.candidates = live.length;
    stats.suggested = plan.counts.suggested;
    stats.closed = plan.counts.closed;
    stats.excluded = Math.min(result.exclusions.length, MAX_EXCLUSIONS);
  }

  if (run) {
    await store.runs.update(tenantId, run.id, {
      status: 'done',
      ...stats,
      startedAt: run.startedAt ?? clock.now(),
      finishedAt: clock.now(),
    });
    const after = await store.matches.listForDemand(tenantId, d.id, DEMAND_MATCH_LIMIT);
    const open = after.filter((m) => isOpen(m.status));
    await store.events.publish({
      type: 'demand.matching_completed.v1',
      tenantId,
      demandId: d.id,
      runId: run.id,
      matchCount: open.filter((m) => !m.isBundle).length,
      bundleCount: open.filter((m) => m.isBundle).length,
    });
  }
  return stats;
}

/**
 * RescoreSubject for an offer (LLD §4.5 "symmetric"): the offer's single pair with each candidate demand and each
 * demand it already has a match with; ranks of those demands are maintained. Bundles are re-evaluated by marking the
 * affected bundle-eligible demands dirty (their demand-side run runs the bundle finder).
 */
export async function rescoreOffer(
  store: Store,
  clock: Clock,
  tenantId: string,
  offerId: string,
): Promise<RunStats | null> {
  const o = await store.mx.getOffer(tenantId, offerId);
  if (!o) return null;
  const ctx = await scoringContext(store, clock, tenantId);
  const stats: RunStats = { candidates: 0, suggested: 0, closed: 0, excluded: 0 };
  const withOffer = await store.matches.listForOffer(tenantId, o.id, null, OFFER_MATCH_LIMIT);
  const candidates =
    o.mergedInto || o.voided
      ? []
      : await store.mx.demandCandidates(tenantId, offerMatchKeys(o), CANDIDATE_LIMIT);
  stats.candidates = candidates.length;
  const byDemand = new Map<string, DemandRecord>(candidates.map((d) => [d.id, d]));
  const extraIds = [...new Set(withOffer.map((m) => m.demandId))].filter((id) => !byDemand.has(id));
  for (const d of extraIds.length ? await store.mx.getDemands(tenantId, extraIds) : []) byDemand.set(d.id, d);
  const key = offerSetKeyOf([o.id]);
  const now = clock.now();

  for (const d of byDemand.values()) {
    if (!demandIsMatchable(d)) continue; // the demand's own run closes its matches
    const single = evaluateSingle(o, d, ctx);
    const hasSingle = withOffer.some((m) => m.demandId === d.id && m.offerSetKey === key);
    const inBundle = withOffer.some((m) => m.demandId === d.id && m.isBundle);
    const size = offerAreaSize(o);
    if (
      inBundle ||
      (bundleEligible(d) && single.pair?.areaOutOfRange && size !== null && size < (d.areaSqftMin ?? 0))
    )
      await store.rescore.markDirty(tenantId, 'demand', d.id, 'offer.bundle_candidate');
    // exclusions for this pair
    if (single.filter.kind === 'exclude' && !(single.filter.reason === 'demand_stale' && hasSingle)) {
      await store.exclusions.upsertPair(tenantId, {
        demandId: d.id,
        offerId: o.id,
        reason: single.filter.reason,
        availableFrom: single.filter.availableFrom,
        moveInBy: d.moveInBy,
        computedAt: now,
      });
      stats.excluded++;
    } else await store.exclusions.deletePair(tenantId, d.id, o.id);
    if (!hasSingle && single.eval.kind !== 'pass') continue;
    const existing = await store.matches.listForDemand(tenantId, d.id, DEMAND_MATCH_LIMIT);
    const originals = new Map(existing.map((m) => [m.id, m]));
    const plan = planMerge(d, existing, new Map<string, PairEval>([[key, single.eval]]), ctx.weights.tuning);
    await applyPlan(store, clock, d, plan, originals, ctx.weights.version, new Map());
    stats.suggested += plan.counts.suggested;
    stats.closed += plan.counts.closed;
  }
  return stats;
}

/** Records a queued matching run (inventory check after qualification, manual re-run). */
export async function queueDemandRun(
  store: Store,
  clock: Clock,
  tenantId: string,
  demandId: string,
  trigger: string,
  requestedBy: string | null,
): Promise<RunRecord> {
  const active = await store.runs.activeForSubject(tenantId, demandId);
  if (active) return active;
  const run: RunRecord = {
    id: newId(),
    tenantId,
    scope: 'demand',
    subjectId: demandId,
    trigger,
    status: 'queued',
    candidates: null,
    suggested: null,
    closed: null,
    excluded: null,
    error: null,
    requestedBy,
    createdAt: clock.now(),
    startedAt: null,
    finishedAt: null,
  };
  await store.runs.create(run);
  await store.rescore.markDirty(tenantId, 'demand', demandId, trigger, run.id);
  return run;
}

/** Work item from q_crm_engine_rescore: claim the dedupe row and re-score the subject. */
export async function processDirtySubject(
  store: Store,
  clock: Clock,
  tenantId: string,
  subjectType: 'offer' | 'demand',
  subjectId: string,
): Promise<RunStats | null> {
  const claim = await store.rescore.claim(tenantId, subjectType, subjectId);
  if (!claim) return null; // already processed by another message
  if (subjectType === 'offer') return rescoreOffer(store, clock, tenantId, subjectId);
  return rescoreDemand(store, clock, tenantId, subjectId, claim.runId);
}
