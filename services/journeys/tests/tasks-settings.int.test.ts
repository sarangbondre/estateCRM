// JOU-09 (work notifications, Watchlist tasks) and JOU-10 (settings APIs: thresholds, weights; capacities are in
// queues.int.test.ts), plus the internal subject-states feed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import type { EventDataMap } from '@11e/contracts/events';
import { DEFAULT_THRESHOLDS } from '../src/domain/lifecurve.js';
import { ensureMigrated, harness, ids, serviceHeaders } from './helpers.js';

const h = harness();
const supply1 = ids();
const supply2 = ids();
const admin = ids();
const manager = ids();
const demandAgent = ids();
beforeAll(async () => {
  await ensureMigrated();
  h.clock.day('2026-06-01');
  for (const [userId, role] of [
    [supply1, 'Supply agent'],
    [supply2, 'Supply agent'],
    [admin, 'Admin'],
    [manager, 'Manager'],
    [demandAgent, 'Demand agent'],
  ] as const)
    await h.deliver('user.changed.v1', { userId, role, active: true }, { aggregateId: userId });
});
afterAll(() => h.close());

describe('Watchlist tasks (JOU-09, D-14, US-36)', () => {
  let taskId: string;
  it('a Watchlist item creates a task (due = deadline − 7) and a watchlist_tasks item for the least-loaded supply agent', async () => {
    const itemId = ids();
    await h.deliver('watchlist_item.created.v1', { watchlistItemId: itemId, code: 'WCH-0001', signalType: 'Lease expiring', deadlineDate: '2026-06-30' }, { aggregateId: itemId });
    const near = ids();
    await h.deliver('watchlist_item.created.v1', { watchlistItemId: near, code: 'WCH-0002', signalType: 'Tenant moving', deadlineDate: '2026-06-04' }, { aggregateId: near });
    const open = ids();
    await h.deliver('watchlist_item.created.v1', { watchlistItemId: open, code: 'WCH-0003', signalType: 'Redevelopment' }, { aggregateId: open });
    const mgr = await h.as(manager, 'Manager');
    const list = await mgr.get('/v1/watchlist-tasks?status=Open');
    expect(list.body.items?.map((t) => [t['watchlistCode'], t['dueDate']])).toEqual([
      ['WCH-0002', '2026-06-03'], // JA-6: deadline closer than 7 days → today + 2
      ['WCH-0001', '2026-06-23'],
      ['WCH-0003', '2026-06-03'],
    ]);
    expect((await mgr.get('/v1/watchlist-tasks?deadlineWithinDays=14')).body.items).toHaveLength(1);
    taskId = list.body.items?.[1]?.['id'] as string;
    const assignee = list.body.items?.[1]?.['assigneeUserId'];
    expect([supply1, supply2]).toContain(assignee);
    const items = await h.rows<{ section: string; assignee_user_id: string }>(sql`select * from queue_items where subject_id = ${taskId} and status = 'open'`);
    expect(items).toMatchObject([{ section: 'watchlist_tasks', assignee_user_id: assignee }]);
  });

  it('Managers reassign / cancel (PATCH); agents complete (watchlist_task.completed.v1, no free text in the event)', async () => {
    const mgr = await h.as(manager, 'Manager');
    expect((await (await h.as(supply1, 'Supply agent')).patch(`/v1/watchlist-tasks/${taskId}`, { assigneeUserId: supply1 })).status).toBe(403);
    const moved = await mgr.patch(`/v1/watchlist-tasks/${taskId}`, { assigneeUserId: supply2, dueDate: '2026-06-20' });
    expect(moved.body).toMatchObject({ assigneeUserId: supply2, dueDate: '2026-06-20' });
    const done = await (await h.as(supply2, 'Supply agent')).post(`/v1/watchlist-tasks/${taskId}/complete`, { outcome: 'Spoke to the society secretary', createdOfferIds: [] });
    expect(done.body).toMatchObject({ status: 'Done', completedBy: supply2 });
    const ev = (await h.outbox('watchlist_task.completed.v1')).at(-1)?.payload;
    expect(ev?.['data']).toEqual({ taskId, watchlistItemId: done.body['watchlistItemId'] });
    expect((await (await h.as(supply2, 'Supply agent')).post(`/v1/watchlist-tasks/${taskId}/complete`, { outcome: 'again' })).body['code']).toBe('invalid-transition');
    expect(await h.rows(sql`select id from queue_items where subject_id = ${taskId} and status = 'open'`)).toEqual([]);
  });
});

