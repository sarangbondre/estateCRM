// JOU-01/JOU-02 on the local database: projections from records events, journeys and life curves created on first
// sight, the nightly run (stage actions, events, Upcoming → Available, auto-Dormant), confirmations, idempotency.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import type { EventDataMap, EventType } from '@11e/contracts/events';
import { handlers } from '../src/application/handlers.js';
import { ensureMigrated, eventProblems, harness, ids } from './helpers.js';

const h = harness();
beforeAll(() => ensureMigrated());
afterAll(() => h.close());

const owner = ids();

function offer(overrides: Partial<EventDataMap['offer.created.v1']> = {}): EventDataMap['offer.created.v1'] {
  return {
    offerId: ids(),
    code: `INV-${Math.floor(Math.random() * 1e6)}`,
    propertyId: ids(),
    dealType: 'Lease',
    segment: 'Commercial',
    market: 'Secondary',
    propertyTypes: ['Office'],
    micromarket: 'Andheri East',
    rentMonthlyInrMin: 250000,
    areaSqftMin: 1200,
    recordStage: 'Enriched',
    sourceType: 'Channel',
    ownerUserId: owner,
    contactPersonIds: [ids()],
    ...overrides,
  };
}

async function curve(subjectId: string) {
  const [r] = await h.rows<{ stage: string; day_count: number; next_change_on: string | null; availability_unknown: boolean; frozen: boolean }>(
    sql`select * from life_curve where tenant_id = ${h.tenantId} and subject_id = ${subjectId}`,
  );
  return r;
}
async function items(subjectId: string) {
  return h.rows<{ section: string; reason: string; status: string; assignee_user_id: string | null; rank_score: number | null }>(
    sql`select * from queue_items where tenant_id = ${h.tenantId} and subject_id = ${subjectId} order by created_at`,
  );
}
async function journey(offerId: string) {
  const [r] = await h.rows<{ commercial_status: string }>(sql`select * from offer_journey where tenant_id = ${h.tenantId} and id = ${offerId}`);
  return r;
}

describe('offer projection and life curve', () => {
  const o = offer();

  it('offer.created.v1 builds the projection, journey, curve and a Should call new_capture item', async () => {
    h.clock.day('2026-01-01');
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId });
    const [view] = await h.rows<{ code: string; captured_on: string; rent_monthly_inr_min: number; facts_version: number }>(
      sql`select * from offer_view where tenant_id = ${h.tenantId} and id = ${o.offerId}`,
    );
    expect(view).toMatchObject({ code: o.code, captured_on: '2026-01-01', rent_monthly_inr_min: 250000, facts_version: 1 });
    expect((await journey(o.offerId))?.commercial_status).toBe('Available');
    expect(await curve(o.offerId)).toMatchObject({ stage: 'Fresh', day_count: 0, next_change_on: '2026-02-01' });
    expect(await items(o.offerId)).toMatchObject([{ section: 'should_call', reason: 'new_capture', status: 'open', assignee_user_id: owner }]);
    const [ev] = await h.outbox('offer.commercial_status_changed.v1');
    expect(ev?.payload.data).toEqual({ offerId: o.offerId, from: '', to: 'Available', reason: 'created' });
  });

  it('replays and stale versions are ignored', async () => {
    await h.deliver('offer.created.v1', { ...o, rentMonthlyInrMin: 1 }, { aggregateId: o.offerId, version: 1 });
    const [view] = await h.rows<{ rent_monthly_inr_min: number }>(sql`select * from offer_view where id = ${o.offerId}`);
    expect(view?.rent_monthly_inr_min).toBe(250000);
    expect((await h.outbox('offer.commercial_status_changed.v1')).length).toBe(1);
  });

  it('day 31 → Ageing (reconfirm), day 61 → Stale (stale_public when Public), day 91 → Expired (availability unknown)', async () => {
    h.clock.day('2026-02-01');
    await h.runJob('life-curve-nightly');
    expect(await curve(o.offerId)).toMatchObject({ stage: 'Ageing', day_count: 31, next_change_on: '2026-03-03' });
    expect((await items(o.offerId)).filter((i) => i.status === 'open')).toMatchObject([{ section: 'should_call', reason: 'reconfirm' }]);

    await h.deliver('publication.changed.v1', { subjectType: 'offer', subjectId: o.offerId, from: 'Anonymous', to: 'Public', reason: 'user' }, { aggregateId: o.offerId, version: 1 });
    h.clock.day('2026-03-03');
    await h.runJob('life-curve-nightly');
    expect(await curve(o.offerId)).toMatchObject({ stage: 'Stale' });
    const open = (await items(o.offerId)).filter((i) => i.status === 'open');
    expect(open).toMatchObject([{ section: 'should_call', reason: 'stale_public' }]);

    h.clock.day('2026-04-02');
    await h.runJob('life-curve-nightly');
    expect(await curve(o.offerId)).toMatchObject({ stage: 'Expired', availability_unknown: true, next_change_on: null });
    const stages = (await h.outbox('lifecycle.stage_changed.v1')).map((e) => `${e.payload.data['from']}→${e.payload.data['to']}`);
    expect(stages).toEqual(['Fresh→Ageing', 'Ageing→Stale', 'Stale→Expired']);
  });

  it('a second nightly call on the same date is a no-op', async () => {
    const before = (await h.outbox()).length;
    expect((await h.runJob('life-curve-nightly')).processed).toBe(0);
    expect((await h.outbox()).length).toBe(before);
  });

  it('aggregateVersion is strictly increasing per aggregate and every produced event matches AsyncAPI', async () => {
    const all = await h.outbox();
    const last = new Map<string, number>();
    for (const e of all) {
      expect(eventProblems(e.payload)).toBeNull();
      if (e.payload['aggregateType'] === 'audit') continue;
      const prev = last.get(e.aggregate_id) ?? 0;
      expect(e.aggregate_version).toBeGreaterThan(prev);
      last.set(e.aggregate_id, e.aggregate_version);
    }
  });
});

