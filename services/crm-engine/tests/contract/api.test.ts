// ENG-05 / ENG-07 contract tests: every operation of contracts/openapi/crm-engine.yaml exercised for its main success
// path and at least one error path, with response validation on (a mismatch is a 500 contract-violation).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import {
  deliver,
  envelopeFor,
  matchesOf,
  officeDemandFacts,
  officeFacts,
  settle,
} from '../pipeline-helpers.js';
import { SOURCE } from '../unit/fixtures.js';

let h: Harness;
let demand: string;
let demandCode: string;
let offer: string;
let offerCode: string;
let floors: [string, string];
let lateOffer: string;

async function call(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
) {
  const res = await h.app.request(path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (res.status === 500) throw new Error(`500 on ${method} ${path}: ${text}`);
  return { status: res.status, body, headers: res.headers };
}

beforeAll(async () => {
  h = await harness();
  await h.tx((s) => s.hierarchy.replace(h.tenant, SOURCE, 1));
  demand = randomUUID();
  demandCode = `DEM-${demand.slice(0, 6)}`;
  offer = randomUUID();
  offerCode = `INV-${offer.slice(0, 5)}`;
  floors = [randomUUID(), randomUUID()];
  lateOffer = randomUUID();
  await deliver(
    h,
    envelopeFor(
      h,
      'demand.created.v1',
      demand,
      1,
      officeDemandFacts(demand, { code: demandCode, moveInBy: '2026-12-15' }),
    ),
  );
  await deliver(h, envelopeFor(h, 'offer.created.v1', offer, 1, officeFacts(offer, { code: offerCode })));
  for (const [i, f] of floors.entries())
    await deliver(
      h,
      envelopeFor(
        h,
        'offer.created.v1',
        f,
        1,
        officeFacts(f, {
          areaSqftMin: 3200 - i * 200,
          areaSqftMax: 3200 - i * 200,
          rentMonthlyInrMin: 400_000,
          buildingKey: 'bk-contract',
        }),
      ),
    );
  await deliver(
    h,
    envelopeFor(
      h,
      'offer.created.v1',
      lateOffer,
      1,
      officeFacts(lateOffer, { possessionStatus: 'Available From', possessionDate: '2027-02' }),
    ),
  );
  await settle(h);
});
afterAll(() => h.close());

const single = async () =>
  (await matchesOf(h, demand)).find((m) => !m.is_bundle && m.offer_ids.includes(offer));
const bundleMatch = async () => (await matchesOf(h, demand)).find((m) => m.is_bundle);

describe('matches', () => {
  it('listDemandMatches: single + bundle, by id or code, paging, filters; 404; 400', async () => {
    const byId = await call('GET', `/v1/demands/${demand}/matches`, { headers: await h.staff() });
    expect(byId.status).toBe(200);
    const items = byId.body['items'] as {
      id: string;
      isBundle: boolean;
      demandCode: string;
      offerCodes: string[];
      rank: number;
    }[];
    expect(items).toHaveLength(2);
    expect(items.find((m) => !m.isBundle)).toMatchObject({ demandCode, offerCodes: [offerCode] });
    expect(items.map((m) => m.rank).sort()).toEqual([1, 2]);
    const byCode = await call('GET', `/v1/demands/${demandCode}/matches?limit=1`, {
      headers: await h.staff('Data operator'),
    });
    expect(byCode.status).toBe(200);
    expect((byCode.body['items'] as unknown[]).length).toBe(1);
    const next = await call(
      'GET',
      `/v1/demands/${demandCode}/matches?limit=1&cursor=${String(byCode.body['nextCursor'])}`,
      { headers: await h.staff() },
    );
    expect((next.body['items'] as { id: string }[])[0]?.id).toBe(items[1]?.id);
    expect(next.body['nextCursor']).toBeNull();
    const bundles = await call('GET', `/v1/demands/${demand}/matches?bundlesOnly=true`, {
      headers: await h.staff(),
    });
    expect((bundles.body['items'] as { isBundle: boolean }[]).every((m) => m.isBundle)).toBe(true);
    const flagged = await call('GET', `/v1/demands/${demand}/matches?flag=reconfirm`, {
      headers: await h.staff(),
    });
    expect(flagged.body['items']).toEqual([]);
    expect(
      (await call('GET', `/v1/demands/${randomUUID()}/matches`, { headers: await h.staff() })).status,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/demands/${demand}/matches?status=Nope`, { headers: await h.staff() })).status,
    ).toBe(400);
    expect(
      (await call('GET', `/v1/demands/${demand}/matches?cursor=%%%`, { headers: await h.staff() })).status,
    ).toBe(400);
  });

  it('listOfferMatches: 200 by code; 404; 401 without a token', async () => {
    const r = await call('GET', `/v1/offers/${offerCode}/matches`, {
      headers: await h.staff('Supply agent'),
    });
    expect(r.status).toBe(200);
    expect((r.body['items'] as { demandId: string }[])[0]?.demandId).toBe(demand);
    expect((await call('GET', `/v1/offers/INV-NOPE/matches`, { headers: await h.staff() })).status).toBe(404);
    expect((await call('GET', `/v1/offers/${offer}/matches`)).status).toBe(401);
  });

  it('getMatch by id and code; 404', async () => {
    const m = await single();
    const byId = await call('GET', `/v1/matches/${m?.id}`, { headers: await h.staff() });
    expect(byId.body).toMatchObject({ id: m?.id, code: m?.code, status: 'Suggested', origin: 'engine' });
    expect((await call('GET', `/v1/matches/${m?.code}`, { headers: await h.staff() })).status).toBe(200);
    expect((await call('GET', `/v1/matches/MAT-999999`, { headers: await h.staff() })).status).toBe(404);
  });

  it('explainMatch: hard filters, factor breakdown, bundle grouping; 404', async () => {
    const m = await single();
    const r = await call('GET', `/v1/matches/${m?.id}/explanation`, { headers: await h.staff() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ matchId: m?.id, score: 100, weightsVersion: 0, bundle: null });
    expect((r.body['hardFilters'] as { passed: boolean }[]).every((f) => f.passed)).toBe(true);
    expect((r.body['factors'] as { factor: string }[]).map((f) => f.factor)).toEqual([
      'micromarket',
      'price',
      'area',
      'bhk',
      'timing',
      'furnishing',
    ]);
    const b = await bundleMatch();
    const rb = await call('GET', `/v1/matches/${b?.code}/explanation`, { headers: await h.staff() });
    expect(rb.body['bundle']).toMatchObject({ grouping: 'same_building', combinedAreaSqft: 6200 });
    expect(
      (await call('GET', `/v1/matches/${randomUUID()}/explanation`, { headers: await h.staff() })).status,
    ).toBe(404);
  });
});

describe('confirm and reject', () => {
  it('confirmMatch: 200 Confirmed, idempotent replay, unchanged on repeat; 403 for Supply agent', async () => {
    const m = await single();
    const key = randomUUID();
    const headers = { ...(await h.staff('Demand agent')), 'idempotency-key': key };
    const first = await call('POST', `/v1/matches/${m?.id}/confirm`, { headers, body: {} });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'Confirmed', confirmedBy: h.user, rank: null });
    const replay = await call('POST', `/v1/matches/${m?.id}/confirm`, { headers, body: {} });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);
    const again = await call('POST', `/v1/matches/${m?.id}/confirm`, { headers: await h.staff('Manager') });
    expect(again.status).toBe(200);
    expect(again.body['version']).toBe(first.body['version']);
    expect(
      (await call('POST', `/v1/matches/${m?.id}/confirm`, { headers: await h.staff('Supply agent') })).status,
    ).toBe(403);
    expect(
      (await call('POST', `/v1/matches/${randomUUID()}/confirm`, { headers: await h.staff() })).status,
    ).toBe(404);
  });

  it('rejectMatch: 409 match-in-deal while a deal is open; 200 after; confirm of a Rejected match → 409', async () => {
    const m = await single();
    const dealId = randomUUID();
    await deliver(
      h,
      envelopeFor(
        h,
        'deal.opened.v1',
        dealId,
        1,
        { dealId, code: 'DEAL-0001', demandId: demand, offerId: offer },
        'journeys',
      ),
    );
    const inDeal = await call('POST', `/v1/matches/${m?.id}/reject`, {
      headers: await h.staff(),
      body: { reasonCode: 'too_expensive' },
    });
    expect(inDeal.status).toBe(409);
    expect(inDeal.body).toMatchObject({ code: 'match-in-deal', correlationId: expect.any(String) });
    await deliver(
      h,
      envelopeFor(
        h,
        'deal.cancelled.v1',
        dealId,
        2,
        { dealId, demandId: demand, offerId: offer, reason: 'x' },
        'journeys',
      ),
    );
    const ok = await call('POST', `/v1/matches/${m?.id}/reject`, {
      headers: await h.staff(),
      body: { reasonCode: 'too_expensive' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'Rejected', rejectedReason: 'too_expensive' });
    const conflict = await call('POST', `/v1/matches/${m?.id}/confirm`, { headers: await h.staff() });
    expect(conflict).toMatchObject({ status: 409, body: { code: 'invalid-match-status' } });
    expect(
      (await call('POST', `/v1/matches/${m?.id}/reject`, { headers: await h.staff(), body: {} })).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/v1/matches/${m?.id}/reject`, {
          headers: await h.staff(),
          body: { reasonCode: 'nope' },
        })
      ).status,
    ).toBe(400);
  });

  it('an Idempotency-Key reused with a different body → 409 idempotency-key-reused', async () => {
    const b = await bundleMatch();
    const headers = { ...(await h.staff()), 'idempotency-key': randomUUID() };
    expect(
      (await call('POST', `/v1/matches/${b?.id}/reject`, { headers, body: { reasonCode: 'too_small' } }))
        .status,
    ).toBe(200);
    const reused = await call('POST', `/v1/matches/${b?.id}/reject`, {
      headers,
      body: { reasonCode: 'other' },
    });
    expect(reused).toMatchObject({ status: 409, body: { code: 'idempotency-key-reused' } });
  });
});

