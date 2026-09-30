// Unit tests for the journeys (P-01, C-08…C-17) and crm-engine (C-10) card rules: queue section → team / label /
// action, call outcome → POST /v1/calls payload with the next-call date rules, deal required fields, exit variants,
// score band thresholds and the bundle payload.
import { describe, expect, it } from 'vitest';
import {
  actionFor,
  addDays,
  buildCallBody,
  buildDealCreate,
  buildDealPatch,
  buildExit,
  buildFeedback,
  feedbackLabel,
  buildProposal,
  buildReassign,
  buildRetire,
  buildSourcing,
  buildVisit,
  canQualify,
  canReactivate,
  changedOnly,
  defaultNextCallDate,
  defaultRevisit,
  dueChip,
  exitTypeFromText,
  followUpErrors,
  groupSections,
  istDateTimeToIso,
  nextWorkingDay,
  outcomesFor,
  priceFieldFor,
  sectionMeta,
  sectionTone,
  SECTIONS,
  stagesFrom,
  subjectOfCode,
  todayIst,
  visitResetNote,
} from '@/ui/cards/journeys/logic';
import type { QueueItem } from '@/ui/cards/journeys/logic';
import {
  buildBundle,
  bundleable,
  canBundle,
  canDecide,
  factorChip,
  flagChip,
  HI_SCORE,
  matchTitle,
  scoreBand,
} from '@/ui/cards/engine/logic';

const TODAY = '2026-09-28'; // a Monday
const DEM = '11111111-1111-4111-8111-111111111111';
const OFF = '22222222-2222-4222-8222-222222222222';

const item = (over: Partial<QueueItem>): QueueItem => ({
  id: 'q1',
  section: 'must_call',
  subjectType: 'offer',
  subjectId: OFF,
  subjectCode: 'INV-00452',
  reason: 'enquiry',
  status: 'open',
  ...over,
});

describe('queue sections (P-01)', () => {
  it('maps every §4.2 section to supply and every §4.3 section to demand', () => {
    for (const s of ['must_call', 'should_call', 'sourcing_requests', 'watchlist_tasks'] as const)
      expect(SECTIONS[s].team).toBe('supply');
    for (const s of [
      'to_contact',
      'to_qualify',
      'reconfirm_due',
      'needs_sourcing',
      'in_sourcing',
      'sourcing_requests_open',
      'open_matches',
      'proposals_out',
      'site_visits_this_week',
      'deals_follow_up',
      'dormant_revisits',
    ] as const)
      expect(SECTIONS[s].team).toBe('demand');
  });

  it('labels sections as in the PRD and tolerates unknown ones', () => {
    expect(sectionMeta('must_call').label).toBe('Must call');
    expect(sectionMeta('should_call').label).toContain('planned today');
    expect(sectionMeta('brand_new_section', 'supply')).toEqual({ label: 'Brand new section', team: 'supply', order: 99 });
  });

  it('groups supply before demand, each in PRD order', () => {
    const groups = groupSections([
      { section: 'open_matches', team: 'demand', count: 2 },
      { section: 'should_call', team: 'supply', count: 9 },
      { section: 'to_contact', team: 'demand', count: 1 },
      { section: 'must_call', team: 'supply', count: 3 },
    ]);
    expect(groups.map((g) => g.team)).toEqual(['supply', 'demand']);
    expect(groups[0]?.sections.map((s) => s.section)).toEqual(['must_call', 'should_call']);
    expect(groups[1]?.sections.map((s) => s.section)).toEqual(['to_contact', 'open_matches']);
  });

  it('colours the header chip by overdue, then by count', () => {
    expect(sectionTone({ count: 3, overdue: 1 })).toBe('bad');
    expect(sectionTone({ count: 3, overdue: 0 })).toBe('warn');
    expect(sectionTone({ count: 0 })).toBe('plain');
  });
});

