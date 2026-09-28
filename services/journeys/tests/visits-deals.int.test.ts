// JOU-08: site visits (both life curves), deals (mandatory follow-ups, forward-only stages, close in one transaction,
// cancel compensation), lease renewal at month 10, multi-unit bookings — AS-D1 end to end, AS-S6 booking.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import type { EventDataMap } from '@11e/contracts/events';
import { buildSnapshot } from '../src/application/proposals.js';
import { ensureMigrated, eventProblems, harness, ids } from './helpers.js';

const h = harness();
const supply = ids();
const demandAgent = ids();
const manager = ids();
beforeAll(async () => {
  await ensureMigrated();
  h.clock.day('2026-05-04');
  for (const [userId, role] of [
    [supply, 'Supply agent'],
    [demandAgent, 'Demand agent'],
    [manager, 'Manager'],
  ] as const)
    await h.deliver('user.changed.v1', { userId, role, active: true }, { aggregateId: userId });
});
afterAll(() => h.close());

let n = 0;
async function offer(o: Partial<EventDataMap['offer.created.v1']> = {}) {
  n++;
  const d: EventDataMap['offer.created.v1'] = {
    offerId: ids(),
    code: `INV-8${String(n).padStart(4, '0')}`,
    propertyId: ids(),
    dealType: 'Lease',
    segment: 'Commercial',
    propertyTypes: ['Office'],
    micromarket: 'Marol',
    rentMonthlyInrMin: 300000,
    ownerUserId: supply,
    ...o,
  };
  await h.deliver('offer.created.v1', d, { aggregateId: d.offerId });
  h.content.offers.set(d.offerId, { id: d.offerId, dealType: d.dealType, propertyId: d.propertyId, micromarket: 'Marol', propertyTypes: ['Office'] });
  return d;
}
async function demand(d: Partial<EventDataMap['demand.created.v1']> = {}) {
  n++;
  const data: EventDataMap['demand.created.v1'] = {
    demandId: ids(),
    code: `DEM-000${String(n).padStart(3, '0')}`,
    dealTypes: ['Lease'],
    segment: 'Commercial',
    propertyTypes: ['Office'],
    micromarkets: ['Marol'],
    ownerUserId: demandAgent,
    sourceType: 'Channel',
    ...d,
  };
  await h.deliver('demand.created.v1', data, { aggregateId: data.demandId });
  const da = await h.as(demandAgent, 'Demand agent');
  await da.post('/v1/calls', { subjectType: 'demand', subjectId: data.demandId, outcome: 'confirmed' });
  await da.post(`/v1/demands/${data.demandId}/qualify`, { checklist: { decisionMakerReached: true, budgetConfirmed: true, timingConfirmed: true, agreesToWork: true } });
  return data;
}
async function confirmed(demandId: string, offerIds: string[]) {
  const matchId = ids();
  await h.deliver('match.suggested.v1', { matchId, code: `MAT-8${n}`, demandId, offerIds, score: 75, isBundle: offerIds.length > 1 }, { aggregateId: matchId });
  await h.deliver('match.confirmed.v1', { matchId, demandId, offerIds }, { aggregateId: matchId });
  return matchId;
}
const status = async (kind: 'offers' | 'demands', id: string) =>
  (await (await h.as(manager, 'Manager')).get(`/v1/${kind}/${id}/journey`)).body;
const events = async (type: Parameters<typeof h.outbox>[0], aggregateId?: string) =>
  (await h.outbox(type)).filter((e) => !aggregateId || e.aggregate_id === aggregateId).map((e) => e.payload);