describe('bundles', () => {
  it('createBundle: 201, same set → 200 existing; Supply agent confirm → 403; rule and filter errors → 400', async () => {
    const d2 = randomUUID();
    await deliver(
      h,
      envelopeFor(
        h,
        'demand.created.v1',
        d2,
        1,
        officeDemandFacts(d2, { areaSqftMin: 5000, areaSqftMax: 8000 }),
      ),
    );
    const created = await call('POST', '/v1/bundles', {
      headers: await h.staff('Supply agent'),
      body: { demandId: d2, offerIds: floors },
    });
    expect(created.status).toBe(201);
    expect(created.body['bundle']).toMatchObject({
      grouping: 'same_building',
      combinedAreaSqft: 6200,
      origin: 'user',
    });
    expect(created.body['match']).toMatchObject({ status: 'Suggested', isBundle: true, origin: 'user' });
    const same = await call('POST', '/v1/bundles', {
      headers: await h.staff(),
      body: { demandId: d2, offerIds: [...floors].reverse() },
    });
    expect(same.status).toBe(200);
    expect((same.body['bundle'] as { id: string }).id).toBe((created.body['bundle'] as { id: string }).id);
    expect(
      (
        await call('POST', '/v1/bundles', {
          headers: await h.staff('Supply agent'),
          body: { demandId: d2, offerIds: floors, confirm: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', '/v1/bundles', {
          headers: await h.staff(),
          body: { demandId: d2, offerIds: [offer] },
        })
      ).status,
    ).toBe(400); // minItems
    const big = randomUUID();
    await deliver(
      h,
      envelopeFor(
        h,
        'demand.created.v1',
        big,
        1,
        officeDemandFacts(big, { areaSqftMin: 9000, areaSqftMax: 12000 }),
      ),
    );
    const small = await call('POST', '/v1/bundles', {
      headers: await h.staff(),
      body: { demandId: big, offerIds: floors },
    });
    expect(small).toMatchObject({ status: 400, body: { code: 'bundle-area-insufficient' } });
    const late = await call('POST', '/v1/bundles', {
      headers: await h.staff(),
      body: { demandId: demand, offerIds: [floors[0], lateOffer] },
    });
    expect(late).toMatchObject({ status: 400, body: { code: 'bundle-hard-filter-failed' } });
    expect((late.body['errors'] as { field: string; code: string }[])[0]).toMatchObject({
      field: 'offerIds[1]',
      code: 'possession_window',
    });
    expect(
      (
        await call('POST', '/v1/bundles', {
          headers: await h.staff(),
          body: { demandId: randomUUID(), offerIds: floors },
        })
      ).status,
    ).toBe(404);
  });

  it('createBundle: Residential demand → bundle-segment-not-allowed; exited demand → demand-not-matchable', async () => {
    const res = randomUUID();
    await deliver(
      h,
      envelopeFor(
        h,
        'demand.created.v1',
        res,
        1,
        officeDemandFacts(res, { segment: 'Residential', propertyTypes: ['Apartment'] }),
      ),
    );
    expect(
      (
        await call('POST', '/v1/bundles', {
          headers: await h.staff(),
          body: { demandId: res, offerIds: floors },
        })
      ).body['code'],
    ).toBe('bundle-segment-not-allowed');
    const gone = randomUUID();
    await deliver(h, envelopeFor(h, 'demand.created.v1', gone, 1, officeDemandFacts(gone)));
    await deliver(
      h,
      envelopeFor(h, 'demand.exited.v1', gone, 2, { demandId: gone, exit: 'Invalid' }, 'journeys'),
    );
    const r = await call('POST', '/v1/bundles', {
      headers: await h.staff(),
      body: { demandId: gone, offerIds: floors },
    });
    expect(r).toMatchObject({ status: 409, body: { code: 'demand-not-matchable' } });
  });

  it('getBundle by id and code; 404', async () => {
    const b = await bundleMatch();
    const bundle = await h.tx((s) => s.bundles.get(h.tenant, b?.bundle_id as string));
    const r = await call('GET', `/v1/bundles/${bundle?.code}`, { headers: await h.staff() });
    expect(r.body).toMatchObject({ id: bundle?.id, matchId: b?.id });
    expect((await call('GET', `/v1/bundles/${randomUUID()}`, { headers: await h.staff() })).status).toBe(404);
  });
});

describe('exclusions, runs, weights', () => {
  it('listDemandExclusions: "Available too late" with dates; reason filter; 404', async () => {
    const r = await call('GET', `/v1/demands/${demandCode}/exclusions`, { headers: await h.staff() });
    expect(r.status).toBe(200);
    expect(r.body['items']).toEqual([
      expect.objectContaining({
        offerId: lateOffer,
        reason: 'available_too_late',
        availableFrom: '2027-02-01',
        moveInBy: '2026-12-15',
        detail: 'Available from 2027-02-01, demand needs by 2026-12-15',
      }),
    ]);
    const none = await call('GET', `/v1/demands/${demand}/exclusions?reason=offer_expired`, {
      headers: await h.staff(),
    });
    expect(none.body['items']).toEqual([]);
    expect((await call('GET', `/v1/demands/DEM-NOPE/exclusions`, { headers: await h.staff() })).status).toBe(
      404,
    );
  });

  it('rerunDemandMatching → 202 queued (an active run is reused); getMatchingRun; 409 for an exited demand', async () => {
    const r = await call('POST', `/v1/demands/${demand}/matching-runs`, {
      headers: await h.staff(),
      body: { reason: 'manual' },
    });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      status: 'queued',
      statusUrl: `/v1/matching-runs/${String(r.body['runId'])}`,
    });
    const again = await call('POST', `/v1/demands/${demand}/matching-runs`, { headers: await h.staff() });
    expect(again.body['runId']).toBe(r.body['runId']);
    await settle(h);
    const run = await call('GET', `/v1/matching-runs/${String(r.body['runId'])}`, {
      headers: await h.staff('Data operator'),
    });
    expect(run.body).toMatchObject({
      scope: 'demand',
      subjectId: demand,
      status: 'done',
      trigger: 'manual:manual',
    });
    expect(
      (await call('GET', `/v1/matching-runs/${randomUUID()}`, { headers: await h.staff() })).status,
    ).toBe(404);
    const gone = randomUUID();
    await deliver(h, envelopeFor(h, 'demand.created.v1', gone, 1, officeDemandFacts(gone)));
    await deliver(
      h,
      envelopeFor(h, 'demand.exited.v1', gone, 2, { demandId: gone, exit: 'Lost' }, 'journeys'),
    );
    expect(
      (await call('POST', `/v1/demands/${gone}/matching-runs`, { headers: await h.staff() })).body['code'],
    ).toBe('demand-not-matchable');
    expect(
      (await call('POST', `/v1/demands/${demand}/matching-runs`, { headers: await h.staff('Supply agent') }))
        .status,
    ).toBe(403);
  });

  it('getWeights (defaults, version 0); putWeights (Admin): new version, 412, 400 weights-invalid, 403', async () => {
    const w = await call('GET', '/v1/weights', { headers: await h.staff('Data operator') });
    expect(w.body).toMatchObject({
      version: 0,
      factors: { micromarket: 0.25, price: 0.25, area: 0.2 },
      tuning: { minScore: 40, topNPerDemand: 20 },
    });
    const body = { ...w.body, factors: { ...(w.body['factors'] as object), price: 0.3 } };
    const admin = await h.staff('Admin');
    const put = await call('PUT', '/v1/weights', { headers: { ...admin, 'if-match': '0' }, body });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ version: 1, factors: { price: 0.3 }, updatedBy: h.user });
    const same = await call('PUT', '/v1/weights', { headers: admin, body });
    expect(same.body['version']).toBe(1); // PUT is idempotent
    expect((await call('PUT', '/v1/weights', { headers: { ...admin, 'if-match': '0' }, body })).status).toBe(
      412,
    );
    const zero = {
      ...body,
      factors: { micromarket: 0, price: 0, area: 0, bhk: 0, timing: 0, furnishing: 0 },
    };
    expect((await call('PUT', '/v1/weights', { headers: admin, body: zero })).body['code']).toBe(
      'weights-invalid',
    );
    expect((await call('PUT', '/v1/weights', { headers: await h.staff('Manager'), body })).status).toBe(403);
    expect((await call('GET', '/v1/weights', { headers: await h.staff() })).body['version']).toBe(1);
  });
});

