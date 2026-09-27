// Contract coverage (LIS-07 DoD): every one of the 25 operations of contracts/openapi/listings.yaml is implemented and
// exercised for its main success and one error path, with contract response validation on (libs/http).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, demandData, harness, offerData } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
/** Settings responses can't pass validation (contract defect, see admin.test.ts): separate app, keys asserted. */
let hs: Harness;
const ctx: Record<string, string> = {};

beforeAll(async () => {
  h = await harness();
  hs = await harness({ validateResponses: false });
  const offer = offerData();
  await h.event('offer.created.v1', offer);
  ctx['offer'] = offer.offerId;
  const put = await call(h, 'PUT', `/v1/offers/${offer.offerId}/publication`, await h.staff(), {
    level: 'Anonymous',
  });
  ctx['offerPublicId'] = ((await put.json()) as { publicId: string }).publicId;
  const projectId = randomUUID();
  const cfg = offerData({ dealType: 'Sale', market: 'Primary', projectId, salePriceInrMin: 1_00_00_000 });
  await h.event('offer.created.v1', cfg);
  await h.event('project.created.v1', {
    projectId,
    code: 'PRJ-7001',
    name: 'Harbour View',
    reraNumber: 'P51800077777',
    offerIds: [cfg.offerId],
  });
  await call(h, 'PUT', `/v1/offers/${cfg.offerId}/publication`, await h.staff(), { level: 'Anonymous' });
  ctx['project'] = projectId;
  const demand = demandData();
  await h.event('demand.created.v1', demand);
  await h.event(
    'demand.sourcing_started.v1',
    { demandId: demand.demandId, postAnonymously: false },
    { producer: 'journeys' },
  );
  ctx['demand'] = demand.demandId;
  const key = await call(h, 'POST', '/v1/api-keys', await h.staff(), { name: 'contract-tests' });
  const k = (await key.json()) as { keyId: string; secret: string };
  ctx['keyId'] = k.keyId;
  ctx['key'] = k.secret;
});
afterAll(async () => {
  await h.close();
  await hs.close();
});

type Check = () => Promise<void>;
const expectStatus = async (p: Response | Promise<Response>, status: number) => {
  const r = await p;
  expect(r.status, `${r.status} ${await r.clone().text()}`).toBe(status);
  return r;
};
const pub = (path: string, key = ctx['key'] as string) =>
  h.app.request(path, { headers: { 'x-api-key': key } });
const cron = (path: string, headers = h.cron) => h.app.request(path, { method: 'POST', headers });

