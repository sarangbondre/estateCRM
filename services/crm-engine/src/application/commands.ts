// Staff commands (LLD §4.6, §6, contract crm-engine.yaml): confirm, reject, manual bundle, re-run, weights.
import { groupingOf, manualBundleRuleError, offerSetKeyOf, scoreBundle } from '../domain/bundles.js';
import type { BundleMember } from '../domain/bundles.js';
import { evaluateHardFilters } from '../domain/filters.js';
import { confirmMatch, rejectMatch } from '../domain/lifecycle.js';
import { demandIsMatchable, offerIsMatchable } from '../domain/matchable.js';
import { scorePair } from '../domain/scoring.js';
import type { RejectReason } from '../domain/types.js';
import { validateWeights } from '../domain/weights.js';
import type { WeightsBody } from '../domain/weights.js';
import { UseCaseError, notFoundError } from './errors.js';
import { queueDemandRun, scoringContext, weightsFor } from './pipeline.js';
import type { BundleRecord, Clock, MatchRecord, RunRecord, Store, WeightsRecord } from './ports.js';

export interface Actor {
  tenantId: string;
  userId: string;
  role: string;
}

const newId = () => globalThis.crypto.randomUUID();

/** Key-order independent JSON (PUT idempotency: the same weights twice make one version). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

async function matchOr404(store: Store, tenantId: string, idOrCode: string): Promise<MatchRecord> {
  const m = await store.matches.get(tenantId, idOrCode);
  if (!m) throw notFoundError('match');
  return m;
}

/** POST /v1/matches/{idOrCode}/confirm: Suggested → Confirmed (feedback row, match.confirmed.v1). */
export async function confirm(
  store: Store,
  clock: Clock,
  actor: Actor,
  idOrCode: string,
): Promise<MatchRecord> {
  const m = await matchOr404(store, actor.tenantId, idOrCode);
  const r = confirmMatch(m);
  if (!r.ok) throw new UseCaseError(409, r.code, `match is ${m.status}`);
  if (!r.changed) return m;
  const now = clock.now();
  const saved = await store.matches.update({ ...m, ...r.next, confirmedBy: actor.userId, confirmedAt: now });
  await store.feedback.insert(actor.tenantId, {
    matchId: m.id,
    demandId: m.demandId,
    action: 'confirmed',
    source: 'staff',
    reasonCode: null,
    score: m.score,
    factors: m.factors,
    weightsVersion: m.weightsVersion,
    byUser: actor.userId,
    at: now,
  });
  await store.events.publish({ type: 'match.confirmed.v1', match: saved, confirmedBy: actor.userId });
  await store.rescore.markDirty(actor.tenantId, 'demand', m.demandId, 'match.confirmed');
  return saved;
}

/** POST /v1/matches/{idOrCode}/reject: Suggested/Confirmed → Rejected with a reason code (match.rejected.v1). */
export async function reject(
  store: Store,
  clock: Clock,
  actor: Actor,
  idOrCode: string,
  reasonCode: RejectReason,
): Promise<MatchRecord> {
  const m = await matchOr404(store, actor.tenantId, idOrCode);
  const offers = await store.mx.getOffers(actor.tenantId, m.offerIds);
  const factsVersion = Math.max(0, ...offers.map((o) => o.factsVersion));
  const r = rejectMatch(m, m.openDealId !== null, factsVersion);
  if (!r.ok)
    throw new UseCaseError(
      409,
      r.code,
      r.code === 'match-in-deal' ? 'an open deal uses this match' : `match is ${m.status}`,
    );
  if (!r.changed) return m;
  const now = clock.now();
  const saved = await store.matches.update({ ...m, ...r.next, rejectedReason: reasonCode });
  await store.feedback.insert(actor.tenantId, {
    matchId: m.id,
    demandId: m.demandId,
    action: 'rejected',
    source: 'staff',
    reasonCode,
    score: m.score,
    factors: m.factors,
    weightsVersion: m.weightsVersion,
    byUser: actor.userId,
    at: now,
  });
  await store.events.publish({ type: 'match.rejected.v1', match: saved, reason: reasonCode });
  await store.rescore.markDirty(actor.tenantId, 'demand', m.demandId, 'match.rejected');
  return saved;
}

/**
 * POST /v1/bundles (A-38, LLD §4.3 "manual bundles"): 2–3 offers for a Commercial/Industrial demand, co-located,
 * same deal type, each passing the demand's hard filters except area, combined area ≥ the minimum. The same offer
 * set for the demand returns the existing bundle (created = false). Supply agents may create Suggested bundles only.
 */