describe('project configurations, Upcoming offers and demands', () => {
  it('price_sheet.applied.v1 confirms every configuration (how = price_sheet) and resets the curve (AS-S6)', async () => {
    h.clock.day('2026-05-01');
    const projectId = ids();
    const a = offer({ dealType: 'Sale', market: 'Primary', segment: 'Residential', projectId, propertyTypes: ['Apartment'], salePriceInrMin: 25000000 });
    await h.deliver('offer.created.v1', a, { aggregateId: a.offerId });
    h.clock.day('2026-06-05'); // day 35 → Ageing: request_price_sheet
    await h.runJob('life-curve-nightly');
    expect((await items(a.offerId)).filter((i) => i.status === 'open')).toMatchObject([{ reason: 'request_price_sheet' }]);
    await h.deliver('price_sheet.applied.v1', { projectId, priceSheetId: ids(), sheetDate: '2026-06-04' }, { aggregateId: projectId });
    expect(await curve(a.offerId)).toMatchObject({ stage: 'Fresh', day_count: 1 });
    expect((await items(a.offerId)).filter((i) => i.status === 'open')).toEqual([]);
    const confirmed = (await h.outbox('offer.confirmed.v1')).find((e) => e.aggregate_id === a.offerId);
    expect(confirmed?.payload.data['how']).toBe('price_sheet');
  });

  it('AS-S5: an Upcoming offer stays Fresh until its clock starts and becomes Available on its date', async () => {
    h.clock.day('2026-10-01');
    const u = offer({ possessionStatus: 'Available From', possessionDate: '2027-02-01' });
    await h.deliver('offer.created.v1', u, { aggregateId: u.offerId });
    expect((await journey(u.offerId))?.commercial_status).toBe('Upcoming');
    expect(await curve(u.offerId)).toMatchObject({ stage: 'Fresh', day_count: 0, next_change_on: '2026-12-03' });
    h.clock.day('2026-12-03');
    await h.runJob('life-curve-nightly');
    expect(await curve(u.offerId)).toMatchObject({ stage: 'Fresh', day_count: 0 });
    h.clock.day('2027-01-03'); // day 31 of the clock → Ageing
    await h.runJob('life-curve-nightly');
    expect(await curve(u.offerId)).toMatchObject({ stage: 'Ageing' });
    h.clock.day('2027-02-01');
    await h.runJob('life-curve-nightly');
    expect((await journey(u.offerId))?.commercial_status).toBe('Available');
  });

  it('a lease residential demand: day 15 reconfirm_due, day 31 Expired → automatic Dormant (paused, revisit +60)', async () => {
    h.clock.day('2026-07-01');
    const demandId = ids();
    await h.deliver(
      'demand.created.v1',
      { demandId, code: 'DEM-000900', dealTypes: ['Lease'], segment: 'Residential', micromarkets: ['Powai'], ownerUserId: owner, rentMonthlyInrMax: 80000 },
      { aggregateId: demandId },
    );
    expect(await items(demandId)).toMatchObject([{ section: 'to_contact', reason: 'first_contact' }]);
    h.clock.day('2026-07-16');
    await h.runJob('life-curve-nightly');
    expect((await items(demandId)).map((i) => i.section)).toContain('reconfirm_due');
    h.clock.day('2026-08-01');
    await h.runJob('life-curve-nightly');
    expect(await curve(demandId)).toMatchObject({ stage: 'Paused', next_change_on: null });
    const exited = (await h.outbox('demand.exited.v1')).find((e) => e.aggregate_id === demandId);
    expect(exited?.payload.data).toMatchObject({ exit: 'Dormant', reason: 'life_curve_expired', revisitDate: '2026-09-30' });
    const stages = (await h.outbox('lifecycle.stage_changed.v1')).filter((e) => e.aggregate_id === demandId).map((e) => e.payload.data['to']);
    // the job did not run on day 22, so the curve moves Ageing → Expired in one step
    expect(stages).toEqual(['Ageing', 'Expired', 'Paused']);
    expect((await items(demandId)).filter((i) => i.status === 'open')).toEqual([]);
  });
});

describe('every consumed event type', () => {
  const consumed = Object.keys(handlers) as EventType[];

  it('has a handler for every event routed to q_journeys', () => {
    const topology = JSON.parse(readFileSync(new URL('../../../contracts/generated/event-topology.json', import.meta.url), 'utf8')) as {
      routes: Record<string, { queues: string[] }>;
    };
    const routed = Object.entries(topology.routes).filter(([, r]) => r.queues.includes('q_journeys')).map(([t]) => t).sort();
    expect([...consumed].sort()).toEqual(routed);
  });

  it('applies every contract fixture without failing (fixtures carry random, schema-valid values)', async () => {
    const dir = new URL('../../../contracts/fixtures/events/', import.meta.url);
    const files = readdirSync(dir).filter((f) => consumed.includes(f.replace(/\.json$/, '') as EventType));
    expect(files.length).toBe(consumed.length);
    // Fixture ids are fixed; map every UUID to a fresh one so reruns on the same database don't collide.
    const fresh = new Map<string, string>();
    const remap = (text: string) =>
      text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
        if (!fresh.has(u)) fresh.set(u, ids());
        return fresh.get(u) as string;
      });
    for (const f of files) {
      const env = JSON.parse(remap(readFileSync(new URL(f, dir), 'utf8'))) as { eventType: EventType; data: never; aggregateId: string };
      await h.deliver(env.eventType, env.data, { aggregateId: env.aggregateId, version: 1_000 });
    }
  });
});
