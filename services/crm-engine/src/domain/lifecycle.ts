// Match state machine, merge of a matching run into existing matches, top-N and propagation (LLD §4.5 step 4–5, §4.6).
import { demandAcceptsNew, demandIsMatchable } from './matchable.js';
import type {
  CloseReason,
  DemandMx,
  FactorResult,
  MatchFlag,
  MatchStatus,
  OfferMx,
  ReopenReason,
} from './types.js';
import type { Tuning } from './weights.js';

export interface MatchState {
  id: string;
  demandId: string;
  offerIds: string[];
  offerSetKey: string;
  isBundle: boolean;
  score: number;
  rank: number | null;
  factors: FactorResult[];
  flags: MatchFlag[];
  status: MatchStatus;
  closedReason: CloseReason | null;
  closedByDealId: string | null;
  priorStatus: MatchStatus | null;
  rejectedScore: number | null;
  rejectedFactsVersion: number | null;
  weightsVersion: number;
}

/** Evaluation of one offer set for the demand in the current run. */
export type PairEval =
  | {
      kind: 'pass';
      score: number;
      factors: FactorResult[];
      flags: MatchFlag[];
      /** score ≥ minScore and (single) area within tolerance. */
      suggestible: boolean;
      /** Highest facts_version among the offers (rejected re-suggest rule). */
      factsVersion: number;
    }
  | { kind: 'fail'; closeCause: CloseReason | null };

export type MatchEventIntent =
  | { type: 'suggested'; matchId: string }
  | { type: 'closed'; matchId: string; reason: CloseReason }
  | { type: 'reopened'; matchId: string; reason: ReopenReason }
  | { type: 'flagged'; matchId: string; flag: MatchFlag; cleared: boolean };

export interface NewMatchPlan {
  offerSetKey: string;
  score: number;
  factors: FactorResult[];
  flags: MatchFlag[];
  rank: number;
}

export interface MergePlan {
  inserts: NewMatchPlan[];
  /** Changed matches (full new state). */
  updates: MatchState[];
  events: MatchEventIntent[];
  counts: { suggested: number; closed: number };
}

const OPEN: MatchStatus[] = ['Suggested', 'Confirmed'];
export const isOpen = (s: MatchStatus) => OPEN.includes(s);

/** Why an offer can no longer be matched, as a match close reason (LLD §4.6). */
export function offerCloseCause(
  o: Pick<OfferMx, 'voided' | 'mergedInto' | 'commercialStatus' | 'lifeStage' | 'dealType'>,
): CloseReason | null {
  if (o.voided) return 'voided';
  if (o.mergedInto) return 'merged';
  if (o.commercialStatus === 'Closed') return closeReasonForOfferClosed(o.dealType);
  if (o.commercialStatus === 'Inactive') return 'offer_retired';
  if (o.lifeStage === 'Expired') return 'offer_expired';
  return null;
}

/** Offer Closed: Lease → leased_to_another_client; Sale, Pagdi, JV → sold_to_another_client (BRD §7). */
export const closeReasonForOfferClosed = (dealType: string): CloseReason =>
  dealType === 'Lease' ? 'leased_to_another_client' : 'sold_to_another_client';

/**
 * Why a demand's open matches close when it stops being matchable. An exit wins over the life stage it sets
 * (Dormant → Paused closes as demand_exited); a demand Expired / Paused by its lifecycle closes as demand_expired /
 * demand_paused (CR-011 item 4, CR-012).
 */
export function demandCloseCause(d: DemandMx): CloseReason | null {
  if (demandIsMatchable(d)) return null;
  if (d.voided) return 'voided';
  if (d.mergedInto) return 'merged';
  if (d.commercialStatus === 'Closed' && !d.exitType) return 'demand_closed';
  if (d.outsideLaunchArea) return 'superseded';
  if (!d.exitType && d.lifeStage === 'Expired') return 'demand_expired';
  if (!d.exitType && d.lifeStage === 'Paused') return 'demand_paused';
  return 'demand_exited';
}

/** Close reasons of a demand that stopped being live; they reopen as demand_reactivated. */
export const DEMAND_REOPENABLE: readonly CloseReason[] = ['demand_exited', 'demand_expired', 'demand_paused'];

/** Close reasons a rescore may undo when the pair is valid again. */
const OFFER_REOPENABLE: CloseReason[] = [
  'offer_expired',
  'offer_retired',
  'leased_to_another_client',
  'sold_to_another_client',
];

const sameFlags = (a: readonly MatchFlag[], b: readonly MatchFlag[]) =>
  a.length === b.length && a.every((f) => b.includes(f));

function flagDiff(
  matchId: string,
  before: readonly MatchFlag[],
  after: readonly MatchFlag[],
): MatchEventIntent[] {
  const out: MatchEventIntent[] = [];
  for (const f of after)
    if (!before.includes(f)) out.push({ type: 'flagged', matchId, flag: f, cleared: false });
  for (const f of before)
    if (!after.includes(f)) out.push({ type: 'flagged', matchId, flag: f, cleared: true });
  return out;
}