describe('AS-D1: Channel demand → proposal → visit → deal → Closed', () => {
  let d: EventDataMap['demand.created.v1'];
  let a: EventDataMap['offer.created.v1'];
  let matchA: string;
  let dealId: string;
  const other = { demandId: '' };

  it('second touch keeps the first-touch credit (touch count, notification, no life-curve reset)', async () => {
    d = await demand();
    await h.deliver('demand.touch_added.v1', { demandId: d.demandId, touchId: ids(), sourceType: 'Digi', isFirstTouch: false }, { aggregateId: d.demandId });
    const [row] = await h.rows<{ touch_count: number; source_type: string }>(sql`select touch_count, source_type from demand_view where id = ${d.demandId}`);
    expect(row).toMatchObject({ touch_count: 2, source_type: 'Channel' });
  });

  it('three matches incl. a Marol bundle; proposal sent; visit completed resets both curves (US-24)', async () => {
    a = await offer();
    const b1 = await offer();
    const b2 = await offer();
    const c3 = await offer();
    matchA = await confirmed(d.demandId, [a.offerId]);
    const bundle = await confirmed(d.demandId, [b1.offerId, b2.offerId]);
    await confirmed(d.demandId, [c3.offerId]);
    expect((await status('demands', d.demandId))['liveMatches']).toBe(3);
    const da = await h.as(demandAgent, 'Demand agent');
    const p = await da.post('/v1/proposals', { demandId: d.demandId, options: [{ matchId: matchA }, { matchId: bundle }] });
    await buildSnapshot({ runner: h.runner, integrations: h.integrations }, { kind: 'build_snapshot', tenantId: h.tenantId, proposalId: p.body['id'] as string, correlationId: 't' }, 1);
    expect((await da.post(`/v1/proposals/${p.body['id']}/mark-sent`, { channel: 'Email' })).body['status']).toBe('Sent');

    const notMatched = await offer();
    expect((await da.post('/v1/site-visits', { demandId: d.demandId, offerIds: [notMatched.offerId], scheduledAt: '2026-05-06T05:30:00Z' })).body['code']).toBe(
      'offer-not-matched',
    );
    h.clock.day('2026-05-20');
    const v = await da.post('/v1/site-visits', { demandId: d.demandId, offerIds: [a.offerId, b1.offerId], scheduledAt: '2026-05-22T05:30:00Z', attendeeUserIds: [supply] });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ code: expect.stringMatching(/^VIS-\d{4}$/), status: 'Scheduled' });
    const done = await da.post(`/v1/site-visits/${v.body['code']}/complete`, { outcome: 'Interested', visitedOfferIds: [a.offerId], preferredOfferId: a.offerId });
    expect(done.body).toMatchObject({ status: 'Completed', visitedOfferIds: [a.offerId] });
    expect((await status('offers', a.offerId))['commercialStatus']).toBe('Site visit');
    expect((await status('offers', b1.offerId))['commercialStatus']).toBe('In proposal');
    expect((await status('demands', d.demandId))['commercialStatus']).toBe('Site visit');
    expect((await events('offer.confirmed.v1', a.offerId)).at(-1)?.['data']).toMatchObject({ how: 'visit' });
    expect((await events('demand.confirmed.v1', d.demandId)).at(-1)?.['data']).toMatchObject({ how: 'visit' });
    expect((await events('site_visit.completed.v1'))[0]?.['data']).toMatchObject({ demandId: d.demandId, offerIds: [a.offerId], preferredOfferId: a.offerId });
  });

  it('opens a deal with a mandatory next action; one open deal per demand; exits and retire are blocked', async () => {
    const da = await h.as(demandAgent, 'Demand agent');
    expect((await da.post('/v1/deals', { demandId: d.demandId, offerId: a.offerId, nextAction: 'x', followUpDate: '2026-05-01' })).body['code']).toBe('follow-up-required');
    const r = await da.post('/v1/deals', { demandId: d.demandId, offerId: a.offerId, matchId: matchA, nextAction: 'Share draft LOI', followUpDate: '2026-05-22', agreedTerms: { rentMonthlyInr: 290000, leaseMonths: 11 } });
    expect(r.status).toBe(201);
    dealId = r.body['id'] as string;
    expect(r.body).toMatchObject({ code: expect.stringMatching(/^DEAL-\d{4}$/), stage: 'Negotiation', overdue: false, agreedTerms: { leaseMonths: 11 } });
    expect((await status('offers', a.offerId))['commercialStatus']).toBe('In process');
    expect((await status('demands', d.demandId))['commercialStatus']).toBe('In process');
    expect((await da.post('/v1/deals', { demandId: d.demandId, offerId: a.offerId, nextAction: 'x', followUpDate: '2026-05-22' })).body['code']).toBe('deal-already-open');
    expect((await da.post(`/v1/demands/${d.demandId}/exit`, { type: 'Lost', reasonCode: 'withdrew' })).body['code']).toBe('exit-blocked-by-open-deal');
    expect((await (await h.as(supply, 'Supply agent')).post(`/v1/offers/${a.offerId}/retire`, { reason: 'other' })).body['code']).toBe('exit-blocked-by-open-deal');
    expect((await events('deal.opened.v1', dealId))[0]?.['data']).toMatchObject({ demandId: d.demandId, offerId: a.offerId });
  });

  it('follow-ups reset both curves; stages move forward only; every change carries the next follow-up (R13)', async () => {
    h.clock.day('2026-05-23');
    const da = await h.as(demandAgent, 'Demand agent');
    const fu = await (await h.as(supply, 'Supply agent')).post(`/v1/deals/${dealId}/follow-ups`, { note: 'owner agreed rent', nextAction: 'Draft agreement', followUpDate: '2026-05-25' });
    expect(fu.status).toBe(200);
    expect((await events('offer.confirmed.v1', a.offerId)).at(-1)?.['data']).toMatchObject({ how: 'call' });
    expect((await events('demand.confirmed.v1', d.demandId)).at(-1)?.['data']).toMatchObject({ how: 'deal_follow_up' });
    expect((await da.patch(`/v1/deals/${dealId}`, { stage: 'Documentation' })).body['code']).toBe('follow-up-required');
    const doc = await da.patch(`/v1/deals/${dealId}`, { stage: 'Documentation', nextAction: 'Registration slot', followUpDate: '2026-05-27' });
    expect(doc.body['stage']).toBe('Documentation');
    expect((await da.patch(`/v1/deals/${dealId}`, { stage: 'Negotiation', nextAction: 'x', followUpDate: '2026-05-27' })).body['code']).toBe('invalid-transition');
    expect((await da.patch(`/v1/deals/${dealId}`, { stage: 'Closed' })).body['code']).toBe('closing-terms-required');
    expect((await da.patch(`/v1/deals/${dealId}`, { stage: 'Stamp duty & registration', nextAction: 'x', followUpDate: '2026-05-28' }, { 'if-match': '1' })).status).toBe(412);
  });

  it('close: deal Closed, offer + demand Closed and frozen, items closed, lease renewal at month 10, deal.closed.v1', async () => {
    other.demandId = (await demand()).demandId;
    await confirmed(other.demandId, [a.offerId]);
    const da = await h.as(demandAgent, 'Demand agent');
    const closed = await da.patch(`/v1/deals/${dealId}`, { stage: 'Closed', closingPriceInr: 290000, agreedTerms: { leaseStartDate: '2026-06-01' } });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ stage: 'Closed', closingPriceInr: 290000, leaseRenewalDueOn: '2027-04-01' });
    expect((closed.body['stageHistory'] as { to: string }[]).map((s) => s.to)).toEqual(['Negotiation', 'Documentation', 'Closed']);
    expect((await status('offers', a.offerId))['commercialStatus']).toBe('Closed');
    expect((await status('demands', d.demandId))['commercialStatus']).toBe('Closed');
    const curves = await h.rows<{ frozen: boolean }>(sql`select frozen from life_curve where subject_id in (${a.offerId}, ${d.demandId})`);
    expect(curves.every((c) => c.frozen)).toBe(true);
    const open = await h.rows(sql`select id from queue_items where tenant_id = ${h.tenantId} and status = 'open' and (offer_id = ${a.offerId} or demand_id = ${d.demandId})`);
    expect(open).toEqual([]);
    expect((await events('deal.closed.v1', dealId))[0]?.['data']).toMatchObject({ closingPriceInr: 290000, dealType: 'Lease', leaseMonths: 11 });

    // saga: crm-engine closes the other matches of the offer; the other demand's owner is told
    const theirs = (await h.rows<{ id: string }>(sql`select id from match_view where tenant_id = ${h.tenantId} and demand_id = ${other.demandId}`))[0];
    await h.deliver('match.closed.v1', { matchId: theirs?.id as string, demandId: other.demandId, reason: 'leased_to_another_client' }, { aggregateId: theirs?.id as string });
    const notes = await h.rows<{ title: string }>(sql`select title from notifications where tenant_id = ${h.tenantId} and kind = 'match_closed'`);
    expect(notes[0]?.title).toContain('leased to another client');
    expect((await status('demands', other.demandId))['commercialStatus']).toBe('Active');
  });

  it('lease-renewal-scan emits lease_renewal.due.v1 at month 10', async () => {
    h.clock.day('2027-03-31');
    await h.runJob('lease-renewal-scan');
    expect(await events('lease_renewal.due.v1')).toEqual([]);
    h.clock.day('2027-04-01');
    await h.runJob('lease-renewal-scan');
    await h.runJob('lease-renewal-scan');
    const due = await events('lease_renewal.due.v1');
    expect(due).toHaveLength(1);
    expect(due[0]?.['data']).toMatchObject({ previousOfferId: a.offerId, propertyId: a.propertyId, availableFrom: '2027-05-01' });
    const list = await (await h.as(manager, 'Manager')).get('/v1/lease-renewals?status=emitted');
    expect(list.body.items?.[0]).toMatchObject({ dealId, dueOn: '2027-04-01', leaseMonths: 11 });
  });

  it('cancel after close (token refunded): Manager only; offer and demand reopen', async () => {
    h.clock.day('2026-06-10');
    const da = await h.as(demandAgent, 'Demand agent');
    expect((await da.post(`/v1/deals/${dealId}/cancel`, { reasonCode: 'token_refunded' })).status).toBe(403);
    const mgr = await h.as(manager, 'Manager');
    const r = await mgr.post(`/v1/deals/${dealId}/cancel`, { reasonCode: 'token_refunded', reason: 'bank loan rejected' });
    // the renewal was already emitted by the scan above, so it stays (only a scheduled one is cancelled)
    expect(r.body).toMatchObject({ stage: 'Cancelled', cancelReasonCode: 'token_refunded' });
    expect((await status('offers', a.offerId))['commercialStatus']).not.toBe('Closed');
    expect((await status('demands', d.demandId))['commercialStatus']).toBe('Site visit');
    expect((await events('deal.cancelled.v1', dealId))[0]?.['data']).toEqual({ dealId, demandId: d.demandId, offerId: a.offerId, reason: 'token_refunded' });
    const curves = await h.rows<{ frozen: boolean }>(sql`select frozen from life_curve where subject_id in (${a.offerId}, ${d.demandId})`);
    expect(curves.every((c) => !c.frozen)).toBe(true);
    expect((await mgr.post(`/v1/deals/${dealId}/cancel`, { reasonCode: 'other' })).body['code']).toBe('invalid-transition');
  });
});