describe('queue item → action card', () => {
  it('call reasons open a call-outcome card on the offer or demand code', () => {
    expect(actionFor(item({ reason: 'enquiry' }))).toEqual({ kind: 'call-outcome', label: 'Log call', props: { code: 'INV-00452' } });
    expect(actionFor(item({ section: 'should_call', reason: 'reconfirm' }))?.kind).toBe('call-outcome');
    expect(
      actionFor(item({ section: 'to_contact', subjectType: 'demand', subjectCode: 'DEM-000127', reason: 'first_contact' }))?.props,
    ).toEqual({ code: 'DEM-000127' });
    expect(
      actionFor(item({ section: 'dormant_revisits', subjectType: 'demand', subjectCode: 'DEM-000127', reason: 'revisit' }))?.kind,
    ).toBe('call-outcome');
  });

  it('demand work opens qualify / matches / sourcing / proposal / site-visit / deal on the demand', () => {
    const dem = { subjectType: 'demand' as const, subjectCode: 'DEM-000127' };
    expect(actionFor(item({ ...dem, section: 'to_qualify', reason: 'qualify' }))).toMatchObject({ kind: 'qualify', props: { demand: 'DEM-000127' } });
    expect(actionFor(item({ ...dem, section: 'open_matches', reason: 'open_matches' }))?.kind).toBe('matches');
    expect(actionFor(item({ ...dem, section: 'needs_sourcing', reason: 'no_matches' }))?.kind).toBe('sourcing');
    const viaDemandId = { subjectType: 'deal' as const, subjectCode: 'DEAL-0007', demandId: DEM };
    expect(actionFor(item({ ...viaDemandId, section: 'deals_follow_up', reason: 'follow_up' }))).toMatchObject({
      kind: 'deal',
      props: { demand: DEM },
    });
    expect(actionFor(item({ ...viaDemandId, subjectType: 'proposal', section: 'proposals_out', reason: 'proposal_feedback' }))?.kind).toBe(
      'proposal',
    );
    expect(actionFor(item({ ...viaDemandId, subjectType: 'site_visit', section: 'site_visits_this_week', reason: 'visit' }))?.kind).toBe(
      'site-visit',
    );
  });

  it('sourcing requests open add-supply for the demand; watchlist tasks only open the record', () => {
    expect(
      actionFor(item({ section: 'sourcing_requests', subjectType: 'sourcing_request', subjectCode: 'SRQ-014', reason: 'srq', demandId: DEM })),
    ).toEqual({ kind: 'add-supply', label: 'Add supply', props: { demand: DEM } });
    expect(actionFor(item({ section: 'watchlist_tasks', subjectType: 'watchlist_task', subjectCode: 'WCH-0003', reason: 'watchlist' }))).toBeNull();
  });

  it('falls back by section and gives up without a demand', () => {
    expect(actionFor(item({ section: 'in_sourcing', subjectType: 'demand', subjectCode: 'DEM-9', reason: 'srq', demandId: null }))).toBeNull();
    expect(actionFor(item({ section: 'deals_follow_up', subjectType: 'deal', subjectCode: 'DEAL-1', reason: 'follow_up', demandId: null }))).toBeNull();
  });

  it('shows overdue first, then due, then the next call date', () => {
    const now = Date.parse('2026-09-28T10:00:00Z');
    expect(dueChip({ overdue: true, dueAt: '2026-09-27T10:00:00Z' }, now)).toEqual({ tone: 'bad', text: 'overdue · due yesterday' });
    expect(dueChip({ overdue: false, dueAt: '2026-09-28T15:00:00Z' }, now)?.tone).toBe('warn');
    expect(dueChip({ overdue: false, dueAt: '2026-10-05T10:00:00Z' }, now)?.tone).toBe('plain');
    expect(dueChip({ nextCallDate: '2026-10-01' }, now)?.text).toMatch(/^next call /);
    expect(dueChip({}, now)).toBeNull();
  });

  it('reassigns 1–100 distinct items to a chosen user', () => {
    expect(buildReassign(['a', 'a', 'b'], 'u')).toEqual({ body: { queueItemIds: ['a', 'b'], assigneeUserId: 'u' } });
    expect(buildReassign([], 'u')).toHaveProperty('errors');
    expect(buildReassign(['a'], null)).toHaveProperty('errors');
    expect(buildReassign(Array.from({ length: 101 }, (_, i) => `i${i}`), 'u')).toHaveProperty('errors');
  });
});