const byScore = (a: { score: number; key: string }, b: { score: number; key: string }) =>
  b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Merges one run's evaluations into the demand's matches (LLD §4.5 step 4 and 5):
 * - new pair with score ≥ minScore and accepts_new → Suggested;
 * - Suggested/Confirmed → score/factors/flags updated; re-rank emits suggested (Suggested only), flag changes emit
 *   flagged; a Suggested pair that no longer qualifies closes `superseded`; an offer that died closes with its cause;
 * - Rejected → re-suggested only after an offer fact change with a gain ≥ rejectedResuggestMinGain;
 * - Closed for a cause that no longer holds → reopened (offer_reactivated / demand_reactivated);
 * - top-N: ranks 1..topNPerDemand among open suggestions; lower ones close `superseded`; Confirmed never demoted.
 * Existing matches without an evaluation are left as they are (their stored score still counts for the ranking).
 */
export function planMerge(
  demand: DemandMx,
  existing: readonly MatchState[],
  evaluations: ReadonlyMap<string, PairEval>,
  tuning: Tuning,
): MergePlan {
  const events: MatchEventIntent[] = [];
  const changed = new Map<string, MatchState>();
  const counts = { suggested: 0, closed: 0 };
  const put = (m: MatchState) => changed.set(m.id, m);
  const close = (m: MatchState, reason: CloseReason, keepPrior = true) => {
    put({
      ...m,
      status: 'Closed',
      closedReason: reason,
      priorStatus: keepPrior ? m.status : m.priorStatus,
      rank: null,
    });
    events.push({ type: 'closed', matchId: m.id, reason });
    counts.closed++;
  };

  const demandCause = demandCloseCause(demand);
  if (demandCause) {
    for (const m of existing) if (isOpen(m.status)) close(m, demandCause);
    return { inserts: [], updates: [...changed.values()], events, counts };
  }
  const accepts = demandAcceptsNew(demand);

  /** Matches that want to be open Suggested after this run (subject to top-N). */
  type Want = {
    key: string;
    score: number;
    existing?: MatchState;
    eval?: Extract<PairEval, { kind: 'pass' }>;
    how: 'keep' | 'new' | 'resuggest' | 'reopen';
  };
  const wants: Want[] = [];
  const known = new Set<string>();

  for (const m of existing) {
    known.add(m.offerSetKey);
    const ev = evaluations.get(m.offerSetKey);
    if (m.status === 'Suggested' || m.status === 'Confirmed') {
      if (!ev) {
        if (m.status === 'Suggested')
          wants.push({ key: m.offerSetKey, score: m.score, existing: m, how: 'keep' });
        continue;
      }
      if (ev.kind === 'fail') {
        if (ev.closeCause) close(m, ev.closeCause);
        else if (m.status === 'Suggested') close(m, 'superseded');
        continue;
      }
      const updated: MatchState = { ...m, score: ev.score, factors: ev.factors, flags: ev.flags };
      events.push(...flagDiff(m.id, m.flags, ev.flags));
      if (m.status === 'Confirmed') {
        if (
          updated.score !== m.score ||
          !sameFlags(m.flags, ev.flags) ||
          JSON.stringify(m.factors) !== JSON.stringify(ev.factors)
        )
          put({ ...updated, rank: null });
        continue;
      }
      if (!ev.suggestible) {
        close(updated, 'superseded');
        continue;
      }
      wants.push({ key: m.offerSetKey, score: ev.score, existing: updated, eval: ev, how: 'keep' });
      continue;
    }
    if (!ev || ev.kind !== 'pass') continue;
    if (m.status === 'Rejected') {
      if (
        accepts &&
        ev.suggestible &&
        ev.factsVersion > (m.rejectedFactsVersion ?? 0) &&
        ev.score >= (m.rejectedScore ?? 0) + tuning.rejectedResuggestMinGain
      )
        wants.push({ key: m.offerSetKey, score: ev.score, existing: m, eval: ev, how: 'resuggest' });
      continue;
    }
    // Closed
    const reason = m.closedReason;
    if (reason && OFFER_REOPENABLE.includes(reason)) {
      if (m.priorStatus === 'Confirmed') {
        put({
          ...m,
          status: 'Confirmed',
          closedReason: null,
          priorStatus: null,
          score: ev.score,
          factors: ev.factors,
          flags: ev.flags,
          rank: null,
        });
        events.push({ type: 'reopened', matchId: m.id, reason: 'offer_reactivated' });
      } else if (ev.suggestible)
        wants.push({ key: m.offerSetKey, score: ev.score, existing: m, eval: ev, how: 'reopen' });
    } else if (reason && DEMAND_REOPENABLE.includes(reason)) {
      if (m.priorStatus === 'Confirmed') {
        put({
          ...m,
          status: 'Confirmed',
          closedReason: null,
          priorStatus: null,
          score: ev.score,
          factors: ev.factors,
          flags: ev.flags,
          rank: null,
        });
        events.push({ type: 'reopened', matchId: m.id, reason: 'demand_reactivated' });
      } else if (ev.suggestible && accepts)
        wants.push({ key: m.offerSetKey, score: ev.score, existing: m, eval: ev, how: 'reopen' });
    } else if (reason === 'superseded' && ev.suggestible && accepts) {
      wants.push({ key: m.offerSetKey, score: ev.score, existing: m, eval: ev, how: 'resuggest' });
    }
  }

  if (accepts)
    for (const [key, ev] of evaluations)
      if (!known.has(key) && ev.kind === 'pass' && ev.suggestible)
        wants.push({ key, score: ev.score, eval: ev, how: 'new' });

  wants.sort(byScore);
  const inserts: NewMatchPlan[] = [];
  wants.forEach((w, i) => {
    const rank = i + 1;
    const inTop = rank <= tuning.topNPerDemand;
    const m = w.existing;
    if (w.how === 'new') {
      if (inTop && w.eval)
        inserts.push({
          offerSetKey: w.key,
          score: w.eval.score,
          factors: w.eval.factors,
          flags: w.eval.flags,
          rank,
        });
      if (inTop) counts.suggested++;
      return;
    }
    if (!m) return;
    if (w.how === 'keep') {
      if (!inTop) return close(m, 'superseded');
      const original = existing.find((e) => e.id === m.id);
      if (original && Math.abs(original.score - m.score) >= 1)
        events.push({ type: 'suggested', matchId: m.id });
      if (
        !original ||
        original.rank !== rank ||
        original.score !== m.score ||
        JSON.stringify(original.factors) !== JSON.stringify(m.factors) ||
        !sameFlags(original.flags, m.flags)
      )
        put({ ...m, rank });
      return;
    }
    if (!inTop || !w.eval) return;
    const next: MatchState = {
      ...m,
      status: 'Suggested',
      closedReason: null,
      closedByDealId: w.how === 'reopen' ? null : m.closedByDealId,
      priorStatus: w.how === 'reopen' ? null : m.priorStatus,
      score: w.eval.score,
      factors: w.eval.factors,
      flags: w.eval.flags,
      rank,
    };
    put(next);
    counts.suggested++;
    if (w.how === 'reopen')
      events.push({
        type: 'reopened',
        matchId: m.id,
        reason:
          m.closedReason && DEMAND_REOPENABLE.includes(m.closedReason)
            ? 'demand_reactivated'
            : 'offer_reactivated',
      });
    else events.push({ type: 'suggested', matchId: m.id });
  });

  return { inserts, updates: [...changed.values()], events, counts };
}