describe('work notifications (JOU-09, FR-NTF-1)', () => {
  it('throttles repeated notifications by dedupe key; unread count; mark read by ids and up to a time', async () => {
    const demandId = ids();
    await h.deliver('demand.created.v1', { demandId, code: 'DEM-004242', dealTypes: ['Sale'], segment: 'Residential', micromarkets: ['Powai'], ownerUserId: demandAgent }, { aggregateId: demandId });
    for (let i = 0; i < 3; i++) {
      const matchId = ids();
      await h.deliver('match.suggested.v1', { matchId, code: `MAT-${i}`, demandId, offerIds: [ids()], score: 60 }, { aggregateId: matchId });
    }
    const me = await h.as(demandAgent, 'Demand agent');
    const list = await me.get('/v1/notifications?unreadOnly=true');
    const matches = list.body.items?.filter((n) => n['kind'] === 'match_suggested') ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.['title']).toBe('3 new matches for DEM-004242');
    const unread = (await me.get('/v1/notifications/unread-count')).body['unread'] as number;
    expect(unread).toBeGreaterThanOrEqual(1);
    const r = await me.post('/v1/notifications/mark-read', { ids: [matches[0]?.['id']] });
    expect(r.body).toEqual({ marked: 1 });
    expect((await me.get('/v1/notifications/unread-count')).body['unread']).toBe(unread - 1);
    // a new match after reading starts a new notification
    const next = ids();
    await h.deliver('match.suggested.v1', { matchId: next, code: 'MAT-9', demandId, offerIds: [ids()], score: 60 }, { aggregateId: next });
    expect((await me.get('/v1/notifications/unread-count')).body['unread']).toBe(unread);
    expect((await me.post('/v1/notifications/mark-read', {})).status).toBe(400);
    await me.post('/v1/notifications/mark-read', { upTo: h.clock.now().toISOString() });
    expect((await me.get('/v1/notifications/unread-count')).body['unread']).toBe(0);
    expect((await me.get('/v1/notifications')).body.items?.every((n) => n['readAt'])).toBe(true);
  });
});

describe('settings (JOU-10)', () => {
  it('thresholds: defaults, validation, Admin only, If-Match; new thresholds are applied by the next nightly run', async () => {
    const offerId = ids();
    const o: EventDataMap['offer.created.v1'] = { offerId, code: 'INV-TH1', propertyId: ids(), dealType: 'Lease', segment: 'Commercial', micromarket: 'BKC', ownerUserId: supply1 };
    await h.deliver('offer.created.v1', o, { aggregateId: offerId });
    const adm = await h.as(admin, 'Admin');
    const got = await adm.get('/v1/settings/life-curve-thresholds');
    expect(got.body).toMatchObject({ version: 0, offer: DEFAULT_THRESHOLDS.offer, upcomingLeadDays: 60 });
    const body = { ...got.body, offer: { ...DEFAULT_THRESHOLDS.offer, lease_commercial: { freshMaxDays: 5, ageingMaxDays: 60, staleMaxDays: 90 } } };
    const invalid = await adm.put('/v1/settings/life-curve-thresholds', { ...body, offer: { ...body.offer, industrial: { freshMaxDays: 50, ageingMaxDays: 40, staleMaxDays: 90 } } });
    expect(invalid.status).toBe(400);
    expect(invalid.body['code']).toBe('invalid-thresholds');
    expect((await (await h.as(manager, 'Manager')).put('/v1/settings/life-curve-thresholds', body)).status).toBe(403);
    const saved = await adm.put('/v1/settings/life-curve-thresholds', body, { 'if-match': '0' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, updatedBy: admin });
    expect((await adm.put('/v1/settings/life-curve-thresholds', body, { 'if-match': '0' })).status).toBe(412);

    h.clock.day('2026-06-11'); // day 10: Fresh under the old 30-day limit, Ageing under the new 5-day limit
    await h.runJob('life-curve-nightly');
    const [curve] = await h.rows<{ stage: string }>(sql`select stage from life_curve where subject_id = ${offerId}`);
    expect(curve?.stage).toBe('Ageing');
    expect((await h.outbox('audit.recorded.v1')).some((e) => e.payload.data['action'] === 'settings.life_curve_thresholds')).toBe(true);
  });

  it('queue weights: defaults, all-zero rejected, saved weights re-rank Should call', async () => {
    const adm = await h.as(admin, 'Admin');
    const got = await adm.get('/v1/settings/queue-weights');
    expect(got.body).toMatchObject({ version: 0, freshness: 0.25, demandGap: 0.35, sourceQuality: 0.2, priceBand: 0.2, maxAttempts: 3 });
    expect((await adm.put('/v1/settings/queue-weights', { version: 0, freshness: 0, demandGap: 0, sourceQuality: 0, priceBand: 0 })).body['code']).toBe('invalid-thresholds');
    const saved = await adm.put('/v1/settings/queue-weights', { version: 0, freshness: 1, demandGap: 0, sourceQuality: 0, priceBand: 0 });
    expect(saved.body).toMatchObject({ version: 1, freshness: 1, stalePublicBoost: 15 });
    await h.runJob('rank-refresh');
    const [item] = await h.rows<{ rank_score: number; rank_dirty: boolean }>(
      sql`select rank_score, rank_dirty from queue_items where tenant_id = ${h.tenantId} and section = 'should_call' and status = 'open' limit 1`,
    );
    expect(item?.rank_dirty).toBe(false);
  });

  it('internal subject states: service token only, keyset by updatedAt', async () => {
    const svcHeaders = await serviceHeaders(h.tenantId, 'listings');
    const res = await h.app.request('/internal/v1/subject-states?subjectType=offer&limit=1', { headers: svcHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { subjectType: string; lifeStage: string }[]; nextCursor: string | null };
    expect(body.items[0]).toMatchObject({ subjectType: 'offer', lifeStage: 'Ageing' });
    const staff = await (await h.as(admin, 'Admin')).get('/internal/v1/subject-states?subjectType=offer');
    expect(staff.status).toBe(403);
  });
});
