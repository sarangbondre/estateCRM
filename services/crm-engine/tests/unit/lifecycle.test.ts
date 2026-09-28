// Match state machine, run merge and top-N (LLD §4.5 steps 4–5, §4.6).
import { describe, expect, it } from 'vitest';
import {
  closeReasonForOfferClosed,
  confirmMatch,
  demandCloseCause,
  offerCloseCause,
  planMerge,
  rejectMatch,
} from '../../src/domain/lifecycle.js';
import type { MatchState, PairEval } from '../../src/domain/lifecycle.js';
import type { MatchFlag } from '../../src/domain/types.js';
import { DEFAULT_WEIGHTS } from '../../src/domain/weights.js';
import { demand, offer } from './fixtures.js';

const T = DEFAULT_WEIGHTS.tuning;
let n = 0;
const match = (p: Partial<MatchState> = {}): MatchState => {
  n++;
  const key = p.offerSetKey ?? `o${String(n).padStart(3, '0')}`;
  return {
    id: `m${String(n).padStart(3, '0')}`,
    demandId: 'd1',
    offerIds: [key],
    offerSetKey: key,
    isBundle: false,
    score: 70,
    rank: 1,
    factors: [],
    flags: [],
    status: 'Suggested',
    closedReason: null,
    closedByDealId: null,
    priorStatus: null,
    rejectedScore: null,
    rejectedFactsVersion: null,
    weightsVersion: 0,
    ...p,
  };
};
const pass = (
  score: number,
  p: { flags?: MatchFlag[]; suggestible?: boolean; factsVersion?: number } = {},
): PairEval => ({
  kind: 'pass',
  score,
  factors: [],
  flags: p.flags ?? [],
  suggestible: p.suggestible ?? score >= T.minScore,
  factsVersion: p.factsVersion ?? 1,
});
const evals = (entries: [string, PairEval][]) => new Map(entries);

