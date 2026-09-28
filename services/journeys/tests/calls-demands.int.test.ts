// JOU-04 (calls, 3-attempt rule, retire, R-12) and JOU-05 (qualify, exits, reactivate, dormant revisits), with the
// PRD Appendix B scenarios AS-S4, AS-D2 (exit part), AS-D3 and AS-D4.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import type { EventDataMap } from '@11e/contracts/events';
import { ensureMigrated, eventProblems, harness, ids } from './helpers.js';

const h = harness();
const supply = ids();
const demandAgent = ids();
const manager = ids();
beforeAll(async () => {
  await ensureMigrated();
  h.clock.day('2026-01-01');
  for (const [userId, role] of [
    [supply, 'Supply agent'],
    [demandAgent, 'Demand agent'],
    [manager, 'Manager'],
  ] as const)
    await h.deliver('user.changed.v1', { userId, role, active: true }, { aggregateId: userId });
});
afterAll(() => h.close());

let n = 0;
async function newOffer(o: Partial<EventDataMap['offer.created.v1']> = {}) {
  n++;
  const data: EventDataMap['offer.created.v1'] = {
    offerId: ids(),
    code: `INV-7${String(n).padStart(4, '0')}`,
    propertyId: ids(),
    dealType: 'Lease',
    segment: 'Commercial',
    propertyTypes: ['Office'],
    micromarket: 'Andheri East',
    rentMonthlyInrMin: 500000,
    ownerUserId: supply,
    ...o,
  };
  await h.deliver('offer.created.v1', data, { aggregateId: data.offerId });
  return data;
}
async function newDemand(d: Partial<EventDataMap['demand.created.v1']> = {}) {
  n++;
  const data: EventDataMap['demand.created.v1'] = {
    demandId: ids(),
    code: `DEM-00${String(n).padStart(4, '0')}`,
    dealTypes: ['Lease'],
    segment: 'Commercial',
    micromarkets: ['Powai'],
    rentMonthlyInrMax: 300000,
    ownerUserId: demandAgent,
    ...d,
  };
  await h.deliver('demand.created.v1', data, { aggregateId: data.demandId });
  return data;
}
const openItems = (subjectId: string) =>
  h.rows<{ section: string; reason: string; attempts: number; next_call_date: string | null }>(
    sql`select * from queue_items where tenant_id = ${h.tenantId} and subject_id = ${subjectId} and status = 'open' order by created_at`,
  );
const lastEvent = async (type: Parameters<typeof h.outbox>[0], aggregateId: string) =>
  (await h.outbox(type)).filter((e) => e.aggregate_id === aggregateId).at(-1)?.payload;

