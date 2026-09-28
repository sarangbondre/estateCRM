// REC-02 reference data: vocabulary release v0.6 + vocabulary.released.v1, micromarkets (aliases, adjacency,
// micromarkets.updated.v1), launch area (R-9) and the recompute-launch-area job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseContent } from '@11e/vocabulary';
import { activateVocabulary, releaseChecksum } from '../src/application/reference.js';
import { systemActor } from '../src/application/context.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('vocabulary', () => {
  it('activates v0.6 once per tenant and publishes vocabulary.released.v1', async () => {
    const t = newTenant();
    const first = await activateVocabulary(h.appCtx, systemActor(t, 'test'));
    expect(first.activated).toBe('v0.6');
    const again = await activateVocabulary(h.appCtx, systemActor(t, 'test'));
    expect(again.activated).toBeNull();
    const events = await h.events(t, 'vocabulary.released.v1');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ version: 'v0.6', checksum: releaseChecksum(releaseContent()) });
  });

  it('GET /v1/vocabulary returns the active release (lazy bootstrap), ETag and 304', async () => {
    const t = newTenant();
    const headers = await h.staff(t, 'Supply agent');
    const r = await h.call('GET', '/v1/vocabulary', headers);
    expect(r.status).toBe(200);
    expect(r.body['version']).toBe('v0.6');
    expect(r.body['status']).toBe('active');
    expect((r.body['fields'] as Record<string, unknown>)['deal_type']).toBeTruthy();
    const etag = r.headers.get('etag') ?? '';
    const cached = await h.app.request('/v1/vocabulary', { headers: { ...headers, 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    expect((await h.call('GET', '/v1/vocabulary?version=v9.9', headers)).status).toBe(404);
  });

  it('services read the vocabulary with a service token; versions are listed', async () => {
    const t = newTenant();
    const r = await h.call('GET', '/v1/vocabulary', await h.service(t, 'intake'));
    expect(r.status).toBe(200);
    const list = await h.call('GET', '/v1/vocabulary/versions', await h.staff(t));
    expect(list.status).toBe(200);
    expect(list.body.items?.map((i) => i['version'])).toEqual(['v0.6']);
  });

  it('the job endpoint activates for configured tenants', async () => {
    const t = newTenant();
    const h2 = await createHarness({ tenantIds: [t], knownTenants: async () => [] });
    try {
      const r = await h2.call('POST', '/internal/v1/jobs/activate-vocabulary', h2.cron);
      expect(r.status).toBe(200);
      expect(r.body['processed']).toBe(1);
      expect(await h2.events(t, 'vocabulary.released.v1')).toHaveLength(1);
    } finally {
      await h2.close();
    }
  });
});

describe('micromarkets', () => {
  it('seeds the MMR hierarchy with aliases (Andheri East contains Chakala)', async () => {
    const t = newTenant();
    const headers = await h.staff(t, 'Demand agent');
    const zones = await h.call('GET', '/v1/micromarkets?level=zone&limit=100', headers);
    expect(zones.status).toBe(200);
    expect(zones.body.items?.map((z) => z['name'])).toContain('Western Suburbs');
    const andheri = await h.call('GET', '/v1/micromarkets?q=andheri%20east', headers);
    const node = andheri.body.items?.[0];
    expect(node?.['aliases']).toContain('Andheri E');
    const children = await h.call('GET', `/v1/micromarkets?parentId=${String(node?.['id'])}&limit=100`, headers);
    expect(children.body.items?.map((c) => c['name'])).toEqual(expect.arrayContaining(['Chakala', 'Marol', 'MIDC']));
  });

  it('Admin creates a node with adjacency (symmetric), conflicts on a taken alias, patches with If-Match', async () => {
    const t = newTenant();
    const admin = await h.staff(t, 'Admin');
    const powai = (await h.call('GET', '/v1/micromarkets?q=powai', admin)).body.items?.[0];
    const created = await h.call('POST', '/v1/micromarkets', admin, {
      level: 'locality',
      name: 'Test Nagar',
      aliases: ['TN Colony'],
      city: 'Mumbai',
      parentId: powai?.['parentId'],
      adjacentIds: [powai?.['id']],
    });
    expect(created.status).toBe(201);
    expect(created.body['adjacentIds']).toEqual([powai?.['id']]);
    expect(created.body['inLaunchArea']).toBe(true);
    const back = await h.call('GET', `/v1/micromarkets?q=powai`, admin);
    expect(back.body.items?.[0]?.['adjacentIds']).toContain(created.body['id']);

    const dup = await h.call('POST', '/v1/micromarkets', admin, { level: 'locality', name: 'tn  colony', city: 'Mumbai' });
    expect(dup.status).toBe(409);
    expect(dup.body['code']).toBe('micromarket-alias-taken');

    const stale = await h.call('PATCH', `/v1/micromarkets/${String(created.body['id'])}`, { ...admin, 'if-match': '9' }, { name: 'X' });
    expect(stale.status).toBe(412);
    const patched = await h.call('PATCH', `/v1/micromarkets/${String(created.body['id'])}`, { ...admin, 'if-match': '1' }, { aliases: [] });
    expect(patched.status).toBe(200);
    expect(patched.body['version']).toBe(2);

    const events = await h.events(t, 'micromarkets.updated.v1');
    expect(events.map((e) => e.data['version'])).toEqual([2, 3]);
    expect(events.every((e) => e.aggregateId === t)).toBe(true);
  });

  it('only Admin may change the hierarchy', async () => {
    const t = newTenant();
    const r = await h.call('POST', '/v1/micromarkets', await h.staff(t, 'Manager'), { level: 'zone', name: 'Z', city: 'Mumbai' });
    expect(r.status).toBe(403);
  });
});

describe('launch area', () => {
  it('starts with the MMR cities; PUT replaces the list (202), flags nodes and queues the recompute', async () => {
    const t = newTenant();
    const admin = await h.staff(t, 'Admin');
    const got = await h.call('GET', '/v1/launch-area', admin);
    expect(got.status).toBe(200);
    const names = (got.body['cities'] as { name: string }[]).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Mumbai', 'Navi Mumbai', 'Thane']));
    const put = await h.call('PUT', '/v1/launch-area', { ...admin, 'if-match': String(got.body['version']) }, {
      cities: [
        { name: 'Mumbai', enabled: true },
        { name: 'Thane', enabled: false },
      ],
    });
    expect(put.status).toBe(202);
    expect(put.body['recomputeStatus']).toBe('queued');
    expect(put.body['version']).toBe(Number(got.body['version']) + 1);
    const thane = (await h.call('GET', '/v1/micromarkets?q=thane%20west', admin)).body.items?.[0];
    expect(thane?.['inLaunchArea']).toBe(false);
    const conflict = await h.call('PUT', '/v1/launch-area', { ...admin, 'if-match': '1' }, { cities: [] });
    expect(conflict.status).toBe(412);
  });
});
