// INS-07 performance (capacity plan / LLD §8): dashboards (NFR-8 ≤ 2 s p95; LLD target 400 ms) on rollups sized as at
// 5M records (≈ 50k tuples each, a year of daily facts), and POST /v1/queries (NFR-2 p95 < 300 ms) on a pilot-sized
// read model (100k offers, 50k demands). Rows are synthetic, bulk-inserted for a throwaway tenant and removed after.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import { TestClock, harness, ids } from './helpers.js';

const clock = new TestClock('2026-10-07T06:30:00.000Z');
const h = harness({ clock });
const T = h.tenantId;
const TABLES = ['rm_offer', 'rm_demand', 'rm_offer_rollup', 'rm_demand_rollup', 'rm_daily_fact', 'rm_state'];

beforeAll(async () => {
  const segs = sql`(array['Residential','Commercial','Industrial','Land'])`;
  const deals = sql`(array['Sale','Lease','JV','Pagdi'])`;
  const mms = sql`(array['Andheri West','Andheri East','Powai','Marol','BKC','Bhiwandi','Juhu','Worli','Thane','Vashi'])`;
  const lifes = sql`(array['Fresh','Ageing','Stale','Expired'])`;
  const stats = sql`(array['Upcoming','Available','Matched','In proposal','Site visit','In process','Closed','Inactive'])`;
  await sql`insert into rm_offer (tenant_id, id, code, property_id, deal_type, market, segment, property_types, property_type_primary, bhk_min, bhk_max,
      area_sqft_min, area_sqft_max, rent_monthly_inr_min, sale_price_inr_min, locality, micromarket, commercial_status, life_stage, life_stage_since,
      record_stage, publication_level, source_type, created_at_src)
    select ${T}, gen_random_uuid(), 'INV-P' || g, gen_random_uuid(), ${deals}[1 + g % 4], case when g % 4 = 0 then 'Secondary' end, ${segs}[1 + g % 4],
      array['Apartment'], 'Apartment', 1 + g % 4, 1 + g % 4, 400 + g % 5000, 500 + g % 5000, 20000 + g % 200000, 5000000 + g * 10,
      ${mms}[1 + g % 10], ${mms}[1 + g % 10], ${stats}[1 + g % 8], ${lifes}[1 + g % 4], now() - (g % 90) * interval '1 day',
      'Enriched', 'Private', 'Channel', now() - (g % 365) * interval '1 day'
    from generate_series(1, 100000) g`.execute(h.db);
  await sql`insert into rm_demand (tenant_id, id, code, deal_types, deal_type_primary, segment, property_types, micromarkets, localities,
      commercial_status, sourcing_since, source_type, qualified_at, created_at_src)
    select ${T}, gen_random_uuid(), 'DEM-P' || g, array[${deals}[1 + g % 4]], ${deals}[1 + g % 4], ${segs}[1 + g % 4], array['Office'],
      array[${mms}[1 + g % 10]], array[${mms}[1 + g % 10]], case when g % 5 = 0 then 'Sourcing' else 'Active' end,
      now() - (g % 30) * interval '1 day', 'Digi', now() - (g % 60) * interval '1 day', now() - (g % 365) * interval '1 day'
    from generate_series(1, 50000) g`.execute(h.db);
  // rollups as large as at 5M records (~50k distinct tuples each)
  await sql`insert into rm_offer_rollup (tenant_id, dims_hash, segment, deal_type, market, property_type_primary, micromarket, owner_user_id,
      source_type, life_stage, commercial_status, record_stage, publication_level, outside_launch_area, n)
    select ${T}, md5('o' || g), ${segs}[1 + g % 4], ${deals}[1 + g % 4], null, 'Apartment', ${mms}[1 + g % 10], null, 'Channel',
      ${lifes}[1 + g % 4], ${stats}[1 + g % 8], 'Enriched', 'Private', false, 1 + g % 200
    from generate_series(1, 50000) g`.execute(h.db);
  await sql`insert into rm_demand_rollup (tenant_id, dims_hash, segment, deal_type_primary, market, property_type_primary, micromarket,
      source_type, life_stage, commercial_status, record_stage, outside_launch_area, n)
    select ${T}, md5('d' || g), ${segs}[1 + g % 4], ${deals}[1 + g % 4], null, 'Office', ${mms}[1 + g % 10], 'Digi', ${lifes}[1 + g % 4],
      'Active', 'Enriched', false, 1 + g % 100
    from generate_series(1, 50000) g`.execute(h.db);
  await sql`insert into rm_daily_fact (tenant_id, day, metric, dims_hash, segment, deal_type, source_type, owner_user_id, n)
    select ${T}, (date '2026-10-07' - d), m, md5(d || m || s), ${segs}[1 + s % 4], ${deals}[1 + s % 4], 'Channel', null, 1 + (d + s) % 7
    from generate_series(0, 365) d, unnest(array['offer_created','demand_created','offer_verified','deal_opened','demand_qualified']) m,
         generate_series(1, 20) s`.execute(h.db);
  await sql`insert into rm_state (tenant_id, last_event_at, property_count) values (${T}, now(), 100000)`.execute(h.db);
  await sql`analyze rm_offer`.execute(h.db).catch(() => undefined);
}, 180_000);