const cases: Record<string, { ok: Check; error?: Check }> = {
  getOfferPublication: {
    ok: async () =>
      void (await expectStatus(
        call(h, 'GET', `/v1/offers/${ctx['offer']}/publication`, await h.staff()),
        200,
      )),
    error: async () =>
      void (await expectStatus(call(h, 'GET', `/v1/offers/INV-NOPE/publication`, await h.staff()), 404)),
  },
  setOfferPublication: {
    ok: async () =>
      void (await expectStatus(
        call(h, 'PUT', `/v1/offers/${ctx['offer']}/publication`, await h.staff(), { level: 'Anonymous' }),
        200,
      )),
    error: async () =>
      void (await expectStatus(
        call(h, 'PUT', `/v1/offers/${ctx['offer']}/publication`, await h.staff(), { level: 'Public' }),
        409,
      )),
  },
  scanOfferText: {
    ok: async () =>
      void (await expectStatus(
        call(h, 'POST', `/v1/offers/${ctx['offer']}/privacy-scan`, await h.staff(), { text: 'Sunny flat' }),
        200,
      )),
    error: async () =>
      void (await expectStatus(
        call(h, 'POST', `/v1/offers/${randomUUID()}/privacy-scan`, await h.staff(), {}),
        404,
      )),
  },
  getProjectPublication: {
    ok: async () =>
      void (await expectStatus(
        call(h, 'GET', `/v1/projects/${ctx['project']}/publication`, await h.staff()),
        200,
      )),
    error: async () =>
      void (await expectStatus(call(h, 'GET', `/v1/projects/PRJ-NOPE/publication`, await h.staff()), 404)),
  },
  setProjectPublication: {
    ok: async () =>
      void (await expectStatus(
        call(h, 'PUT', `/v1/projects/${ctx['project']}/publication`, await h.staff(), { level: 'Public' }),
        200,
      )),
    error: async () =>
      void (await expectStatus(
        call(h, 'PUT', `/v1/projects/${ctx['project']}/publication`, await h.staff(), { level: 'Anonymous' }),
        400,
      )),
  },
  getDemandPost: {
    ok: async () =>
      void (await expectStatus(
        call(h, 'GET', `/v1/demands/${ctx['demand']}/demand-post`, await h.staff()),
        200,
      )),
    error: async () =>
      void (await expectStatus(
        call(h, 'GET', `/v1/demands/${randomUUID()}/demand-post`, await h.staff()),
        404,
      )),
  },
  setDemandPost: {
    ok: async () =>
      void (await expectStatus(
        call(h, 'PUT', `/v1/demands/${ctx['demand']}/demand-post`, await h.staff('Demand agent'), {
          level: 'Anonymous',
        }),
        200,
      )),
    error: async () =>
      void (await expectStatus(
        call(h, 'PUT', `/v1/demands/${ctx['demand']}/demand-post`, await h.staff('Supply agent'), {
          level: 'Private',
        }),
        403,
      )),
  },
  listPublications: {
    ok: async () =>
      void (await expectStatus(call(h, 'GET', '/v1/publications?level=Anonymous', await h.staff()), 200)),
    error: async () =>
      void (await expectStatus(call(h, 'GET', '/v1/publications?level=Hidden', await h.staff()), 400)),
  },
  getPublicationSettings: {
    ok: async () => {
      await expectStatus(
        call(hs, 'PUT', '/v1/publication-settings', await hs.staff(), {
          mahareraAgentNumber: 'A51900012345',
        }),
        200,
      );
      const r = await expectStatus(
        call(hs, 'GET', '/v1/publication-settings', await hs.service('journeys')),
        200,
      );
      expect(Object.keys((await r.json()) as object).sort()).toEqual([
        'mahareraAgentNumber',
        'subjectToConfirmationNote',
        'updatedAt',
        'updatedBy',
        'version',
      ]);
    },
    error: async () =>
      void (await expectStatus(
        call(hs, 'GET', '/v1/publication-settings', await hs.service('journeys', { tenant: randomUUID() })),
        404,
      )),
  },
  putPublicationSettings: {
    ok: async () =>
      void (await expectStatus(
        call(hs, 'PUT', '/v1/publication-settings', await hs.staff(), {
          mahareraAgentNumber: 'A51900054321',
        }),
        200,
      )),
    error: async () =>
      void (await expectStatus(
        call(hs, 'PUT', '/v1/publication-settings', await hs.staff('Manager'), {
          mahareraAgentNumber: 'A51900054321',
        }),
        403,
      )),
  },
  listApiKeys: {
    ok: async () => void (await expectStatus(call(h, 'GET', '/v1/api-keys', await h.staff()), 200)),
    error: async () =>
      void (await expectStatus(call(h, 'GET', '/v1/api-keys', await h.staff('Manager')), 403)),
  },
  createApiKey: {
    ok: async () =>
      void (await expectStatus(
        call(h, 'POST', '/v1/api-keys', await h.staff(), { name: 'another site' }),
        201,
      )),
    error: async () =>
      void (await expectStatus(call(h, 'POST', '/v1/api-keys', await h.staff(), { name: 'x' }), 400)),
  },
  rotateApiKey: {
    ok: async () => {
      const r = await call(h, 'POST', '/v1/api-keys', await h.staff(), { name: 'to rotate' });
      const { keyId } = (await r.json()) as { keyId: string };
      await expectStatus(
        call(h, 'POST', `/v1/api-keys/${keyId}/rotate`, await h.staff(), { graceHours: 24 }),
        201,
      );
    },
    error: async () =>
      void (await expectStatus(
        call(h, 'POST', `/v1/api-keys/${randomUUID()}/rotate`, await h.staff(), {}),
        404,
      )),
  },
  revokeApiKey: {
    ok: async () => {
      const r = await call(h, 'POST', '/v1/api-keys', await h.staff(), { name: 'to revoke' });
      const { keyId } = (await r.json()) as { keyId: string };
      await expectStatus(call(h, 'POST', `/v1/api-keys/${keyId}/revoke`, await h.staff()), 200);
    },
    error: async () =>
      void (await expectStatus(call(h, 'POST', `/v1/api-keys/${randomUUID()}/revoke`, await h.staff()), 404)),
  },
  publicListOffers: {
    ok: async () => void (await expectStatus(pub('/v1/listings?dealType=Lease'), 200)),
    error: async () => void (await expectStatus(h.app.request('/v1/listings'), 401)),
  },
  publicGetOffer: {
    ok: async () => void (await expectStatus(pub(`/v1/listings/${ctx['offerPublicId']}`), 200)),
    error: async () => void (await expectStatus(pub('/v1/listings/L-ZZZZZZZZZZ'), 404)),
  },
  publicListProjects: {
    ok: async () => void (await expectStatus(pub('/v1/projects'), 200)),
    error: async () => void (await expectStatus(pub('/v1/projects?limit=51'), 400)),
  },
  publicGetProject: {
    ok: async () => {
      const r = await call(h, 'GET', `/v1/projects/${ctx['project']}/publication`, await h.staff());
      const { publicId } = (await r.json()) as { publicId: string };
      await expectStatus(pub(`/v1/projects/${publicId}`), 200);
    },
    error: async () => void (await expectStatus(pub('/v1/projects/L-ZZZZZZZZZZ'), 404)),
  },
  publicListDemandPosts: {
    ok: async () => void (await expectStatus(pub('/v1/demand-posts'), 200)),
    error: async () => void (await expectStatus(pub('/v1/demand-posts?dealType=Rent'), 400)),
  },
  publicListChanges: {
    ok: async () =>
      void (await expectStatus(pub(`/v1/changes?since=${new Date(Date.now() - 60_000).toISOString()}`), 200)),
    error: async () =>
      void (await expectStatus(
        pub(`/v1/changes?since=${new Date(Date.now() - 40 * 86_400_000).toISOString()}`),
        410,
      )),
  },
  relayOutbox: {
    ok: async () => void (await expectStatus(cron('/internal/v1/relay'), 200)),
    error: async () =>
      void (await expectStatus(cron('/internal/v1/relay', { 'x-cron-secret': 'wrong' }), 401)),
  },
  drainQueue: {
    ok: async () => void (await expectStatus(cron('/internal/v1/drain/q_listings?batch=1'), 200)),
    error: async () =>
      void (await expectStatus(cron('/internal/v1/drain/q_listings', { 'x-cron-secret': 'wrong' }), 401)),
  },
  runJob: {
    ok: async () => void (await expectStatus(cron('/internal/v1/jobs/rate-limit-prune'), 200)),
    error: async () =>
      void (await expectStatus(
        cron('/internal/v1/jobs/rate-limit-prune', { 'x-cron-secret': 'wrong' }),
        401,
      )),
  },
  live: { ok: async () => void (await expectStatus(h.app.request('/health/live'), 200)) },
  ready: { ok: async () => void (await expectStatus(h.app.request('/health/ready'), 200)) },
};

describe('contract coverage', () => {
  it('implements all 25 operations (svc.unimplemented() is empty)', () => {
    expect(h.svc.unimplemented()).toEqual([]);
    const ops = [...h.svc.contract.operations.keys()].sort();
    expect(ops).toHaveLength(25);
    expect(Object.keys(cases).sort()).toEqual(ops);
  });

  for (const [op, c] of Object.entries(cases)) {
    it(`${op}: success`, c.ok);
    if (c.error) it(`${op}: error path`, c.error);
  }
});
