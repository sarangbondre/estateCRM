// INS-02: the four dashboards on a seeded read model — sections, queue tiles from queue.counts_changed (R-18),
// classification grids with generated labels, drill-downs that run as valid plans, roles, filters and caching.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileRollups } from '../src/adapters/reconcile.js';
import { TestClock, harness, ids } from './helpers.js';
import type { ApiBody } from './helpers.js';
import { NOW, seedBenchmark } from './seed.js';
import type { Seeded } from './seed.js';

const clock = new TestClock(NOW);
const h = harness({ clock });
let seeded: Seeded;
afterAll(() => h.close());

beforeAll(async () => {
  seeded = await seedBenchmark(h);
  const a = ids();
  const b = ids();
  await h.deliver('queue.counts_changed.v1', { userId: a, counts: { must_call: 4, to_contact: 2, in_sourcing: 1 } }, { aggregateId: a });
  await h.deliver('queue.counts_changed.v1', { userId: b, counts: { must_call: 1, should_call: 7 } }, { aggregateId: b });
  const uploadId = ids();
  await h.deliver('upload.started.v1', { uploadId, code: 'UPL-0042', mode: 'strict', sourceType: 'Newspaper', rowCount: 10, uploadedBy: ids() }, { occurredAt: '2026-10-05T05:00:00.000Z' });
  await h.deliver('rows.classified.v1', {
    uploadId,
    batchNo: 1,
    rows: [
      { rowId: ids(), externalRef: 'aaaaaaaaaaa1', side: 'Supply', needsReview: true, reviewReasonCode: 'side_defaulted' },
      { rowId: ids(), externalRef: 'aaaaaaaaaaa2', side: 'Supply', possibleRepeatOf: 'aaaaaaaaaaa1' },
    ],
  }, { occurredAt: '2026-10-05T05:01:00.000Z' });
  await h.deliver('upload.completed.v1', { uploadId, code: 'UPL-0042', counts: { read: 10, accepted: 8, rejected: 2, needsReview: 1 }, rejectionReasons: { 'value-not-in-list': 2 }, sourceType: 'Newspaper', uploadedBy: ids() }, { occurredAt: '2026-10-05T05:02:00.000Z' });
  await h.deliver('review_item.created.v1', { reviewItemId: ids(), uploadId, reasonCode: 'side_defaulted' });
  await h.deliver('merge_candidate.raised.v1', { candidateId: ids(), kind: 'price_gap' });
  await h.deliver('desk_item.created.v1', { deskItemId: ids(), code: 'BIZ-0001', recordScope: 'Business', side: 'Supply', sector: 'Hospitality', linkedPropertyId: ids() });
  await h.deliver('desk_item.created.v1', { deskItemId: ids(), code: 'NET-0001', recordScope: 'Market Participant', participantRole: 'Broker' });
  await h.deliver('watchlist_item.created.v1', { watchlistItemId: ids(), code: 'WL-0001', signalType: 'Government Tender', deadlineDate: '2026-10-15' });
  await reconcileRollups(h.db, h.tenantId); // nightly property count
});

const get = async (path: string, role: Parameters<typeof h.as>[1] = 'Manager') => {
  clock.set(new Date(clock.now().getTime() + 31_000)); // past the 30 s memo
  return (await h.as(seeded.me, role)).get(path);
};
const tile = (d: ApiBody, section: string, tileId: string) =>
  (d['sections'] as { sectionId: string; tiles: Record<string, unknown>[] }[]).find((s) => s.sectionId === section)?.tiles.find((t) => t['tileId'] === tileId);

/** Every drill-down plan in a dashboard must be a valid plan that runs. */
async function assertDrillDownsRun(d: ApiBody) {
  const plans: unknown[] = [];
  for (const s of d['sections'] as { tiles: Record<string, unknown>[] }[])
    for (const t of s.tiles) {
      if (t['drillDown']) plans.push(t['drillDown']);
      for (const b of (t['breakdown'] as { drillDown?: unknown }[] | undefined) ?? []) if (b.drillDown) plans.push(b.drillDown);
      for (const c of (t['cells'] as { drillDown?: unknown }[] | undefined) ?? []) if (c.drillDown) plans.push(c.drillDown);
    }
  const who = await h.as(seeded.me, 'Manager');
  for (const plan of plans) {
    const r = await who.post('/v1/queries', { plan, limit: 1 });
    expect(r.status, `${JSON.stringify(plan)} → ${JSON.stringify(r.body)}`).toBe(200);
  }
  return plans.length;
}