describe('dates', () => {
  it('computes IST today, adds days and skips Sunday for the next working day', () => {
    expect(todayIst(new Date('2026-09-27T20:00:00Z'))).toBe('2026-09-28'); // 01:30 IST next day
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(nextWorkingDay('2026-09-28')).toBe('2026-09-29'); // Mon → Tue
    expect(nextWorkingDay('2026-10-03')).toBe('2026-10-05'); // Sat → Mon
  });

  it('reads datetime-local as India time', () => {
    expect(istDateTimeToIso('2026-10-01T15:30')).toBe('2026-10-01T15:30:00+05:30');
    expect(istDateTimeToIso('')).toBeNull();
  });
});

describe('call outcome (C-08) → POST /v1/calls', () => {
  const base = { subjectType: 'offer' as const, subjectId: OFF };

  it('offers take four outcomes, demands two; codes tell the subject', () => {
    expect(outcomesFor('offer')).toEqual(['confirmed', 'no_answer', 'already_gone', 'unwilling']);
    expect(outcomesFor('demand')).toEqual(['confirmed', 'no_answer']);
    expect(subjectOfCode('inv-00452')).toBe('offer');
    expect(subjectOfCode('DEM-000127')).toBe('demand');
    expect(subjectOfCode('PRJ-0001')).toBeNull();
    expect(buildCallBody({ subjectType: 'demand', subjectId: DEM, outcome: 'already_gone' }, TODAY)).toHaveProperty('errors');
  });

  it('confirmed: queue item, notes, availableNow only for offers', () => {
    expect(
      buildCallBody({ ...base, outcome: 'confirmed', queueItemId: 'q1', notes: '  available at 8.5L ', availableNow: true }, TODAY),
    ).toEqual({
      body: { ...base, outcome: 'confirmed', channel: 'call', queueItemId: 'q1', notes: 'available at 8.5L', availableNow: true },
    });
    const dem = buildCallBody({ subjectType: 'demand', subjectId: DEM, outcome: 'confirmed', availableNow: true }, TODAY);
    expect(dem).toEqual({ body: { subjectType: 'demand', subjectId: DEM, outcome: 'confirmed', channel: 'call' } });
  });

  it('no answer: prefilled to the next working day, must be after today; empty lets journeys default it', () => {
    expect(defaultNextCallDate('no_answer', '2026-10-03')).toBe('2026-10-05');
    expect(defaultNextCallDate('confirmed', TODAY)).toBeNull();
    expect(buildCallBody({ ...base, outcome: 'no_answer', nextCallDate: '2026-09-29' }, TODAY)).toMatchObject({
      body: { nextCallDate: '2026-09-29' },
    });
    expect(buildCallBody({ ...base, outcome: 'no_answer', nextCallDate: TODAY }, TODAY)).toHaveProperty('errors');
    expect(buildCallBody({ ...base, outcome: 'no_answer', nextCallDate: '' }, TODAY)).toEqual({
      body: { ...base, outcome: 'no_answer', channel: 'call' },
    });
  });

  it('confirmed accepts today or later, never the past', () => {
    expect(buildCallBody({ ...base, outcome: 'confirmed', nextCallDate: TODAY }, TODAY)).toHaveProperty('body');
    expect(buildCallBody({ ...base, outcome: 'confirmed', nextCallDate: '2026-09-01' }, TODAY)).toHaveProperty('errors');
    expect(buildCallBody({ ...base, outcome: 'confirmed', nextCallDate: 'soon' }, TODAY)).toHaveProperty('errors');
  });

  it('already gone / unwilling drop the next call date; known price only when already gone', () => {
    expect(buildCallBody({ ...base, outcome: 'already_gone', nextCallDate: '2026-01-01', knownPriceInr: 850000 }, TODAY)).toEqual({
      body: { ...base, outcome: 'already_gone', channel: 'call', knownPriceInr: 850000 },
    });
    expect(buildCallBody({ ...base, outcome: 'unwilling', knownPriceInr: 850000 }, TODAY)).toEqual({
      body: { ...base, outcome: 'unwilling', channel: 'call' },
    });
  });

  it('sends only the changed facts, in the price field of the deal type', () => {
    expect(priceFieldFor('Lease')).toBe('rentMonthlyInrMin');
    expect(priceFieldFor('Sale')).toBe('salePriceInrMin');
    expect(
      changedOnly<Record<string, unknown>>(
        { rentMonthlyInrMin: 800000, possessionStatus: 'Ready', possessionDate: null },
        { rentMonthlyInrMin: 850000, possessionStatus: 'Ready', possessionDate: '' },
      ),
    ).toEqual({ rentMonthlyInrMin: 850000 });
    expect(changedOnly<Record<string, unknown>>({ areaSqftMin: 5000 }, { areaSqftMin: null })).toEqual({ areaSqftMin: null });
  });
});

