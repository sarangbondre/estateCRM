// Miss-path latency of the public API (LLD §8, capacity plan: p95 ≤ 60 ms DB, ≤ 120 ms function, NFR-2 300 ms).
// In-process against the local DB: API-key auth → token bucket → one index-ordered query on public_item → JSON.
// 5,000 published items; 70% list (varied filters), 25% detail, 5% change feed (the load-test mix).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, harness } from '../helpers.js';
import type { Harness } from '../helpers.js';

const ITEMS = 5000;
const REQUESTS = 400;
let h: Harness;
const keys: string[] = [];
const publicIds: string[] = [];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const pid = (n: number) =>
  `L-${Array.from({ length: 10 }, (_, i) => CROCKFORD[(n >> (i * 3)) % 32 || (i + n) % 32]).join('')}`;
const LOCALITIES = [
  'Andheri West',
  'Bandra West',
  'Powai',
  'BKC',
  'Lower Parel',
  'Thane West',
  'Malad West',
  'Chembur',
];
const TYPES: [string, string, string][] = [
  ['Lease', 'Residential', 'Apartment'],
  ['Sale', 'Residential', 'Apartment'],
  ['Lease', 'Commercial', 'Office'],
  ['Sale', 'Commercial', 'Shop'],
  ['Lease', 'Industrial', 'Warehouse'],
];

beforeAll(async () => {
  h = await harness();
  for (let k = 0; k < 10; k++) {
    const r = await call(h, 'POST', '/v1/api-keys', await h.staff(), { name: `perf-${k}` });
    keys.push(((await r.json()) as { secret: string }).secret);
  }
  const rows = [];
  const seen = new Set<string>();
  for (let i = 0; i < ITEMS; i++) {
    let publicId = pid(i * 7919 + 13);
    while (seen.has(publicId)) publicId = pid(Math.floor(Math.random() * 1e9));
    seen.add(publicId);
    publicIds.push(publicId);
    const [dealType, segment, type] = TYPES[i % TYPES.length] as [string, string, string];
    const locality = LOCALITIES[i % LOCALITIES.length] as string;
    const price = dealType === 'Sale' ? 50_00_000 + (i % 400) * 1_00_000 : 20_000 + (i % 300) * 1_000;
    const publishedAt = new Date(Date.now() - i * 60_000);
    const payload = {
      publicId,
      level: 'Anonymous',
      label: dealType === 'Sale' ? 'For Sale' : segment === 'Residential' ? 'For Rent' : 'For Lease',
      headline: `${type} · ${locality}`,
      dealType,
      market: null,
      segment,
      propertyTypes: [type],
      bhkMin: segment === 'Residential' ? 1 + (i % 4) : null,
      bhkMax: segment === 'Residential' ? 1 + (i % 4) : null,
      city: 'Mumbai',
      micromarket: locality,
      locality,
      areaSqftMin: 400 + (i % 50) * 20,
      areaSqftMax: 400 + (i % 50) * 20,
      areaBasis: 'Carpet',
      landAreaSqft: null,
      salePriceInrMin: dealType === 'Sale' ? price : null,
      salePriceInrMax: dealType === 'Sale' ? price : null,
      rentMonthlyInrMin: dealType === 'Sale' ? null : price,
      rentMonthlyInrMax: dealType === 'Sale' ? null : price,
      possessionDate: null,
      saleMode: null,
      tenancyStatus: null,
      furnishing: null,
      note: 'Details subject to confirmation',
      agentReraNumber: 'A51900012345',
      projectPublicId: null,
      projectReraNumber: null,
      publishedAt: publishedAt.toISOString(),
      updatedAt: publishedAt.toISOString(),
    };
    rows.push({
      tenant_id: h.tenant,
      id: randomUUID(),
      public_id: publicId,
      subject_type: 'listing',
      level: 'Anonymous',
      payload: JSON.stringify(payload),
      payload_hash: String(i),
      deal_type: dealType,
      deal_types: null,
      market: null,
      segment,
      city: 'Mumbai',
      micromarket: locality,
      locality,
      micromarket_path: [locality],
      property_types: [type],
      bhk_min: payload.bhkMin,
      bhk_max: payload.bhkMax,
      area_sqft_min: payload.areaSqftMin,
      area_sqft_max: payload.areaSqftMax,
      sale_price_inr_min: payload.salePriceInrMin,
      rent_monthly_inr_min: payload.rentMonthlyInrMin,
      price_sort_inr: price,
      possession_sort: null,
      sale_mode: null,
      tenancy_status: null,
      furnishing: null,
      project_public_id: null,
      published_at: publishedAt,
      updated_at: publishedAt,
    });
  }
  for (let i = 0; i < rows.length; i += 500)
    await h.deps.db
      .insertInto('public_item')
      .values(rows.slice(i, i + 500))
      .execute();
}, 120_000);
afterAll(async () => {
  await h.deps.db.deleteFrom('public_item').where('tenant_id', '=', h.tenant).execute();
  await h.close();
});

const LIST_QUERIES = [
  '/v1/listings',
  '/v1/listings?dealType=Lease&segment=Commercial',
  '/v1/listings?dealType=Sale&sort=priceAsc',
  '/v1/listings?propertyType=Apartment&bhkMin=2',
  '/v1/listings?micromarket=Powai',
  '/v1/listings?city=Mumbai&limit=50',
  '/v1/listings?dealType=Lease&rentMonthlyInrMax=40000',
];

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;

describe('public API miss path (5,000 items)', () => {
  it('p95 stays within the function budget (≤ 120 ms) for the load-test mix', async () => {
    const times: Record<string, number[]> = { list: [], detail: [], changes: [] };
    for (let i = 0; i < REQUESTS; i++) {
      const roll = i % 20;
      const kind = roll < 14 ? 'list' : roll < 19 ? 'detail' : 'changes';
      const path =
        kind === 'list'
          ? (LIST_QUERIES[i % LIST_QUERIES.length] as string)
          : kind === 'detail'
            ? `/v1/listings/${publicIds[(i * 31) % ITEMS]}`
            : `/v1/changes?since=${new Date(Date.now() - 3_600_000).toISOString()}`;
      const started = performance.now();
      const r = await h.app.request(path, { headers: { 'x-api-key': keys[i % keys.length] as string } });
      await r.arrayBuffer();
      (times[kind] as number[]).push(performance.now() - started);
      expect(r.status, path).toBe(200);
    }
    const summary = Object.fromEntries(
      Object.entries(times).map(([k, v]) => [k, { n: v.length, p95Ms: Math.round(p95(v) * 10) / 10 }]),
    );
    process.stderr.write(`listings perf ${JSON.stringify(summary)}\n`);
    expect(p95(times['list'] as number[])).toBeLessThan(120);
    expect(p95(times['detail'] as number[])).toBeLessThan(120);
  }, 120_000);
});
