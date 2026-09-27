// Public website API (LIS-05, US-33): key auth, rate limits (R-1), filters on stored values, cursors ≤ 50, edge
// cache headers, change feed, withdrawal visibility, tenant isolation.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, demandData, harness, offerData } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
let key: string;
const started = new Date(Date.now() - 1000).toISOString();
const ids: Record<string, string> = {};

const get = (path: string, k = key) => h.app.request(path, { headers: { 'x-api-key': k } });

async function publish(
  name: string,
  over: Parameters<typeof offerData>[0],
  level: 'Anonymous' = 'Anonymous',
) {
  const data = offerData(over);
  await h.event('offer.created.v1', data);
  const r = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff(), { level });
  expect(r.status).toBe(200);
  ids[name] = ((await r.json()) as { publicId: string }).publicId;
  return data;
}

beforeAll(async () => {
  h = await harness();
  const r = await call(h, 'POST', '/v1/api-keys', await h.staff(), { name: 'website' });
  key = ((await r.json()) as { secret: string }).secret;
  h.records.ancestors = { Lokhandwala: ['Andheri West'], 'Andheri West': [] };
  await h.tx((s) => s.saveMicromarkets(h.records.ancestors));
  await publish('rent2', { rentMonthlyInrMin: 45000, locality: 'Lokhandwala', micromarket: 'Andheri West' });
  await publish('rent3', {
    bhkMin: 3,
    bhkMax: 3,
    rentMonthlyInrMin: 90000,
    locality: 'Bandra West',
    micromarket: 'Bandra',
  });
  await publish('office', {
    segment: 'Commercial',
    propertyTypes: ['Office'],
    rentMonthlyInrMin: 250000,
    locality: 'BKC',
    micromarket: 'BKC',
  });
  await publish('sale', {
    dealType: 'Sale',
    market: 'Secondary',
    salePriceInrMin: 2_10_00_000,
    salePriceInrMax: 2_10_00_000,
    locality: 'Powai',
    micromarket: 'Powai',
  });
  await publish('sale2', {
    dealType: 'Sale',
    market: 'Secondary',
    salePriceInrMin: 1_50_00_000,
    locality: 'Powai',
    micromarket: 'Powai',
    possessionDate: '2027-03',
  });
  const d = demandData();
  await h.event('demand.created.v1', d);
  await h.event(
    'demand.sourcing_started.v1',
    { demandId: d.demandId, postAnonymously: true },
    { producer: 'journeys' },
  );
});
afterAll(() => h.close());

type Page = { items: { publicId: string; [k: string]: unknown }[]; nextCursor: string | null };

describe('authentication, rate limits, caching', () => {
  it('requires a valid X-Api-Key', async () => {
    expect((await h.app.request('/v1/listings')).status).toBe(401);
    expect((await get('/v1/listings', 'lk_live_' + 'x'.repeat(40))).status).toBe(401);
    expect((await get('/v1/listings', 'not-a-key')).status).toBe(401);
  });

  it('sets edge-cache headers and the remaining quota', async () => {
    const r = await get('/v1/listings');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, s-maxage=20, stale-while-revalidate=10');
    expect(r.headers.get('vary')).toBe('X-Api-Key');
    expect(Number(r.headers.get('x-ratelimit-remaining'))).toBeGreaterThanOrEqual(0);
  });

  it('enforces the per-key token bucket (429 + Retry-After)', async () => {
    const r = await call(h, 'POST', '/v1/api-keys', await h.staff(), {
      name: 'tiny',
      rateLimitRps: 1,
      burst: 1,
    });
    const tiny = ((await r.json()) as { secret: string }).secret;
    expect((await get('/v1/listings', tiny)).status).toBe(200);
    const limited = await get('/v1/listings', tiny);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(limited.headers.get('cache-control')).toBeNull();
  });
});