describe('qualify, sourcing, proposal, visit', () => {
  it('qualifies only with all four checklist items', () => {
    expect(canQualify({ decisionMakerReached: true, budgetConfirmed: true, timingConfirmed: true, agreesToWork: false })).toBe(false);
    expect(canQualify({ decisionMakerReached: true, budgetConfirmed: true, timingConfirmed: true, agreesToWork: true })).toBe(true);
  });

  it('builds a sourcing request with assignee, due date not in the past and priority', () => {
    const ok = buildSourcing({ demandId: DEM, assigneeUserId: 'u1', dueDate: '2026-10-01', priority: 'High', postAnonymously: true }, TODAY);
    expect(ok).toEqual({ body: { demandId: DEM, assigneeUserId: 'u1', dueDate: '2026-10-01', priority: 'High', postAnonymously: true } });
    const bad = buildSourcing({ demandId: DEM, assigneeUserId: null, dueDate: '2026-09-01', priority: 'Urgent', postAnonymously: false }, TODAY);
    expect('errors' in bad && bad.errors).toHaveLength(3);
  });

  it('numbers proposal options in pick order and caps at 20', () => {
    expect(buildProposal(DEM, ['m2', 'm1', 'm2'], ' ')).toEqual({
      body: { demandId: DEM, options: [{ matchId: 'm2', position: 1 }, { matchId: 'm1', position: 2 }] },
    });
    expect(buildProposal(DEM, [])).toHaveProperty('errors');
    expect(buildProposal(DEM, Array.from({ length: 21 }, (_, i) => `m${i}`))).toHaveProperty('errors');
  });

  it('sends "maybe" feedback like the other verdicts (CR-012) and skips options without a verdict', () => {
    const r = buildFeedback([
      { position: 1, feedback: 'liked', note: 'good light' },
      { position: 2, feedback: 'maybe' },
      { position: 3, feedback: null },
    ]);
    expect(r).toEqual({ body: { options: [{ position: 1, feedback: 'liked', note: 'good light' }, { position: 2, feedback: 'maybe' }] } });
    expect(buildFeedback([{ position: 1, feedback: 'maybe' }])).toEqual({ body: { options: [{ position: 1, feedback: 'maybe' }] } });
    expect(buildFeedback([{ position: 1, feedback: null }])).toHaveProperty('errors');
    expect(feedbackLabel('maybe')).toBe('Maybe');
    expect(feedbackLabel('visit_requested')).toBe('Wants a site visit');
  });

  it('schedules a visit with 1–10 offers and an IST time', () => {
    expect(buildVisit({ demandId: DEM, offerIds: [OFF, OFF], scheduledLocal: '2026-10-01T11:00', attendeeUserIds: [] })).toEqual({
      body: { demandId: DEM, offerIds: [OFF], scheduledAt: '2026-10-01T11:00:00+05:30' },
    });
    expect(buildVisit({ demandId: DEM, offerIds: [], scheduledLocal: '', attendeeUserIds: [] })).toHaveProperty('errors');
    expect(visitResetNote(null)).toContain('both life curves');
    expect(visitResetNote('Client no-show')).toContain("demand's does not");
  });
});