describe('planMerge', () => {
  const d = demand();

  it('inserts new suggestible pairs with ranks; skips unsuggestible ones', () => {
    const plan = planMerge(
      d,
      [],
      evals([
        ['a', pass(80)],
        ['b', pass(90)],
        ['c', pass(30)],
        ['e', pass(95, { suggestible: false })],
      ]),
      T,
    );
    expect(plan.inserts.map((i) => [i.offerSetKey, i.rank])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
    expect(plan.counts.suggested).toBe(2);
  });

  it('re-rank: a score change on a Suggested match emits suggested; flag changes emit flagged', () => {
    const m = match({ offerSetKey: 'a', score: 70, flags: ['reconfirm'] });
    const plan = planMerge(d, [m], evals([['a', pass(82, { flags: ['price_above_budget'] })]]), T);
    expect(plan.updates[0]).toMatchObject({ id: m.id, score: 82, flags: ['price_above_budget'], rank: 1 });
    expect(plan.events).toEqual(
      expect.arrayContaining([
        { type: 'suggested', matchId: m.id },
        { type: 'flagged', matchId: m.id, flag: 'price_above_budget', cleared: false },
        { type: 'flagged', matchId: m.id, flag: 'reconfirm', cleared: true },
      ]),
    );
  });

  it('no event when nothing changed', () => {
    const m = match({ offerSetKey: 'a', score: 70, rank: 1 });
    const plan = planMerge(d, [m], evals([['a', pass(70)]]), T);
    expect(plan.events).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it('a Suggested pair below minScore or out of area closes superseded; a dead offer closes with its cause', () => {
    const low = match({ offerSetKey: 'a' });
    const dead = match({ offerSetKey: 'b' });
    const gone = match({ offerSetKey: 'c' });
    const plan = planMerge(
      d,
      [low, dead, gone],
      evals([
        ['a', pass(30)],
        ['b', { kind: 'fail', closeCause: 'leased_to_another_client' }],
        ['c', { kind: 'fail', closeCause: null }],
      ]),
      T,
    );
    expect(plan.events).toEqual([
      { type: 'closed', matchId: low.id, reason: 'superseded' },
      { type: 'closed', matchId: dead.id, reason: 'leased_to_another_client' },
      { type: 'closed', matchId: gone.id, reason: 'superseded' },
    ]);
    expect(plan.updates.find((u) => u.id === dead.id)).toMatchObject({
      status: 'Closed',
      priorStatus: 'Suggested',
    });
  });

  it('Confirmed matches are never demoted or superseded, but close when the offer dies', () => {
    const c = match({ offerSetKey: 'a', status: 'Confirmed', rank: null, score: 60 });
    expect(planMerge(d, [c], evals([['a', pass(20)]]), T).events).toEqual([]);
    expect(planMerge(d, [c], evals([['a', { kind: 'fail', closeCause: null }]]), T).events).toEqual([]);
    const plan = planMerge(d, [c], evals([['a', { kind: 'fail', closeCause: 'offer_expired' }]]), T);
    expect(plan.updates[0]).toMatchObject({
      status: 'Closed',
      closedReason: 'offer_expired',
      priorStatus: 'Confirmed',
    });
  });

  it('Rejected: re-suggested only after an offer fact change with a gain ≥ rejectedResuggestMinGain', () => {
    const r = match({
      offerSetKey: 'a',
      status: 'Rejected',
      rank: null,
      rejectedScore: 60,
      rejectedFactsVersion: 3,
    });
    expect(planMerge(d, [r], evals([['a', pass(90, { factsVersion: 3 })]]), T).events).toEqual([]); // no fact change
    expect(planMerge(d, [r], evals([['a', pass(65, { factsVersion: 4 })]]), T).events).toEqual([]); // gain 5 < 10
    const plan = planMerge(d, [r], evals([['a', pass(70, { factsVersion: 4 })]]), T);
    expect(plan.events).toEqual([{ type: 'suggested', matchId: r.id }]);
    expect(plan.updates[0]).toMatchObject({ status: 'Suggested', score: 70, rank: 1 });
  });

  it('Closed offer_expired: a Confirmed pair reopens Confirmed, a Suggested one reopens Suggested (offer_reactivated)', () => {
    const c = match({
      offerSetKey: 'a',
      status: 'Closed',
      closedReason: 'offer_expired',
      priorStatus: 'Confirmed',
      rank: null,
    });
    const s = match({
      offerSetKey: 'b',
      status: 'Closed',
      closedReason: 'offer_expired',
      priorStatus: 'Suggested',
      rank: null,
    });
    const plan = planMerge(
      d,
      [c, s],
      evals([
        ['a', pass(80)],
        ['b', pass(75)],
      ]),
      T,
    );
    expect(plan.events).toEqual([
      { type: 'reopened', matchId: c.id, reason: 'offer_reactivated' },
      { type: 'reopened', matchId: s.id, reason: 'offer_reactivated' },
    ]);
    expect(plan.updates.find((u) => u.id === c.id)).toMatchObject({
      status: 'Confirmed',
      closedReason: null,
      rank: null,
    });
    expect(plan.updates.find((u) => u.id === s.id)).toMatchObject({ status: 'Suggested', rank: 1 });
  });

  it('Closed demand_exited reopens as demand_reactivated once the demand is live again', () => {
    const s = match({
      offerSetKey: 'a',
      status: 'Closed',
      closedReason: 'demand_exited',
      priorStatus: 'Suggested',
      rank: null,
    });
    expect(planMerge(d, [s], evals([['a', pass(75)]]), T).events).toEqual([
      { type: 'reopened', matchId: s.id, reason: 'demand_reactivated' },
    ]);
  });

  it('Closed superseded is re-suggested when it re-enters the top N; other close reasons stay closed', () => {
    const sup = match({ offerSetKey: 'a', status: 'Closed', closedReason: 'superseded', rank: null });
    const deal = match({ offerSetKey: 'b', status: 'Closed', closedReason: 'deal_closed', rank: null });
    const plan = planMerge(
      d,
      [sup, deal],
      evals([
        ['a', pass(75)],
        ['b', pass(99)],
      ]),
      T,
    );
    expect(plan.events).toEqual([{ type: 'suggested', matchId: sup.id }]);
  });

  it('top-N: only topNPerDemand open suggestions; lower ones are closed superseded (never Confirmed)', () => {
    const existing = Array.from({ length: 20 }, (_, i) =>
      match({ offerSetKey: `x${String(i).padStart(2, '0')}`, score: 50 + i, rank: 20 - i }),
    );
    const confirmed = match({ offerSetKey: 'conf', status: 'Confirmed', rank: null, score: 41 });
    const e = new Map<string, PairEval>(existing.map((m) => [m.offerSetKey, pass(m.score)]));
    e.set('conf', pass(41));
    e.set('new1', pass(95));
    e.set('new2', pass(96));
    const plan = planMerge(d, [...existing, confirmed], e, T);
    expect(plan.inserts.map((i) => [i.offerSetKey, i.rank])).toEqual([
      ['new2', 1],
      ['new1', 2],
    ]);
    const closed = plan.events.filter((x) => x.type === 'closed');
    expect(closed).toEqual([
      { type: 'closed', matchId: existing[1]?.id, reason: 'superseded' },
      { type: 'closed', matchId: existing[0]?.id, reason: 'superseded' },
    ]);
    expect(plan.updates.find((u) => u.id === confirmed.id)).toBeUndefined();
  });

  it('a Stale demand keeps its matches up to date but gets no new suggestions', () => {
    const stale = demand({ lifeStage: 'Stale' });
    const m = match({ offerSetKey: 'a', score: 60 });
    const plan = planMerge(
      stale,
      [m],
      evals([
        ['a', pass(70)],
        ['b', pass(99)],
      ]),
      T,
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.updates[0]).toMatchObject({ score: 70 });
  });

  it('a demand that stops being matchable closes its open matches with the cause', () => {
    const open = [
      match({ offerSetKey: 'a' }),
      match({ offerSetKey: 'b', status: 'Confirmed' }),
      match({ offerSetKey: 'c', status: 'Rejected' }),
    ];
    const reasons = (dd: ReturnType<typeof demand>) =>
      planMerge(dd, open, new Map(), T).events.map((e) => (e.type === 'closed' ? e.reason : e.type));
    expect(reasons(demand({ exitType: 'Lost' }))).toEqual(['demand_exited', 'demand_exited']);
    expect(reasons(demand({ exitType: 'Dormant', lifeStage: 'Paused' }))).toEqual([
      'demand_exited',
      'demand_exited',
    ]);
    expect(reasons(demand({ commercialStatus: 'Closed' }))).toEqual(['demand_closed', 'demand_closed']);
    expect(reasons(demand({ voided: true }))).toEqual(['voided', 'voided']);
    expect(reasons(demand({ mergedInto: 'x' }))).toEqual(['merged', 'merged']);
  });

  it('existing matches without an evaluation are left alone but still count for the ranking', () => {
    const kept = match({ offerSetKey: 'bundle-x', score: 90, rank: 1, isBundle: true });
    const plan = planMerge(d, [kept], evals([['a', pass(95)]]), T);
    expect(plan.inserts[0]).toMatchObject({ offerSetKey: 'a', rank: 1 });
    expect(plan.updates[0]).toMatchObject({ id: kept.id, rank: 2 });
    expect(plan.events).toEqual([]);
  });
});

describe('staff actions', () => {
  it('confirm: Suggested → Confirmed; Confirmed unchanged; Rejected/Closed → invalid-match-status', () => {
    expect(confirmMatch(match())).toMatchObject({
      ok: true,
      changed: true,
      next: { status: 'Confirmed', rank: null },
    });
    expect(confirmMatch(match({ status: 'Confirmed' }))).toMatchObject({ ok: true, changed: false });
    expect(confirmMatch(match({ status: 'Rejected' }))).toEqual({ ok: false, code: 'invalid-match-status' });
    expect(confirmMatch(match({ status: 'Closed' }))).toEqual({ ok: false, code: 'invalid-match-status' });
  });
  it('reject: remembers score and facts version; Closed → invalid-match-status; open deal → match-in-deal', () => {
    expect(rejectMatch(match({ score: 64 }), false, 7)).toMatchObject({
      ok: true,
      next: { status: 'Rejected', rejectedScore: 64, rejectedFactsVersion: 7 },
    });
    expect(rejectMatch(match({ status: 'Confirmed' }), false, 1)).toMatchObject({ ok: true, changed: true });
    expect(rejectMatch(match({ status: 'Rejected' }), true, 1)).toMatchObject({ ok: true, changed: false });
    expect(rejectMatch(match({ status: 'Closed' }), false, 1)).toEqual({
      ok: false,
      code: 'invalid-match-status',
    });
    expect(rejectMatch(match({ status: 'Confirmed' }), true, 1)).toEqual({
      ok: false,
      code: 'match-in-deal',
    });
  });
});

describe('close causes (BRD §7 close propagation)', () => {
  it('offer Closed: Lease → leased_to_another_client; Sale / Pagdi / JV → sold_to_another_client', () => {
    expect(closeReasonForOfferClosed('Lease')).toBe('leased_to_another_client');
    expect(closeReasonForOfferClosed('Sale')).toBe('sold_to_another_client');
    expect(closeReasonForOfferClosed('Pagdi')).toBe('sold_to_another_client');
    expect(closeReasonForOfferClosed('JV')).toBe('sold_to_another_client');
  });
  it('offer cause by state', () => {
    expect(offerCloseCause(offer())).toBeNull();
    expect(offerCloseCause(offer({ lifeStage: 'Stale' }))).toBeNull();
    expect(offerCloseCause(offer({ lifeStage: 'Expired' }))).toBe('offer_expired');
    expect(offerCloseCause(offer({ commercialStatus: 'Inactive' }))).toBe('offer_retired');
    expect(offerCloseCause(offer({ commercialStatus: 'Closed', dealType: 'Sale' }))).toBe(
      'sold_to_another_client',
    );
    expect(offerCloseCause(offer({ voided: true }))).toBe('voided');
    expect(offerCloseCause(offer({ mergedInto: 'x' }))).toBe('merged');
  });
  it('demand cause by state', () => {
    expect(demandCloseCause(demand())).toBeNull();
    expect(demandCloseCause(demand({ lifeStage: 'Stale' }))).toBeNull();
    expect(demandCloseCause(demand({ exitType: 'Invalid' }))).toBe('demand_exited');
  });
});