describe('multi-unit project configurations and reminders', () => {
  it('AS-S6: two deals on one configuration; closing books units and keeps the offer live', async () => {
    h.clock.day('2026-07-01');
    const config = await offer({ dealType: 'Sale', market: 'Primary', segment: 'Residential', projectId: ids(), unitCount: 38, salePriceInrMin: 25_000_000 });
    const d1 = await demand({ dealTypes: ['Sale'], segment: 'Residential' });
    const d2 = await demand({ dealTypes: ['Sale'], segment: 'Residential' });
    const m1 = await confirmed(d1.demandId, [config.offerId]);
    await confirmed(d2.demandId, [config.offerId]);
    const da = await h.as(demandAgent, 'Demand agent');
    const deal1 = await da.post('/v1/deals', { demandId: d1.demandId, offerId: config.offerId, matchId: m1, nextAction: 'Booking form', followUpDate: '2026-07-02' });
    const deal2 = await da.post('/v1/deals', { demandId: d2.demandId, offerId: config.offerId, nextAction: 'Site visit', followUpDate: '2026-07-03' });
    expect(deal2.status).toBe(201);
    const closed = await da.patch(`/v1/deals/${deal1.body['id']}`, { stage: 'Closed', closingPriceInr: 24_500_000, agreedTerms: { unitsBooked: 2 } });
    expect(closed.body['stage']).toBe('Closed');
    expect((await events('deal.closed.v1', deal1.body['id'] as string))[0]?.['data']).toMatchObject({ dealType: 'Sale', unitsBooked: 2 });
    expect((await status('offers', config.offerId))['commercialStatus']).toBe('In process'); // deal 2 still open

    // follow-up-reminders (08:00): overdue once → deal.updated.v1 overdue=true + a notification
    h.clock.day('2026-07-04');
    await h.runJob('follow-up-reminders');
    const overdue = (await events('deal.updated.v1', deal2.body['id'] as string)).filter((e) => e['data']['overdue'] === true);
    expect(overdue).toHaveLength(1);
    const list = await da.get('/v1/deals?followUpDue=true');
    expect(list.body.items?.map((i) => i['id'])).toContain(deal2.body['id']);
    expect(list.body.items?.find((i) => i['id'] === deal2.body['id'])?.['overdue']).toBe(true);
  });

  it('no-shows: the absent side keeps its life curve', async () => {
    h.clock.day('2026-08-01');
    const o = await offer();
    const d = await demand();
    await confirmed(d.demandId, [o.offerId]);
    const before = await h.rows<{ subject_id: string; last_confirmed_at: Date | null }>(sql`select subject_id, last_confirmed_at from life_curve where subject_id in (${o.offerId}, ${d.demandId})`);
    const da = await h.as(demandAgent, 'Demand agent');
    h.clock.day('2026-08-05');
    const v = await da.post('/v1/site-visits', { demandId: d.demandId, offerIds: [o.offerId], scheduledAt: '2026-08-06T05:30:00Z' });
    await da.post(`/v1/site-visits/${v.body['id']}/complete`, { outcome: 'Client no-show' });
    const after = await h.rows<{ subject_id: string; last_confirmed_at: Date | null }>(sql`select subject_id, last_confirmed_at from life_curve where subject_id in (${o.offerId}, ${d.demandId})`);
    const dBefore = before.find((r) => r.subject_id === d.demandId)?.last_confirmed_at?.getTime();
    expect(after.find((r) => r.subject_id === d.demandId)?.last_confirmed_at?.getTime()).toBe(dBefore);
    expect(after.find((r) => r.subject_id === o.offerId)?.last_confirmed_at?.toISOString()).toBe(h.clock.now().toISOString());
    expect((await status('demands', d.demandId))['commercialStatus']).toBe('Matched'); // a client no-show is not a visit
    for (const e of await h.outbox()) expect(eventProblems(e.payload)).toBeNull();
  });
});