describe('dashboards', () => {
  it('demand: sources, life curve, team queues from queue.counts_changed, exits, classification grid', async () => {
    const r = await get('/v1/dashboards/demand');
    expect(r.status, JSON.stringify(r.body).slice(0, 600)).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=30');
    expect(tile(r.body, 'demand_team_queues', 'queue_to_contact')?.['value']).toBe(2);
    expect(tile(r.body, 'demand_team_queues', 'queue_in_sourcing')?.['value']).toBe(1);
    expect(tile(r.body, 'demand_team_queues', 'deals_follow_up_due')?.['value']).toBe(2);
    const grid = tile(r.body, 'demand_by_classification', 'demand_classification_grid') as { cells: { row: string; column: string; value: number; label?: string }[] };
    const cell = grid.cells.find((c) => c.row === 'Commercial' && c.column === 'Lease');
    expect(cell?.value).toBe(9); // 5 Marol + 1 BKC + 3 bundle-test demands, all open
    expect(cell?.label).toBe('Wants to Lease');
    expect(grid.cells.find((c) => c.row === 'Residential' && c.column === 'Sale|Secondary')?.label).toBe('Wants to Buy, Resale');
    expect(await assertDrillDownsRun(r.body)).toBeGreaterThan(20);
  });

  it('supply: stock, life curve, queues and listings, grid with For labels and deal tags', async () => {
    const r = await get('/v1/dashboards/supply');
    expect(r.status, JSON.stringify(r.body).slice(0, 600)).toBe(200);
    expect(tile(r.body, 'supply_stock', 'properties')?.['value']).toBeGreaterThan(20);
    expect(tile(r.body, 'supply_queues_listings', 'queue_must_call')?.['value']).toBe(5);
    expect(tile(r.body, 'supply_queues_listings', 'upcoming')?.['value']).toBe(2);
    expect(tile(r.body, 'supply_queues_listings', 'listed_public')?.['value']).toBe(2);
    const grid = tile(r.body, 'supply_by_classification', 'supply_classification_grid') as { cells: { row: string; column: string; label?: string }[]; drillDown: null };
    expect(grid.drillDown).toBeNull();
    expect(grid.cells.find((c) => c.row === 'Residential' && c.column === 'Lease')?.label).toBe('For Rent');
    expect(grid.cells.some((c) => c.column === 'Sale|Any')).toBe(false);
    expect(await assertDrillDownsRun(r.body)).toBeGreaterThan(20);
  });

  it('scopes: desks, network and watchlist', async () => {
    const r = await get('/v1/dashboards/scopes');
    expect(r.status, JSON.stringify(r.body).slice(0, 600)).toBe(200);
    expect(tile(r.body, 'business_capital', 'business_includes_property')?.['value']).toBe(1);
    expect(tile(r.body, 'network', 'participants_by_role')?.['breakdown']).toEqual([{ key: 'Broker', label: 'Broker', value: 1 }]);
    expect(tile(r.body, 'watchlist', 'watchlist_deadlines_14d')?.['value']).toBe(1);
  });

  it('quality: uploads with rejection reasons, review queue, side checks, source quality — open to Data operators', async () => {
    const r = await get('/v1/dashboards/quality?period=this_week', 'Data operator');
    expect(r.status, JSON.stringify(r.body).slice(0, 600)).toBe(200);
    expect(tile(r.body, 'uploads', 'rows_rejected_by_reason')?.['breakdown']).toEqual([{ key: 'value-not-in-list', label: 'value-not-in-list', value: 2 }]);
    expect(tile(r.body, 'uploads', 'possible_repeats')?.['value']).toBe(1);
    expect(tile(r.body, 'review', 'price_gaps')?.['value']).toBe(1);
    expect(tile(r.body, 'side_checks', 'side_defaulted_per_upload')?.['breakdown']).toEqual([{ key: 'UPL-0042', label: 'UPL-0042', value: 1 }]);
    expect((tile(r.body, 'source_quality', 'share_verified_by_source')?.['breakdown'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('applies filters, rejects labels and bad periods, enforces roles', async () => {
    const f = await get('/v1/dashboards/supply?segment=commercial&dealType=Lease');
    expect(f.status).toBe(200);
    expect(f.body['filters']).toMatchObject({ segment: 'Commercial', dealType: 'Lease' });
    expect(tile(f.body, 'supply_stock', 'active_offers')?.['value']).toBe(3);
    expect((await get('/v1/dashboards/supply?dealType=For%20Rent')).body['code']).toBe('unknown-vocabulary-value');
    expect((await get('/v1/dashboards/demand?period=custom')).status).toBe(400);
    expect((await get('/v1/dashboards/demand?period=custom&from=2026-09-01&to=2026-09-30')).status).toBe(200);
    expect((await get('/v1/dashboards/supply', 'Data operator')).status).toBe(403);
    expect((await get('/v1/dashboards/scopes', 'Data operator')).status).toBe(403);
  });

  it('p95 ≤ 2 s (NFR-8) — measured locally on the seeded model', async () => {
    const times: number[] = [];
    for (let i = 0; i < 10; i++)
      for (const d of ['demand', 'supply', 'scopes', 'quality']) {
        const started = performance.now();
        const r = await get(`/v1/dashboards/${d}`);
        times.push(performance.now() - started);
        expect(r.status, JSON.stringify(r.body).slice(0, 600)).toBe(200);
      }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95) - 1] ?? 0;
    process.stdout.write(`dashboards p95 ${p95.toFixed(0)} ms over ${times.length} requests\n`);
    expect(p95).toBeLessThan(2000);
  });
});
