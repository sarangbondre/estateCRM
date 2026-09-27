// Local latency check against the records LLD §8 targets (run with RECORDS_PERF=1; skipped otherwise). In-process
// requests on the local Postgres, so the numbers exclude the network and web; the load test (REL-02) is the proof.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate } from '@11e/testing';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { FakeIntake, toIntakeRow } from './support/intake.js';

const run = process.env['RECORDS_PERF'] === '1';
const intake = new FakeIntake();
let h: Harness;

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
async function time(n: number, fn: (i: number) => Promise<unknown>) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    out.push(performance.now() - t0);
  }
  return { p50: Math.round(pct(out, 0.5) * 10) / 10, p95: Math.round(pct(out, 0.95) * 10) / 10 };
}

describe.skipIf(!run)('records latency (LLD §8)', () => {
  beforeAll(async () => {
    h = await createHarness({ intake });
  });
  afterAll(() => h?.close());

  it('measures the hot paths', { timeout: 600_000 }, async () => {
    const t = await readyTenant(h);
    const rows = generate({ rows: 2000, seed: 5, errorRate: 0 }).map((r, i) => toIntakeRow(r.row as Parameters<typeof toIntakeRow>[0], i + 1));
    const results: Record<string, unknown> = {};
    const started = performance.now();
    for (let b = 0; b < rows.length; b += 500) {
      const uploadId = randomUUID();
      intake.add(uploadId, 1, rows.slice(b, b + 500));
      await h.deliver({ eventType: 'rows.classified.v1', tenantId: t, data: { uploadId, batchNo: 1, rows: [] } });
    }
    results['ingestMsPerRow'] = Math.round(((performance.now() - started) / rows.length) * 10) / 10;
    const staff = await h.staff(t, 'Supply agent');
    const offers = (await h.call('GET', '/v1/offers?limit=100', staff)).body.items ?? [];
    const powai = (await h.call('GET', '/v1/micromarkets?q=powai', staff)).body.items?.[0]?.['id'];
    results['getOffer'] = await time(200, (i) => h.call('GET', `/v1/offers/${String(offers[i % offers.length]?.['id'])}`, staff));
    results['listOffers'] = await time(100, () => h.call('GET', '/v1/offers?limit=25', staff));
    results['listOffersFiltered'] = await time(100, () => h.call('GET', `/v1/offers?dealType=Sale&micromarketId=${String(powai)}&limit=25`, staff));
    results['listDemands'] = await time(100, () => h.call('GET', '/v1/demands?limit=25', staff));
    results['quickAddLookup'] = await time(100, (i) => h.call('POST', '/v1/quick-add/lookup', staff, { phone: `+9190005${String(10000 + i).slice(-5)}` }));
    results['createProperty'] = await time(50, (i) =>
      h.call('POST', '/v1/properties', staff, {
        property: { segment: 'Commercial', propertyTypes: ['Office'], locality: 'Worli', city: 'Mumbai', areaSqftMin: 1000 + i * 37 },
        offers: [{ dealType: 'Lease', rentMonthlyInrMin: 100_000 + i }],
        confirmNewDespiteCandidates: true,
      }),
    );
    process.stdout.write(`records perf ${JSON.stringify(results)}\n`);
    expect((results['getOffer'] as { p95: number }).p95).toBeLessThan(300);
  });
});