describe('offer calls (JOU-04)', () => {
  it('confirmed: curve reset, Should call answered, offer.confirmed.v1 + call.logged.v1', async () => {
    const o = await newOffer();
    h.clock.day('2026-02-05'); // day 35 → Ageing
    await h.runJob('life-curve-nightly');
    const me = await h.as(supply, 'Supply agent');
    const r = await me.post('/v1/calls', { subjectType: 'offer', subjectId: o.offerId, outcome: 'confirmed', notes: 'owner confirmed' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ commercialStatus: 'Available', personUnreachable: false, nextQueueItem: null });
    expect(r.body['call']).toMatchObject({ code: expect.stringMatching(/^CALL-\d{6}$/), attemptNo: 1, outcome: 'confirmed' });
    expect(r.body['lifeCurve']).toMatchObject({ stage: 'Fresh', dayCount: 0, lastConfirmedHow: 'call' });
    expect(await openItems(o.offerId)).toEqual([]);
    expect((await lastEvent('offer.confirmed.v1', o.offerId))?.['data']).toMatchObject({ how: 'call' });
    const logged = (await h.outbox('call.logged.v1')).at(-1)?.payload;
    expect(logged?.['data']).toMatchObject({ subjectType: 'offer', subjectId: o.offerId, outcome: 'confirmed', attempt: 1, calledBy: supply });
    expect(JSON.stringify(logged)).not.toContain('owner confirmed'); // notes are never in events
    expect(eventProblems(logged)).toBeNull();
  });

  it('3-attempt rule: two no-answers reschedule, the third closes the item and flags the person unreachable', async () => {
    h.clock.day('2026-02-06'); // a Friday
    const o = await newOffer();
    await h.deliver('enquiry.received.v1', { enquiryId: ids(), code: 'ENQ-0500', offerId: o.offerId }, { aggregateId: ids() });
    const me = await h.as(supply, 'Supply agent');
    const personId = ids();
    const first = await me.post('/v1/calls', { subjectType: 'offer', subjectId: o.offerId, personId, outcome: 'no_answer' });
    expect(first.body['call']).toMatchObject({ attemptNo: 1, nextCallDate: '2026-02-07' });
    expect((await openItems(o.offerId)).find((i) => i.section === 'must_call')).toMatchObject({ attempts: 1, next_call_date: '2026-02-07' });
    h.clock.day('2026-02-07');
    const second = await me.post('/v1/calls', { subjectType: 'offer', subjectId: o.offerId, personId, outcome: 'no_answer' });
    expect(second.body['call']).toMatchObject({ attemptNo: 2, nextCallDate: '2026-02-09' }); // Sunday skipped
    const third = await me.post('/v1/calls', { subjectType: 'offer', subjectId: o.offerId, personId, outcome: 'no_answer' });
    expect(third.body).toMatchObject({ personUnreachable: true });
    expect((await openItems(o.offerId)).map((i) => i.section)).toEqual(['should_call']);
    expect((await h.outbox('call.logged.v1')).at(-1)?.payload['data']).toMatchObject({ attempt: 3, personUnreachable: true, personId });
  });

  it('AS-S4: an Expired offer called as leased (₹5 L) → Inactive, offer.retired.v1 with the known price', async () => {
    h.clock.day('2026-01-01');
    const o = await newOffer();
    h.clock.day('2026-04-05'); // day 94 → Expired (lease commercial 30/60/90)
    await h.runJob('life-curve-nightly');
    const me = await h.as(supply, 'Supply agent');
    const r = await me.post('/v1/calls', { subjectType: 'offer', subjectId: o.offerId, outcome: 'already_gone', knownPriceInr: 500000 });
    expect(r.body['commercialStatus']).toBe('Inactive');
    expect((await lastEvent('offer.retired.v1', o.offerId))?.['data']).toEqual({ offerId: o.offerId, reason: 'already_gone', knownPriceInr: 500000 });
    expect((await lastEvent('offer.commercial_status_changed.v1', o.offerId))?.['data']).toMatchObject({ from: 'Available', to: 'Inactive' });
    expect(await openItems(o.offerId)).toEqual([]);
    const journey = await me.get(`/v1/offers/${o.code}/journey`);
    expect(journey.body).toMatchObject({ commercialStatus: 'Inactive', inactiveReason: 'already_gone' });
    expect((await me.post(`/v1/offers/${o.offerId}/retire`, { reason: 'other' })).body['code']).toBe('invalid-transition');

    // R-12: a later confirmed call reactivates the Inactive offer (status re-derived, curve restarted)
    const back = await me.post('/v1/calls', { subjectType: 'offer', subjectId: o.offerId, outcome: 'confirmed' });
    expect(back.body).toMatchObject({ commercialStatus: 'Available' });
    expect(back.body['lifeCurve']).toMatchObject({ stage: 'Fresh', dayCount: 0 });
  });

  it('retire endpoint (unwilling) and role rules', async () => {
    const o = await newOffer();
    const da = await h.as(demandAgent, 'Demand agent');
    expect((await da.post('/v1/calls', { subjectType: 'offer', subjectId: o.offerId, outcome: 'confirmed' })).status).toBe(403);
    expect((await (await h.as(ids(), 'Data operator')).post('/v1/calls', { subjectType: 'offer', subjectId: o.offerId, outcome: 'confirmed' })).status).toBe(403);
    const me = await h.as(supply, 'Supply agent');
    const r = await me.post(`/v1/offers/${o.code}/retire`, { reason: 'unwilling' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ commercialStatus: 'Inactive', inactiveReason: 'unwilling' });
    expect((await h.outbox('audit.recorded.v1')).some((e) => e.payload.data['action'] === 'offer.retired')).toBe(true);
  });

  it('lists calls by subject / logger (loggedAt desc) and requires a filter', async () => {
    const me = await h.as(manager, 'Manager');
    expect((await me.get('/v1/calls')).status).toBe(400);
    const mine = await me.get(`/v1/calls?loggedBy=${supply}&limit=2`);
    expect(mine.body.items).toHaveLength(2);
    const next = await me.get(`/v1/calls?loggedBy=${supply}&limit=2&cursor=${mine.body.nextCursor}`);
    expect(next.body.items?.[0]?.['loggedAt'] <= mine.body.items?.[1]?.['loggedAt']).toBe(true);
  });
});