describe('internal', () => {
  it('listMatchesForRebuild: service token only, keyset paging, demand filter', async () => {
    const svcHeaders = await h.service('journeys');
    const r = await call('GET', `/internal/v1/matches?limit=2&demandId=${demand}`, { headers: svcHeaders });
    expect(r.status).toBe(200);
    expect((r.body['items'] as { demandId: string }[]).every((m) => m.demandId === demand)).toBe(true);
    if (r.body['nextCursor']) {
      const next = await call(
        'GET',
        `/internal/v1/matches?limit=2&demandId=${demand}&cursor=${String(r.body['nextCursor'])}`,
        { headers: svcHeaders },
      );
      expect(next.status).toBe(200);
    }
    const since = await call(
      'GET',
      `/internal/v1/matches?updatedSince=${encodeURIComponent('2999-01-01T00:00:00Z')}`,
      { headers: svcHeaders },
    );
    expect(since.body['items']).toEqual([]);
    expect(
      (await call('GET', '/internal/v1/matches', { headers: await h.staff() })).status,
    ).toBeGreaterThanOrEqual(401);
    expect((await call('GET', '/internal/v1/matches')).status).toBe(401);
  });
});

describe('tenant isolation (NFR-15)', () => {
  it("another tenant's staff sees nothing of this tenant", async () => {
    const other = { tenant: randomUUID(), user: randomUUID() };
    const m = await bundleMatch();
    const headers = await h.staff('Admin', other);
    expect((await call('GET', `/v1/matches/${m?.id}`, { headers })).status).toBe(404);
    expect((await call('GET', `/v1/demands/${demand}/matches`, { headers })).status).toBe(404);
    expect((await call('GET', `/v1/offers/${offer}/matches`, { headers })).status).toBe(404);
    expect((await call('POST', `/v1/matches/${m?.id}/confirm`, { headers })).status).toBe(404);
    expect((await call('GET', '/v1/weights', { headers })).body['version']).toBe(0);
    const rebuild = await call('GET', '/internal/v1/matches', {
      headers: await h.service('insight', { tenant: other.tenant }),
    });
    expect(rebuild.body['items']).toEqual([]);
  });
});

describe('coverage', () => {
  it('every contract operation has a handler (19 operations)', () => {
    expect(h.svc.unimplemented()).toEqual([]);
    expect([...h.svc.contract.operations.keys()]).toHaveLength(19);
  });
});
