// Contract conformance (JOU-11): every operation of contracts/openapi/journeys.yaml has a handler, rejects callers
// without credentials, and the few operations not covered by the feature suites get their success path here.
// Responses are validated against the contract in tests (validateResponses); global-setup checks that every operation
// was exercised with a 2xx and a 4xx across the whole run (JOURNEYS_CONTRACT_COVERAGE=1).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventDataMap } from '@11e/contracts/events';
import { buildSnapshot } from '../src/application/proposals.js';
import { ensureMigrated, env, harness, ids } from './helpers.js';

const h = harness();
const demandAgent = ids();
const manager = ids();
beforeAll(async () => {
  await ensureMigrated();
  h.clock.day('2026-09-01');
  for (const [userId, role] of [
    [demandAgent, 'Demand agent'],
    [manager, 'Manager'],
  ] as const)
    await h.deliver('user.changed.v1', { userId, role, active: true }, { aggregateId: userId });
});
afterAll(() => h.close());

/** Served by libs/http (createService) directly; verified in platform.test.ts. */
const PLATFORM = new Set(['healthLive', 'healthReady']);

const spec = JSON.parse(readFileSync(new URL('../../../contracts/generated/openapi/journeys.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, { operationId: string; security?: unknown[]; parameters?: { name: string; in: string; schema?: { enum?: string[] } }[] }>>;
};
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
    .map(([method, op]) => ({ method: method.toUpperCase(), path, op })),
);

describe('contract', () => {
  it('implements every operation (60)', () => {
    expect(operations).toHaveLength(60);
    expect(h.svc.unimplemented().filter((o) => !PLATFORM.has(o))).toEqual([]);
  });

  it('every protected operation refuses a caller without credentials (401, RFC 7807)', async () => {
    const sample = (p: { name: string; schema?: { enum?: string[] } }) =>
      p.schema?.enum?.[0] ?? (p.name === 'token' ? 'x'.repeat(43) : p.name.toLowerCase().includes('id') ? ids() : 'X-1');
    for (const { method, path, op } of operations) {
      if (PLATFORM.has(op.operationId) || (op.security && op.security.length === 0)) continue;
      let url = path;
      for (const p of op.parameters ?? []) if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(sample(p)));
      const res = await h.app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) });
      expect([401, 400], `${method} ${path}`).toContain(res.status);
      const problem = (await res.json()) as { type: string; code: string; correlationId: string };
      expect(problem.type).toMatch(/^https:\/\/errors\.11estates\.in\//);
      expect(problem.correlationId).toBeTruthy();
    }
  });

  it('site visits and deals: reads, reschedule, cancel; proposal PATCH; a job through the scheduler endpoint', async () => {
    const offerId = ids();
    const o: EventDataMap['offer.created.v1'] = { offerId, code: 'INV-C1', propertyId: ids(), dealType: 'Sale', segment: 'Residential', micromarket: 'Worli' };
    await h.deliver('offer.created.v1', o, { aggregateId: offerId });
    h.content.offers.set(offerId, { id: offerId, dealType: 'Sale', propertyId: o.propertyId });
    const demandId = ids();
    await h.deliver('demand.created.v1', { demandId, code: 'DEM-C1', dealTypes: ['Sale'], segment: 'Residential', micromarkets: ['Worli'], ownerUserId: demandAgent }, { aggregateId: demandId });
    const matchId = ids();
    await h.deliver('match.confirmed.v1', { matchId, demandId, offerIds: [offerId] }, { aggregateId: matchId });
    const da = await h.as(demandAgent, 'Demand agent');

    const v = await da.post('/v1/site-visits', { demandId, offerIds: [offerId], scheduledAt: '2026-09-03T05:30:00Z' });
    expect((await da.get(`/v1/site-visits/${v.body['code']}`)).status).toBe(200);
    expect((await da.get(`/v1/site-visits/${ids()}`)).status).toBe(404);
    expect((await da.get(`/v1/site-visits?demandId=${demandId}&status=Scheduled`)).body.items).toHaveLength(1);
    expect((await da.get(`/v1/site-visits?offerId=${offerId}`)).body.items).toHaveLength(1);
    expect((await da.get('/v1/site-visits?cursor=%%%')).status).toBe(400);
    const moved = await da.patch(`/v1/site-visits/${v.body['id']}`, { scheduledAt: '2026-09-04T05:30:00Z' }, { 'if-match': String(v.body['version']) });
    expect(moved.body['scheduledAt']).toBe('2026-09-04T05:30:00.000Z');
    expect((await da.patch(`/v1/site-visits/${v.body['id']}`, { status: 'Cancelled' }, { 'if-match': '1' })).status).toBe(412);
    expect((await da.patch(`/v1/site-visits/${v.body['id']}`, { status: 'Cancelled' })).body['status']).toBe('Cancelled');
    expect((await da.post(`/v1/site-visits/${v.body['id']}/complete`, { outcome: 'Interested' })).body['code']).toBe('invalid-transition');

    const d = await da.post('/v1/deals', { demandId, offerId, nextAction: 'Negotiate', followUpDate: '2026-09-02' });
    expect((await da.get(`/v1/deals/${d.body['code']}`)).body['stage']).toBe('Negotiation');
    expect((await da.get(`/v1/deals/DEAL-9999`)).status).toBe(404);
    expect((await da.get(`/v1/deals?demandId=${demandId}`)).body.items).toHaveLength(1);
    expect((await da.post(`/v1/deals/${d.body['id']}/follow-ups`, { nextAction: 'x', followUpDate: '2026-01-01' })).body['code']).toBe('follow-up-required');
    expect((await da.get('/v1/lease-renewals?status=bogus')).status).toBe(400);

    const p = await da.post('/v1/proposals', { demandId, options: [{ matchId }] });
    await buildSnapshot({ runner: h.runner, integrations: h.integrations }, { kind: 'build_snapshot', tenantId: h.tenantId, proposalId: p.body['id'] as string, correlationId: 't' }, 1);
    const patched = await da.patch(`/v1/proposals/${p.body['code']}`, { coverNote: 'Sea-facing option' });
    expect(patched.body).toMatchObject({ status: 'Ready', coverNote: 'Sea-facing option' });
    expect((await da.post(`/v1/proposals/${p.body['id']}/feedback`, { options: [{ position: 1, feedback: 'liked' }] })).body['code']).toBe('invalid-transition');
    expect((await da.get(`/v1/proposals/${ids()}/pdf`)).status).toBe(404);
    expect((await da.del(`/v1/proposals/${ids()}/share-link`)).status).toBe(404);
    expect((await da.post(`/v1/proposals/${ids()}/pdf`)).status).toBe(404);

    const job = await h.app.request('/internal/v1/jobs/queue-counts-flush', { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } });
    expect([200, 409]).toContain(job.status); // 409 only if another run holds the lease
  });

  it('role checks and not-found paths on reads', async () => {
    const op = await h.as(ids(), 'Data operator');
    expect((await op.get('/v1/queues/me')).status).toBe(403);
    expect((await op.get('/v1/queues/me/sections/must_call')).status).toBe(403);
    expect((await op.get(`/v1/queues/users/${ids()}/sections/must_call`)).status).toBe(403);
    expect((await op.get('/v1/capacities')).status).toBe(403);
    expect((await op.get(`/v1/offers/${ids()}/journey`)).status).toBe(404);
    expect((await op.get(`/v1/demands/DEM-NOPE/journey`)).status).toBe(404);
    expect((await op.get(`/v1/sourcing-requests/${ids()}`)).status).toBe(404);
    expect((await op.get('/v1/sourcing-requests?status=Nope')).status).toBe(400);
    expect((await op.get(`/v1/proposals/${ids()}`)).status).toBe(404);
    expect((await op.get('/v1/proposals?limit=0')).status).toBe(400);
    expect((await op.get('/v1/deals?stage=Nope')).status).toBe(400);
    expect((await op.get('/v1/notifications?unreadOnly=maybe')).status).toBe(400);
    expect((await op.get('/v1/watchlist-tasks?deadlineWithinDays=999')).status).toBe(400);
    const da = await h.as(demandAgent, 'Demand agent');
    expect((await da.post(`/v1/site-visits/${ids()}/complete`, { outcome: 'Interested' })).status).toBe(404);
    expect((await da.post(`/v1/proposals/${ids()}/feedback`, { options: [{ position: 1, feedback: 'liked' }] })).status).toBe(404);
    expect((await da.post(`/v1/deals/${ids()}/follow-ups`, { nextAction: 'x', followUpDate: '2026-12-01' })).status).toBe(404);
    const noAuth = await h.app.request('/v1/notifications/unread-count');
    expect(noAuth.status).toBe(401);
    expect((await h.app.request('/v1/settings/life-curve-thresholds')).status).toBe(401);
    expect((await h.app.request('/v1/settings/queue-weights')).status).toBe(401);
  });
});
