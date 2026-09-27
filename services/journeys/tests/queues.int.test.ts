// JOU-03: My queue (sections, computed order, daily plan), Manager views, reassign, capacities, counters and the
// queue.counts_changed.v1 flush, ranking with the demand gap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventDataMap } from '@11e/contracts/events';
import { ensureMigrated, eventProblems, harness, ids } from './helpers.js';

const h = harness();
const agent = ids();
const other = ids();
const manager = ids();
beforeAll(async () => {
  await ensureMigrated();
  h.clock.day('2026-03-02');
  for (const [userId, role] of [
    [agent, 'Supply agent'],
    [other, 'Supply agent'],
    [manager, 'Manager'],
  ] as const) {
    await h.deliver('user.changed.v1', { userId, role, active: true, displayName: 'Test user' }, { aggregateId: userId });
  }
});
afterAll(() => h.close());

let n = 0;
function offer(overrides: Partial<EventDataMap['offer.created.v1']> = {}): EventDataMap['offer.created.v1'] {
  n++;
  return {
    offerId: ids(),
    code: `INV-${String(n).padStart(5, '0')}`,
    propertyId: ids(),
    dealType: 'Sale',
    segment: 'Residential',
    market: 'Secondary',
    propertyTypes: ['Apartment'],
    micromarket: 'Powai',
    salePriceInrMin: 20_000_000 + n * 1_000_000,
    areaSqftMin: 900,
    recordStage: 'Enriched',
    sourceType: 'Digi',
    ownerUserId: agent,
    ...overrides,
  };
}