export async function createBundle(
  store: Store,
  clock: Clock,
  actor: Actor,
  body: { demandId: string; offerIds: string[]; confirm?: boolean },
): Promise<{ bundle: BundleRecord; match: MatchRecord; created: boolean }> {
  if (body.confirm && actor.role === 'Supply agent')
    throw new UseCaseError(403, 'forbidden', 'Supply agents may only suggest bundles');
  const t = actor.tenantId;
  const d = await store.mx.getDemand(t, body.demandId);
  if (!d) throw notFoundError('demand');
  if (!demandIsMatchable(d))
    throw new UseCaseError(
      409,
      'demand-not-matchable',
      'the demand is exited, Closed or outside the launch area',
    );
  const ids = [...new Set(body.offerIds)];
  const ctx = await scoringContext(store, clock, t);
  if (ids.length < 2 || ids.length > ctx.weights.tuning.bundleMaxOffers)
    throw new UseCaseError(
      400,
      'bundle-too-large',
      `a bundle has 2 to ${ctx.weights.tuning.bundleMaxOffers} offers`,
    );
  const offers = await store.mx.getOffers(t, ids);
  if (offers.length !== ids.length) throw notFoundError('offer');
  const ordered = ids.map((id) => offers.find((o) => o.id === id) as (typeof offers)[number]);
  const dead = ordered.find((o) => !offerIsMatchable(o));
  if (dead)
    throw new UseCaseError(
      409,
      'offer-not-matchable',
      `offer ${dead.code} is ${dead.lifeStage} / ${dead.commercialStatus}`,
    );

  const existing = await store.matches.byPair(t, d.id, offerSetKeyOf(ids));
  if (existing?.bundleId) {
    const b = await store.bundles.get(t, existing.bundleId);
    if (b) return { bundle: b, match: existing, created: false };
  }

  const rule = manualBundleRuleError(d, ordered, ctx);
  if (rule) throw new UseCaseError(400, rule, ruleDetail(rule));
  const failures = ordered.flatMap((o, i) => {
    const f = evaluateHardFilters(o, d);
    if (f.kind === 'pass') return [];
    return [
      {
        field: `offerIds[${i}]`,
        code: f.failed,
        message: `${o.code}: ${f.checks.at(-1)?.detail ?? f.failed}`.slice(0, 200),
      },
    ];
  });
  if (failures.length)
    throw new UseCaseError(
      400,
      'bundle-hard-filter-failed',
      "an offer fails the demand's hard filters",
      failures,
    );

  const grouping = groupingOf(ordered, ctx.hierarchy);
  if (!grouping) throw new UseCaseError(400, 'bundle-not-colocated', ruleDetail('bundle-not-colocated'));
  const members: BundleMember[] = ordered.map((o) => ({ offer: o, pair: scorePair(o, d, ctx) }));
  const scored = scoreBundle(members, grouping, d, ctx, false);
  if (!scored)
    throw new UseCaseError(400, 'bundle-area-insufficient', ruleDetail('bundle-area-insufficient'));

  const now = clock.now();
  const matchId = existing?.id ?? newId();
  const bundle: BundleRecord = {
    id: newId(),
    tenantId: t,
    code: await store.matches.nextCode(t, 'BND'),
    demandId: d.id,
    offerIds: scored.offerIds,
    grouping,
    combinedAreaSqft: scored.combinedAreaSqft,
    combinedPriceInr: scored.combinedPriceInr,
    combinedRentMonthlyInr: scored.combinedRentMonthlyInr,
    origin: 'user',
    createdBy: actor.userId,
    matchId,
    createdAt: now,
  };
  await store.bundles.insert(bundle);
  const status = body.confirm ? 'Confirmed' : 'Suggested';
  let match: MatchRecord;
  if (existing) {
    match = await store.matches.update({
      ...existing,
      isBundle: true,
      bundleId: bundle.id,
      score: scored.score,
      factors: scored.factors,
      flags: scored.flags,
      status,
      closedReason: null,
      priorStatus: null,
      closedByDealId: null,
      rank: null,
      weightsVersion: ctx.weights.version,
      confirmedBy: body.confirm ? actor.userId : existing.confirmedBy,
      confirmedAt: body.confirm ? now : existing.confirmedAt,
    });
  } else {
    match = {
      id: matchId,
      tenantId: t,
      code: await store.matches.nextCode(t, 'MAT'),
      demandId: d.id,
      offerIds: scored.offerIds,
      offerSetKey: scored.offerSetKey,
      isBundle: true,
      bundleId: bundle.id,
      score: scored.score,
      rank: null,
      factors: scored.factors,
      flags: scored.flags,
      status,
      closedReason: null,
      closedByDealId: null,
      priorStatus: null,
      rejectedReason: null,
      rejectedScore: null,
      rejectedFactsVersion: null,
      origin: 'user',
      weightsVersion: ctx.weights.version,
      confirmedBy: body.confirm ? actor.userId : null,
      confirmedAt: body.confirm ? now : null,
      openDealId: null,
      proposalSentAt: null,
      visitedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.matches.insert(match);
  }
  await store.events.publish({ type: 'match.suggested.v1', match });
  if (body.confirm) {
    await store.feedback.insert(t, {
      matchId: match.id,
      demandId: d.id,
      action: 'confirmed',
      source: 'staff',
      reasonCode: null,
      score: match.score,
      factors: match.factors,
      weightsVersion: match.weightsVersion,
      byUser: actor.userId,
      at: now,
    });
    await store.events.publish({ type: 'match.confirmed.v1', match, confirmedBy: actor.userId });
  }
  await store.rescore.markDirty(t, 'demand', d.id, 'bundle.created');
  return { bundle, match, created: true };
}

function ruleDetail(code: string): string {
  switch (code) {
    case 'bundle-too-large':
      return 'a bundle has 2 to 3 offers';
    case 'bundle-segment-not-allowed':
      return 'bundles are for Commercial or Industrial demands';
    case 'bundle-not-colocated':
      return 'offers must be in the same building or the same / adjacent micromarkets';
    case 'bundle-mixed-deal-type':
      return 'offers must have the same deal type';
    case 'bundle-area-insufficient':
      return "the combined area is below the demand's minimum";
    default:
      return code;
  }
}

/** POST /v1/demands/{idOrCode}/matching-runs: async re-run (202); an active run is returned. */
export async function rerun(
  store: Store,
  clock: Clock,
  actor: Actor,
  idOrCode: string,
  reason: string | null,
): Promise<RunRecord> {
  const ref = await store.mx.resolveDemand(actor.tenantId, idOrCode);
  if (!ref) throw notFoundError('demand');
  const d = await store.mx.getDemand(actor.tenantId, ref.id);
  if (!d || !demandIsMatchable(d))
    throw new UseCaseError(
      409,
      'demand-not-matchable',
      'the demand is exited, Closed or outside the launch area',
    );
  return queueDemandRun(
    store,
    clock,
    actor.tenantId,
    d.id,
    reason ? `manual:${reason}` : 'manual',
    actor.userId,
  );
}

/** GET /v1/weights. */
export async function currentWeights(store: Store, tenantId: string): Promise<WeightsRecord> {
  const w = await store.weights.active(tenantId);
  if (w) return w;
  const d = await weightsFor(store, tenantId);
  return { ...d, id: null, createdBy: null, createdAt: new Date(0) };
}

/**
 * PUT /v1/weights (Admin): new version when the body differs (PUT is idempotent), audit.recorded.v1, and a full
 * re-score queued. If-Match must equal the current version (412 otherwise).
 */
export async function putWeights(
  store: Store,
  actor: Actor,
  body: WeightsBody,
  ifMatch: number | undefined,
): Promise<{ weights: WeightsRecord; changed: boolean }> {
  const current = await currentWeights(store, actor.tenantId);
  if (ifMatch !== undefined && ifMatch !== current.version) throw new UseCaseError(412, 'version-mismatch');
  const problems = validateWeights(body);
  if (problems.length)
    throw new UseCaseError(
      400,
      'weights-invalid',
      'all factor weights are zero or a tunable is out of range',
      problems.map((p) => ({ field: p.field, code: p.code })),
    );
  if (
    current.id &&
    canonical({ f: current.factors, t: current.tuning }) === canonical({ f: body.factors, t: body.tuning })
  )
    return { weights: current, changed: false };
  const created = await store.weights.create(actor.tenantId, body, actor.userId);
  await store.events.publish({
    type: 'audit.recorded.v1',
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    action: 'weights.updated',
    subjectId: created.id as string,
    details: { fromVersion: String(current.version), toVersion: String(created.version) },
  });
  await store.rescore.enqueueJob('full-rescore', actor.tenantId);
  return { weights: created, changed: true };
}