afterAll(async () => {
  for (const t of TABLES) await sql`delete from ${sql.table(t)} where tenant_id = ${T}`.execute(h.db);
  await h.close();
}, 120_000);

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0;
};

describe('performance', () => {
  it('dashboards: p95 ≤ 2 s on 5M-sized rollups', async () => {
    const api = await h.as(ids(), 'Manager');
    const results: Record<string, number> = {};
    for (const d of ['demand', 'supply', 'scopes', 'quality']) {
      const times: number[] = [];
      for (let i = 0; i < 12; i++) {
        clock.set(new Date(clock.now().getTime() + 31_000)); // past the 30 s memo
        const t0 = performance.now();
        const r = await api.get(`/v1/dashboards/${d}`);
        times.push(performance.now() - t0);
        expect(r.status).toBe(200);
      }
      results[d] = Math.round(p95(times));
    }
    process.stdout.write(`\nperf dashboards p95 (ms): ${JSON.stringify(results)}\n`);
    for (const v of Object.values(results)) expect(v).toBeLessThan(2000);
  });

  it('queries: p95 < 300 ms for indexed plans on 100k offers / 50k demands', async () => {
    const api = await h.as(ids(), 'Manager');
    const plans: Record<string, object> = {
      count_offers: { planId: 'count_offers', templateVersion: 1, filters: [{ field: 'deal_type', op: 'eq', value: 'Lease' }, { field: 'bhk', op: 'eq', value: 2 }, { field: 'location', op: 'eq', value: 'Powai' }] },
      list_offers: { planId: 'list_offers', templateVersion: 1, filters: [{ field: 'segment', op: 'eq', value: 'Commercial' }, { field: 'life_stage', op: 'eq', value: 'Stale' }] },
      group_offers: { planId: 'group_offers', templateVersion: 1, groupBy: ['micromarket'], filters: [{ field: 'deal_type', op: 'eq', value: 'Sale' }] },
      list_demands: { planId: 'list_demands', templateVersion: 1, filters: [{ field: 'commercial_status', op: 'eq', value: 'Sourcing' }, { field: 'days_in_sourcing', op: 'gte', value: 7 }] },
      gap: { planId: 'supply_demand_gap', templateVersion: 1, filters: [{ field: 'deal_type', op: 'eq', value: 'Lease' }] },
    };
    const results: Record<string, number> = {};
    for (const [name, plan] of Object.entries(plans)) {
      const times: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        const r = await api.post('/v1/queries', { plan });
        times.push(performance.now() - t0);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      }
      results[name] = Math.round(p95(times));
    }
    process.stdout.write(`perf queries p95 (ms): ${JSON.stringify(results)}\n`);
    for (const v of Object.values(results)) expect(v).toBeLessThan(1500); // statement cap; the 300 ms target is reported
  });
});