describe('deal (C-15): next action + follow-up date required', () => {
  const terms = { rentMonthlyInr: '8,50,000', leaseMonths: '11', otherTerms: ' 2 months rent free ' };

  it('requires next action and a follow-up date from today on', () => {
    expect(followUpErrors('', '', TODAY)).toEqual(['Next action is required.', 'Follow-up date is required.']);
    expect(followUpErrors('Send term sheet', '2026-09-27', TODAY)).toEqual(['The follow-up date cannot be in the past.']);
    expect(followUpErrors('Send term sheet', TODAY, TODAY)).toEqual([]);
  });

  it('opens a deal with parsed terms', () => {
    expect(
      buildDealCreate({ demandId: DEM, offerId: OFF, matchId: 'm1', terms, nextAction: 'Send term sheet', followUpDate: '2026-10-02' }, TODAY),
    ).toEqual({
      body: {
        demandId: DEM,
        offerId: OFF,
        matchId: 'm1',
        agreedTerms: { rentMonthlyInr: 850000, leaseMonths: 11, otherTerms: '2 months rent free' },
        nextAction: 'Send term sheet',
        followUpDate: '2026-10-02',
      },
    });
    const missing = buildDealCreate({ demandId: DEM, offerId: null, terms: {}, nextAction: ' ', followUpDate: '' }, TODAY);
    expect('errors' in missing && missing.errors).toEqual(['Choose the offer.', 'Next action is required.', 'Follow-up date is required.']);
  });

  it('moves stages forward only and needs the closing price (and lease months) to close', () => {
    expect(stagesFrom('Documentation')).toEqual(['Documentation', 'Stamp duty & registration', 'Closed']);
    const back = buildDealPatch(
      { currentStage: 'Documentation', stage: 'Negotiation', nextAction: 'x', followUpDate: TODAY, terms: {} },
      TODAY,
    );
    expect(back).toHaveProperty('errors');
    const close = buildDealPatch(
      { currentStage: 'Stamp duty & registration', stage: 'Closed', nextAction: '', followUpDate: '', isLease: true, terms: {} },
      TODAY,
    );
    expect('errors' in close && close.errors).toEqual([
      'Closing price is required to close the deal.',
      'Lease months are required to close a lease.',
    ]);
    expect(
      buildDealPatch(
        { currentStage: 'Stamp duty & registration', stage: 'Closed', nextAction: '', followUpDate: '', closingPriceInr: '850000', isLease: true, terms: { leaseMonths: '11' } },
        TODAY,
      ),
    ).toEqual({ body: { stage: 'Closed', agreedTerms: { leaseMonths: 11 }, closingPriceInr: 850000 } });
    expect(
      buildDealPatch({ currentStage: 'Negotiation', stage: 'Negotiation', nextAction: 'Call lawyer', followUpDate: '2026-10-01', terms: {} }, TODAY),
    ).toEqual({ body: { nextAction: 'Call lawyer', followUpDate: '2026-10-01' } });
  });
});

describe('exit (C-16) variants', () => {
  it('Lost needs a reason and keeps competing terms / price', () => {
    expect(buildExit({ type: 'Lost', reasonCode: null }, TODAY)).toHaveProperty('errors');
    expect(
      buildExit({ type: 'Lost', reasonCode: 'closed_elsewhere', competingTerms: 'Powai, 2 months rent free', competingPrice: '9,00,000', revisitDate: '2027-01-01' }, TODAY),
    ).toEqual({
      body: { type: 'Lost', flagPerson: false, reasonCode: 'closed_elsewhere', competingTerms: 'Powai, 2 months rent free', competingPriceInr: 900000 },
    });
  });

  it('Dormant defaults the revisit to today + 60 and rejects past dates', () => {
    expect(defaultRevisit(TODAY)).toBe('2026-11-27');
    expect(buildExit({ type: 'Dormant', reasonCode: null, competingTerms: 'ignored' }, TODAY)).toEqual({
      body: { type: 'Dormant', flagPerson: false, revisitDate: '2026-11-27' },
    });
    expect(buildExit({ type: 'Dormant', reasonCode: 'postponed', revisitDate: TODAY }, TODAY)).toHaveProperty('errors');
    expect(buildExit({ type: 'Dormant', reasonCode: 'fake_details' }, TODAY)).toHaveProperty('errors');
  });

  it('Invalid needs a reason; flagging needs the linked person', () => {
    expect(buildExit({ type: 'Invalid', reasonCode: 'broker_posing', flagPerson: true, personId: null }, TODAY)).toHaveProperty('errors');
    expect(buildExit({ type: 'Invalid', reasonCode: 'broker_posing', flagPerson: true, personId: 'p1' }, TODAY)).toEqual({
      body: { type: 'Invalid', flagPerson: true, reasonCode: 'broker_posing', personId: 'p1' },
    });
  });

  it('reads the exit type from the typed text and gates reactivation', () => {
    expect(exitTypeFromText('client postponed to April')).toBe('Dormant');
    expect(exitTypeFromText('mark lost, signed elsewhere')).toBe('Lost');
    expect(exitTypeFromText('invalid: broker posing')).toBe('Invalid');
    expect(exitTypeFromText('hello')).toBeNull();
    expect(canReactivate('Dormant', 'Demand agent')).toBe(true);
    expect(canReactivate('Lost', 'Demand agent')).toBe(false);
    expect(canReactivate('Invalid', 'Manager')).toBe(true);
  });
});