describe('listings', () => {
  it('filters on stored values, with the micromarket hierarchy', async () => {
    const rent = (await (await get('/v1/listings?dealType=Lease&segment=Residential')).json()) as Page;
    expect(rent.items.map((i) => i.publicId).sort()).toEqual([ids['rent2'], ids['rent3']].sort());
    const office = (await (await get('/v1/listings?propertyType=Office')).json()) as Page;
    expect(office.items.map((i) => i.publicId)).toEqual([ids['office']]);
    const andheri = (await (await get('/v1/listings?micromarket=Andheri%20West')).json()) as Page;
    expect(andheri.items.map((i) => i.publicId)).toEqual([ids['rent2']]);
    const bhk = (await (await get('/v1/listings?bhkMin=3')).json()) as Page;
    expect(bhk.items.map((i) => i.publicId)).toEqual([ids['rent3']]);
    const cheap = (await (await get('/v1/listings?dealType=Sale&salePriceInrMax=20000000')).json()) as Page;
    expect(cheap.items.map((i) => i.publicId)).toEqual([ids['sale2']]);
    const byMonth = (await (await get('/v1/listings?possessionBy=2027-03')).json()) as Page;
    expect(byMonth.items.map((i) => i.publicId)).toEqual([ids['sale2']]);
    // Case-folded stored values are accepted (R-11); labels and legacy terms are not.
    expect((await get('/v1/listings?dealType=lease')).status).toBe(200);
    const label = await get('/v1/listings?dealType=For%20Rent');
    expect(label.status).toBe(400);
    expect(((await label.json()) as { code: string }).code).toBe('unknown-vocabulary-value');
  });

  it('sorts by price with a deal type only, and pages with bound cursors (max 50)', async () => {
    const bad = await get('/v1/listings?sort=priceAsc');
    expect(((await bad.json()) as { code: string }).code).toBe('sort-requires-deal-type');
    const asc = (await (await get('/v1/listings?dealType=Sale&sort=priceAsc&limit=1')).json()) as Page;
    expect(asc.items.map((i) => i.publicId)).toEqual([ids['sale2']]);
    const next = (await (
      await get(`/v1/listings?dealType=Sale&sort=priceAsc&limit=1&cursor=${asc.nextCursor}`)
    ).json()) as Page;
    expect(next.items.map((i) => i.publicId)).toEqual([ids['sale']]);
    expect(next.nextCursor).toBeNull();
    const other = await get(`/v1/listings?dealType=Lease&limit=1&cursor=${asc.nextCursor}`);
    expect(other.status).toBe(400);
    expect(((await other.json()) as { code: string }).code).toBe('invalid-cursor');
    expect((await get('/v1/listings?limit=51')).status).toBe(400);
    const newest = (await (await get('/v1/listings?limit=2')).json()) as Page;
    const newest2 = (await (await get(`/v1/listings?limit=50&cursor=${newest.nextCursor}`)).json()) as Page;
    expect(newest.items.length + newest2.items.length).toBe(5);
  });

  it('detail by public id; other types and unknown ids are 404', async () => {
    const r = await get(`/v1/listings/${ids['rent2']}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      publicId: ids['rent2'],
      level: 'Anonymous',
      label: 'For Rent',
      dealType: 'Lease',
    });
    expect((await get('/v1/listings/L-0000000000')).status).toBe(404);
    expect((await get('/v1/listings/INV-00001')).status).toBe(400);
  });

  it('demand posts', async () => {
    const posts = (await (await get('/v1/demand-posts?dealType=Lease&micromarket=BKC')).json()) as Page;
    expect(posts.items).toHaveLength(1);
    expect(posts.items[0]).toMatchObject({
      label: 'Wants to Lease',
      rentBandMonthlyInr: { min: 175000, max: 275000 },
    });
  });
});

describe('projects', () => {
  it('list and detail with configurations', async () => {
    const projectId = randomUUID();
    const cfg = offerData({
      dealType: 'Sale',
      market: 'Primary',
      projectId,
      salePriceInrMin: 95_00_000,
      unitCount: 60,
    });
    await h.event('project.created.v1', {
      projectId,
      code: 'PRJ-0099',
      name: 'Lakeview Residences',
      reraNumber: 'P51800054321',
      locality: 'Powai',
      city: 'Mumbai',
      possessionDate: '2028-06',
      offerIds: [cfg.offerId],
    });
    await h.event('offer.created.v1', cfg);
    await call(h, 'PUT', `/v1/offers/${cfg.offerId}/publication`, await h.staff(), { level: 'Anonymous' });
    const put = await call(h, 'PUT', `/v1/projects/${projectId}/publication`, await h.staff(), {
      level: 'Public',
    });
    const { publicId } = (await put.json()) as { publicId: string };
    const list = (await (await get('/v1/projects?priceInrMax=10000000&possessionBy=2028')).json()) as Page;
    expect(list.items.map((i) => i.publicId)).toEqual([publicId]);
    const detail = await get(`/v1/projects/${publicId}`);
    expect(await detail.json()).toMatchObject({
      name: 'Lakeview Residences',
      configurations: [{ unitsAvailableBand: '50+', priceInrFrom: 95_00_000 }],
    });
    expect((await get(`/v1/listings/${publicId}`)).status).toBe(404);
    const byProject = (await (await get(`/v1/listings?projectPublicId=${publicId}`)).json()) as Page;
    expect(byProject.items).toHaveLength(1);
  });
});

describe('change feed and freshness', () => {
  it('withdrawal is visible at once in detail, list and feed (US-33 AC4)', async () => {
    const data = await publish('toClose', { locality: 'Juhu', micromarket: 'Juhu' });
    expect((await get(`/v1/listings/${ids['toClose']}`)).status).toBe(200);
    await h.event(
      'offer.commercial_status_changed.v1',
      { offerId: data.offerId, from: 'Available', to: 'Closed' },
      { producer: 'journeys' },
    );
    expect((await get(`/v1/listings/${ids['toClose']}`)).status).toBe(404);
    const feed = (await (await get(`/v1/changes?since=${encodeURIComponent(started)}`)).json()) as {
      items: { changeType: string; publicId: string; level: string | null }[];
      nextCursor: string;
      hasMore: boolean;
    };
    const mine = feed.items.filter((i) => i.publicId === ids['toClose']);
    expect(mine.map((i) => i.changeType)).toEqual(['published', 'withdrawn']);
    expect(mine[1]?.level).toBeNull();
    // Resume from the cursor: nothing new, cursor stays usable.
    const after = (await (await get(`/v1/changes?since=${feed.nextCursor}`)).json()) as {
      items: unknown[];
      nextCursor: string;
    };
    expect(after.items).toEqual([]);
    expect(after.nextCursor).toBeTruthy();
  });

  it('pages the feed, 410 beyond 30 days, 400 on garbage; not cached like lists', async () => {
    const page = await get(`/v1/changes?since=${encodeURIComponent(started)}&limit=2`);
    expect(page.headers.get('cache-control')).toBe('public, s-maxage=5');
    const body = (await page.json()) as { items: unknown[]; hasMore: boolean };
    expect(body.items).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const expired = await get(`/v1/changes?since=${encodeURIComponent(old)}`);
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { code: string }).code).toBe('change-feed-expired');
    expect((await get('/v1/changes?since=garbage')).status).toBe(400);
  });
});

describe('tenant isolation (NFR-15)', () => {
  it('a key of another tenant sees nothing of this tenant', async () => {
    const otherTenant = randomUUID();
    const r = await call(h, 'POST', '/v1/api-keys', await h.staff('Admin', { tenant: otherTenant }), {
      name: 'other',
    });
    const other = ((await r.json()) as { secret: string }).secret;
    expect(((await (await get('/v1/listings', other)).json()) as Page).items).toEqual([]);
    expect((await get(`/v1/listings/${ids['rent2']}`, other)).status).toBe(404);
    const feed = (await (await get(`/v1/changes?since=${encodeURIComponent(started)}`, other)).json()) as {
      items: unknown[];
    };
    expect(feed.items).toEqual([]);
  });
});