/** Outcome of a staff action on a match (LLD §4.6). */
export type ActionResult =
  | { ok: true; next: MatchState; changed: boolean }
  | { ok: false; code: 'invalid-match-status' | 'match-in-deal' };

/** Confirm: Suggested → Confirmed; already Confirmed → unchanged (200); Rejected/Closed → 409 invalid-match-status. */
export function confirmMatch(m: MatchState): ActionResult {
  if (m.status === 'Confirmed') return { ok: true, next: m, changed: false };
  if (m.status !== 'Suggested') return { ok: false, code: 'invalid-match-status' };
  return { ok: true, next: { ...m, status: 'Confirmed', rank: null }, changed: true };
}

/**
 * Reject: Suggested/Confirmed → Rejected with the score and offer facts version remembered (re-suggest rule);
 * already Rejected → unchanged; Closed → 409 invalid-match-status; used by an open deal → 409 match-in-deal.
 */
export function rejectMatch(m: MatchState, inOpenDeal: boolean, offerFactsVersion: number): ActionResult {
  if (m.status === 'Rejected') return { ok: true, next: m, changed: false };
  if (m.status === 'Closed') return { ok: false, code: 'invalid-match-status' };
  if (inOpenDeal) return { ok: false, code: 'match-in-deal' };
  return {
    ok: true,
    next: {
      ...m,
      status: 'Rejected',
      rank: null,
      rejectedScore: m.score,
      rejectedFactsVersion: offerFactsVersion,
    },
    changed: true,
  };
}

/** Status precedence when two matches collapse onto the same (demand, offer set) after a merge (LLD §4.7). */
export const STATUS_PRECEDENCE: Record<MatchStatus, number> = {
  Confirmed: 3,
  Suggested: 2,
  Rejected: 1,
  Closed: 0,
};

/** Flags on an open match after an offer's life stage changes (Stale → reconfirm; Fresh/Ageing → cleared). */
export function reconfirmFlags(flags: readonly MatchFlag[], offersStale: boolean): MatchFlag[] {
  const set = new Set(flags);
  if (offersStale) set.add('reconfirm');
  else set.delete('reconfirm');
  const order: MatchFlag[] = ['price_above_budget', 'reconfirm', 'area_basis_unknown', 'market_unknown'];
  return order.filter((f) => set.has(f));
}
