// ENG-07 performance check on the local stack against the LLD §8 / capacity plan targets:
// - one demand-side run (candidates ≤ 5,000 + scoring + bundles + upserts): p95 ≤ 500 ms;
// - read APIs (NFR-2): p95 < 300 ms (capacity plan: ~100 ms average service time).
// A dense cell is seeded directly through the projection repository (synthetic, PII-free).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rescoreDemand, rescoreOffer } from '../../src/application/pipeline.js';
import type { DemandRecord, OfferRecord } from '../../src/application/ports.js';
import { harness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { SOURCE, demand as demandMx, hierarchy, offer as offerMx } from '../unit/fixtures.js';

const OFFERS = Number(process.env['PERF_OFFERS'] ?? 3000);
const DEMANDS = Number(process.env['PERF_DEMANDS'] ?? 60);
const LOCALITIES = ['Marol', 'Chakala', 'MIDC', 'Saki Naka', 'Marol Naka'];

let h: Harness;
const offerIds: string[] = [];
const demandIds: string[] = [];

const p = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] as number;
};
const report = (label: string, xs: number[]) =>
  process.stdout.write(
    `[perf] ${label}: n=${xs.length} p50=${p(xs, 0.5).toFixed(1)}ms p95=${p(xs, 0.95).toFixed(1)}ms max=${Math.max(...xs).toFixed(1)}ms\n`,
  );

beforeAll(async () => {
  h = await harness();
  await h.tx((s) => s.hierarchy.replace(h.tenant, SOURCE, 1));
  for (let batch = 0; batch < OFFERS; batch += 500)
    await h.tx(async (s) => {
      for (let i = batch; i < Math.min(OFFERS, batch + 500); i++) {
        const area = 800 + ((i * 37) % 60) * 150; // 800 … 9,650 sq ft
        const locality = LOCALITIES[i % LOCALITIES.length] as string;
        const o = offerMx({
          id: randomUUID(),
          tenantId: h.tenant,
          code: `INV-P${i}`,
          areaSqftMin: area,
          areaSqftMax: area,
          rentMonthlyInrMin: area * (120 + (i % 40)),
          locality,
          buildingKey: `bk-${i % 400}`,
          mmPath: hierarchy.offerPath('Andheri East', locality),
        });
        offerIds.push(o.id);
        await s.mx.saveOffer({
          ...o,
          zone: null,
          priceVersion: 1,
          lifeVersion: 0,
          commercialVersion: 0,
        } as OfferRecord);
      }
    });
  await h.tx(async (s) => {
    for (let i = 0; i < DEMANDS; i++) {
      const min = 2000 + (i % 12) * 500;
      const d = demandMx({
        id: randomUUID(),
        tenantId: h.tenant,
        code: `DEM-P${i}`,
        areaSqftMin: min,
        areaSqftMax: min * 1.4,
        rentMonthlyInrMin: null,
        rentMonthlyInrMax: min * 160,
        micromarkets: ['Andheri East'],
        localities: i % 2 ? [LOCALITIES[i % LOCALITIES.length] as string] : [],
      });
      demandIds.push(d.id);
      await s.mx.saveDemand({
        ...d,
        ownerUserId: null,
        factsVersion: 1,
        lifeVersion: 0,
        statusVersion: 0,
      } as DemandRecord);
    }
  });
}, 300_000);
afterAll(() => h.close());

describe(`matching performance (${OFFERS} offers in one cell, ${DEMANDS} demands)`, () => {
  it('demand-side runs: p95 ≤ 500 ms (LLD §8)', async () => {
    const times: number[] = [];
    let suggested = 0;
    for (const id of demandIds) {
      const t0 = performance.now();
      const stats = await h.tx((s) => rescoreDemand(s, h.deps.clock, h.tenant, id));
      times.push(performance.now() - t0);
      suggested += stats?.suggested ?? 0;
    }
    report('demand-side run', times);
    expect(suggested).toBeGreaterThan(0);
    expect(p(times, 0.95)).toBeLessThan(500);
  }, 300_000);

  it('offer-side runs (offer against every candidate demand)', async () => {
    const times: number[] = [];
    for (const id of offerIds.slice(0, 30)) {
      const t0 = performance.now();
      await h.tx((s) => rescoreOffer(s, h.deps.clock, h.tenant, id));
      times.push(performance.now() - t0);
    }
    report('offer-side run', times);
    expect(p(times, 0.95)).toBeLessThan(2000);
  }, 300_000);

  it('read APIs: p95 < 300 ms (NFR-2)', async () => {
    const headers = await h.staff('Demand agent');
    const lists: number[] = [];
    const explains: number[] = [];
    for (let i = 0; i < 100; i++) {
      const id = demandIds[i % demandIds.length] as string;
      let t0 = performance.now();
      const r = await h.app.request(`/v1/demands/${id}/matches?limit=20`, { headers });
      lists.push(performance.now() - t0);
      const items = ((await r.json()) as { items: { id: string }[] }).items;
      if (items[0]) {
        t0 = performance.now();
        await h.app.request(`/v1/matches/${items[0].id}/explanation`, { headers });
        explains.push(performance.now() - t0);
      }
    }
    report('GET /v1/demands/{id}/matches', lists);
    report('GET /v1/matches/{id}/explanation', explains);
    expect(p(lists, 0.95)).toBeLessThan(300);
    expect(p(explains, 0.95)).toBeLessThan(300);
  }, 300_000);
});