describe('retire (C-17)', () => {
  it('needs a reason; the known price goes with it', () => {
    expect(buildRetire({ reason: null })).toHaveProperty('errors');
    expect(buildRetire({ reason: 'already_gone', knownPrice: '1,10,00,000', note: '' })).toEqual({
      body: { reason: 'already_gone', knownPriceInr: 11000000 },
    });
  });
});

describe('matches (C-10)', () => {
  it(`bands scores: hi from ${HI_SCORE}, mid below`, () => {
    expect(scoreBand(100)).toBe('hi');
    expect(scoreBand(80)).toBe('hi');
    expect(scoreBand(79)).toBe('mid');
    expect(scoreBand(0)).toBe('mid');
    expect(scoreBand(null)).toBe('mid');
  });

  it('labels flags and factors with text, not colour alone', () => {
    expect(flagChip('reconfirm')).toEqual({ text: 'Stale: reconfirm', tone: 'warn' });
    expect(flagChip('price_above_budget').tone).toBe('bad');
    expect(flagChip('new_flag')).toEqual({ text: 'new flag', tone: 'warn' });
    expect(factorChip({ factor: 'price', value: 0.9, points: 27.4 })).toEqual({ text: 'Price ✔ 27', tone: 'good' });
    expect(factorChip({ factor: 'area', value: 0.4, points: 8 }).tone).toBe('warn');
    expect(factorChip({ factor: 'bhk', value: 0, points: 0, applicable: false })).toEqual({ text: 'BHK n/a', tone: 'plain' });
  });

  it('lets the demand team decide; Supply agents only suggest bundles', () => {
    expect(canDecide('Demand agent')).toBe(true);
    expect(canDecide('Supply agent')).toBe(false);
    expect(canBundle('Supply agent')).toBe(true);
    expect(canBundle('Data operator')).toBe(false);
  });

  it('bundles 2–3 distinct live single offers; Supply agents cannot confirm', () => {
    expect(bundleable({ isBundle: false, status: 'Suggested', offerIds: [OFF] })).toBe(true);
    expect(bundleable({ isBundle: true, status: 'Suggested', offerIds: [OFF, 'b'] })).toBe(false);
    expect(bundleable({ isBundle: false, status: 'Rejected', offerIds: [OFF] })).toBe(false);
    expect(buildBundle(DEM, ['a', 'b', 'a'], true, 'Demand agent')).toEqual({ body: { demandId: DEM, offerIds: ['a', 'b'], confirm: true } });
    expect(buildBundle(DEM, ['a', 'b'], true, 'Supply agent')).toEqual({ body: { demandId: DEM, offerIds: ['a', 'b'], confirm: false } });
    expect(buildBundle(DEM, ['a'], false, 'Manager')).toHaveProperty('errors');
    expect(buildBundle(DEM, ['a', 'b', 'c', 'd'], false, 'Manager')).toHaveProperty('errors');
    expect(buildBundle(null, ['a', 'b'], false, 'Manager')).toHaveProperty('errors');
  });

  it('titles a match by its offers, or by the demand when listed for an offer', () => {
    expect(matchTitle({ offerCodes: ['INV-1', 'INV-2'], offerIds: ['a', 'b'], code: 'MAT-1' }, 'demand')).toBe('INV-1 + INV-2');
    expect(matchTitle({ offerIds: ['a'], code: 'MAT-1' }, 'demand')).toBe('1 offer');
    expect(matchTitle({ offerIds: ['a'], code: 'MAT-1' }, 'offer', 'DEM-7')).toBe('DEM-7');
  });
});