describe('My queue', () => {
  const offers = [offer(), offer(), offer(), offer({ micromarket: 'Andheri East' })];

  it('builds should_call items for captures and a must_call item per enquiry (due +24 h)', async () => {
    for (const o of offers) await h.deliver('offer.created.v1', o, { aggregateId: o.offerId });
    await h.deliver('enquiry.received.v1', { enquiryId: ids(), code: 'ENQ-0311', offerId: offers[0]?.offerId, receivedAt: h.clock.now().toISOString() }, { aggregateId: ids() });
    const me = await h.as(agent, 'Supply agent');
    const r = await me.get('/v1/queues/me');
    expect(r.status).toBe(200);
    const by = Object.fromEntries((r.body['sections'] as { section: string; count: number }[]).map((s) => [s.section, s.count]));
    expect(by).toMatchObject({ must_call: 1, should_call: 4, sourcing_requests: 0, watchlist_tasks: 0 });
    expect(r.body).toMatchObject({ userId: agent, capacity: 40, callsLoggedToday: 0, plannedToday: 5 });
    const must = await me.get('/v1/queues/me/sections/must_call');
    expect(must.body.items?.[0]).toMatchObject({ reason: 'enquiry', reasonRef: 'ENQ-0311', subjectCode: offers[0]?.code, overdue: false, plannedToday: true });
    expect(new Date(must.body.items?.[0]?.['dueAt']).getTime() - h.clock.now().getTime()).toBe(24 * 3_600_000);
  });

  it('should_call pages follow the rank (desc, id) and respect the daily plan', async () => {
    const me = await h.as(agent, 'Supply agent');
    const page1 = await me.get('/v1/queues/me/sections/should_call?limit=2');
    expect(page1.body.items).toHaveLength(2);
    const page2 = await me.get(`/v1/queues/me/sections/should_call?limit=2&cursor=${page1.body.nextCursor}`);
    const all = [...(page1.body.items ?? []), ...(page2.body.items ?? [])];
    expect(all).toHaveLength(4);
    const ranks = all.map((i) => i['rank'] as number);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(all[0]?.['rankFactors']).toMatchObject({ freshness: 1, sourceQuality: 0.5 });

    const mgr = await h.as(manager, 'Manager');
    expect((await mgr.put(`/v1/capacities/${agent}`, { team: 'supply', dailyCalls: 3 })).status).toBe(200);
    const planned = await me.get('/v1/queues/me/sections/should_call?plannedOnly=true');
    // capacity 3 − 1 open Must call − 0 calls today = 2 Should call slots
    expect(planned.body.items).toHaveLength(2);
    expect(planned.body.items?.every((i) => i['plannedToday'] === true)).toBe(true);
    expect(planned.body.nextCursor).toBeNull();
    expect((await me.get('/v1/queues/me')).body['plannedToday']).toBe(3);
  });

  it('Manager views a team member; unknown users are 404; agents cannot', async () => {
    const mgr = await h.as(manager, 'Manager');
    expect((await mgr.get(`/v1/queues/users/${agent}`)).body['userId']).toBe(agent);
    expect((await mgr.get(`/v1/queues/users/${agent}/sections/must_call`)).body.items).toHaveLength(1);
    expect((await mgr.get(`/v1/queues/users/${ids()}`)).status).toBe(404);
    expect((await (await h.as(agent, 'Supply agent')).get(`/v1/queues/users/${other}`)).status).toBe(403);
  });

  it('reassigns in bulk (counters follow) and records an audit event', async () => {
    const mgr = await h.as(manager, 'Manager');
    const me = await h.as(agent, 'Supply agent');
    const items = (await me.get('/v1/queues/me/sections/should_call')).body.items ?? [];
    const key = ids();
    const r = await mgr.post('/v1/queue-items/reassign', { queueItemIds: [items[0]?.['id'], ids()], assigneeUserId: other }, { 'idempotency-key': key });
    expect(r.status).toBe(200);
    expect(r.body['reassigned']).toBe(1);
    expect(r.body['skipped']).toHaveLength(1);
    const replay = await mgr.post('/v1/queue-items/reassign', { queueItemIds: [items[0]?.['id'], ids()], assigneeUserId: other }, { 'idempotency-key': key });
    expect(replay.status).toBe(409); // same key, different body
    const theirs = await (await h.as(other, 'Supply agent')).get('/v1/queues/me');
    expect((theirs.body['sections'] as { section: string; count: number }[]).find((s) => s.section === 'should_call')?.count).toBe(1);
    expect((await h.outbox('audit.recorded.v1')).some((e) => e.payload.data['action'] === 'queue_items.reassigned')).toBe(true);
  });

  it('capacities: agents read only their own row; If-Match mismatch is 412; list by team', async () => {
    const me = await h.as(agent, 'Supply agent');
    expect((await me.get(`/v1/capacities/${agent}`)).body).toMatchObject({ userId: agent, dailyCalls: 3, team: 'supply' });
    const forbidden = await me.get(`/v1/capacities/${other}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body['code']).toBe('not-owner');
    const mgr = await h.as(manager, 'Manager');
    expect((await mgr.get(`/v1/capacities/${other}`)).body).toMatchObject({ dailyCalls: 40, version: 0 });
    expect((await mgr.put(`/v1/capacities/${agent}`, { team: 'supply', dailyCalls: 50 }, { 'if-match': '99' })).status).toBe(412);
    const list = await mgr.get('/v1/capacities?team=supply');
    expect(list.body.items?.map((i) => i['userId'])).toContain(agent);
  });

  it('queue-counts-flush emits one queue.counts_changed.v1 per changed user, then nothing until counts change', async () => {
    await h.runJob('queue-counts-flush');
    const first = await h.outbox('queue.counts_changed.v1');
    const mine = first.filter((e) => e.payload.data['userId'] === agent);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.payload.data['counts']).toMatchObject({ must_call: 1, should_call: 3 });
    expect(eventProblems(mine[0]?.payload)).toBeNull();
    await h.runJob('queue-counts-flush');
    expect((await h.outbox('queue.counts_changed.v1')).length).toBe(first.length);
  });

  it('demand gap raises the rank of offers in cells with open demand (rank-refresh after demand-gap-refresh)', async () => {
    const me = await h.as(agent, 'Supply agent');
    const bandra = offer({ micromarket: 'Bandra West' });
    await h.deliver('offer.created.v1', bandra, { aggregateId: bandra.offerId });
    const before = (await me.get('/v1/queues/me/sections/should_call')).body.items ?? [];
    const andheri = before.find((i) => i['subjectCode'] === bandra.code);
    expect(andheri).toBeDefined();
    for (let i = 0; i < 5; i++) {
      const demandId = ids();
      await h.deliver(
        'demand.created.v1',
        { demandId, code: `DEM-9${i}`, dealTypes: ['Sale'], segment: 'Residential', micromarkets: ['Bandra West'], budgetInrMax: 23_000_000 + i * 1_000_000, ownerUserId: manager },
        { aggregateId: demandId },
      );
    }
    await h.runJob('demand-gap-refresh');
    await h.runJob('rank-refresh');
    const after = (await me.get('/v1/queues/me/sections/should_call')).body.items ?? [];
    const top = after[0];
    expect(top?.['subjectCode']).toBe(bandra.code);
    expect(top?.['rank']).toBeGreaterThan(andheri?.['rank'] as number);
    // gap = 5 open demands − 1 matching offer; price ₹2.5 Cr inside the p25–p75 budget band
    expect(top?.['rankFactors']).toMatchObject({ demandGap: 4 / 20, priceBand: 1 });
  });
});