describe('demand journey (JOU-05)', () => {
  it('New → Contacted on the first confirmed call (+ to_qualify) → Active on qualify (demand.qualified.v1)', async () => {
    h.clock.day('2026-03-01');
    const d = await newDemand();
    const da = await h.as(demandAgent, 'Demand agent');
    expect((await da.post('/v1/calls', { subjectType: 'demand', subjectId: d.demandId, outcome: 'already_gone' })).body['code']).toBe(
      'outcome-not-allowed',
    );
    const call = await da.post('/v1/calls', { subjectType: 'demand', subjectId: d.demandId, outcome: 'confirmed' });
    expect(call.body['commercialStatus']).toBe('Contacted');
    expect((await openItems(d.demandId)).map((i) => i.section)).toEqual(['to_qualify']);
    const incomplete = await da.post(`/v1/demands/${d.code}/qualify`, {
      checklist: { decisionMakerReached: true, budgetConfirmed: true, timingConfirmed: false, agreesToWork: true },
    });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body['code']).toBe('qualification-incomplete');
    const q = await da.post(`/v1/demands/${d.code}/qualify`, {
      checklist: { decisionMakerReached: true, budgetConfirmed: true, timingConfirmed: true, agreesToWork: true, decisionMakerNote: 'CFO' },
    });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ commercialStatus: 'Active', qualification: { agreesToWork: true } });
    expect(await openItems(d.demandId)).toEqual([]);
    expect(await lastEvent('demand.qualified.v1', d.demandId)).toBeDefined();
    expect((await lastEvent('demand.confirmed.v1', d.demandId))?.['data']).toMatchObject({ how: 'qualification' });
    const statuses = (await h.outbox('demand.status_changed.v1')).filter((e) => e.aggregate_id === d.demandId).map((e) => e.payload.data['to']);
    expect(statuses).toEqual(['New', 'Contacted', 'Active']);
  });

  it('AS-D4 unreachable: three unanswered calls → unreachable, to_contact (unreachable); Invalid exit by the agent', async () => {
    const d = await newDemand();
    const da = await h.as(demandAgent, 'Demand agent');
    const personId = ids();
    for (let i = 0; i < 3; i++) await da.post('/v1/calls', { subjectType: 'demand', subjectId: d.demandId, personId, outcome: 'no_answer' });
    expect(await openItems(d.demandId)).toMatchObject([{ section: 'to_contact', reason: 'unreachable' }]);
    expect((await da.get(`/v1/demands/${d.demandId}/journey`)).body).toMatchObject({ unreachable: true, exit: null });
    const exit = await da.post(`/v1/demands/${d.demandId}/exit`, { type: 'Invalid', reasonCode: 'unreachable', flagPerson: true, personId });
    expect(exit.status).toBe(200);
    expect(exit.body['exit']).toMatchObject({ type: 'Invalid', reasonCode: 'unreachable', flagPerson: true, personId });
    expect((await lastEvent('demand.exited.v1', d.demandId))?.['data']).toEqual({
      demandId: d.demandId,
      exit: 'Invalid',
      reason: 'unreachable',
      flagPerson: true,
      personId,
    });
    expect(await openItems(d.demandId)).toEqual([]);
    const [curve] = await h.rows<{ frozen: boolean }>(sql`select frozen from life_curve where subject_id = ${d.demandId}`);
    expect(curve?.frozen).toBe(true);
    // Lost / Invalid reactivation is an exit override: Admin/Manager only
    expect((await da.post(`/v1/demands/${d.demandId}/reactivate`, {})).status).toBe(403);
    const mgr = await h.as(manager, 'Manager');
    const back = await mgr.post(`/v1/demands/${d.demandId}/reactivate`, { reason: 'number corrected' });
    expect(back.body).toMatchObject({ exit: null, unreachable: false });
    expect(back.body['lifeCurve']).toMatchObject({ stage: 'Fresh', dayCount: 0 });
    expect(await lastEvent('demand.reactivated.v1', d.demandId)).toBeDefined();
  });

  it('AS-D2 exit: Lost with competing terms carries the terms and price (records stores them as market data)', async () => {
    const d = await newDemand();
    const da = await h.as(demandAgent, 'Demand agent');
    expect((await da.post(`/v1/demands/${d.demandId}/exit`, { type: 'Lost' })).status).toBe(400);
    const r = await da.post(`/v1/demands/${d.demandId}/exit`, {
      type: 'Lost',
      reasonCode: 'closed_elsewhere',
      reason: 'went with another broker',
      competingTerms: 'Powai, 2 months rent free',
      competingPriceInr: 280000,
    });
    expect(r.status).toBe(200);
    const ev = (await lastEvent('demand.exited.v1', d.demandId))?.['data'];
    expect(ev).toEqual({ demandId: d.demandId, exit: 'Lost', reason: 'closed_elsewhere', competingTerms: 'Powai, 2 months rent free', competingPriceInr: 280000 });
    expect((await da.post(`/v1/demands/${d.demandId}/exit`, { type: 'Dormant' })).body['code']).toBe('invalid-transition');
    expect((await da.post(`/v1/demands/${d.demandId}/qualify`, { checklist: { decisionMakerReached: true, budgetConfirmed: true, timingConfirmed: true, agreesToWork: true } })).status).toBe(409);
  });

  it('AS-D3: Ageing at day 31 → reconfirm; Dormant until 1 Mar; the revisit returns it to the queue; reactivation', async () => {
    h.clock.day('2026-10-01');
    const d = await newDemand({ dealTypes: ['Sale'], segment: 'Residential', market: 'Secondary', budgetInrMax: 30_000_000 });
    const da = await h.as(demandAgent, 'Demand agent');
    await da.post('/v1/calls', { subjectType: 'demand', subjectId: d.demandId, outcome: 'confirmed' });
    await da.post(`/v1/demands/${d.demandId}/qualify`, { checklist: { decisionMakerReached: true, budgetConfirmed: true, timingConfirmed: true, agreesToWork: true } });
    h.clock.day('2026-11-16'); // day 46 of sale_secondary_any (45/90/150) → Ageing
    await h.runJob('life-curve-nightly');
    expect((await openItems(d.demandId)).map((i) => i.section)).toEqual(['reconfirm_due']);
    const exit = await da.post(`/v1/demands/${d.demandId}/exit`, { type: 'Dormant', reasonCode: 'postponed', revisitDate: '2027-03-01' });
    expect(exit.body['exit']).toMatchObject({ type: 'Dormant', revisitDate: '2027-03-01' });
    expect(exit.body['lifeCurve']).toMatchObject({ stage: 'Paused', pausedUntil: '2027-03-01' });
    expect(await openItems(d.demandId)).toEqual([]);
    h.clock.day('2027-02-28');
    await h.runJob('dormant-revisit');
    expect(await openItems(d.demandId)).toEqual([]);
    h.clock.day('2027-03-01');
    await h.runJob('dormant-revisit');
    await h.runJob('dormant-revisit'); // same day again: no duplicate
    expect(await openItems(d.demandId)).toMatchObject([{ section: 'dormant_revisits', reason: 'revisit' }]);
    // a confirmed call on a Dormant demand reactivates it
    const call = await da.post('/v1/calls', { subjectType: 'demand', subjectId: d.demandId, outcome: 'confirmed' });
    expect(call.body['commercialStatus']).toBe('Active');
    expect(call.body['lifeCurve']).toMatchObject({ stage: 'Fresh', dayCount: 0 });
    expect(await openItems(d.demandId)).toEqual([]);
    const stages = (await h.outbox('lifecycle.stage_changed.v1')).filter((e) => e.aggregate_id === d.demandId).map((e) => e.payload.data['to']);
    expect(stages).toEqual(['Ageing', 'Paused', 'Fresh']);
  });

  it('life curve by code and journey reads; every produced event matches AsyncAPI', async () => {
    const d = await newDemand();
    const op = await h.as(ids(), 'Data operator');
    expect((await op.get(`/v1/life-curves/demand/${d.code}`)).body).toMatchObject({ subjectId: d.demandId, categoryKey: 'demand.lease_commercial', stage: 'Fresh' });
    expect((await op.get(`/v1/life-curves/offer/${d.demandId}`)).status).toBe(404);
    expect((await op.get(`/v1/demands/${d.code}/journey`)).body).toMatchObject({ commercialStatus: 'New', ownerUserId: demandAgent });
    for (const e of await h.outbox()) expect(eventProblems(e.payload)).toBeNull();
  });
});
