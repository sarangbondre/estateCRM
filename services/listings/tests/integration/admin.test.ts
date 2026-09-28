// Admin (LIS-06): RERA publication settings (journeys reads with a service token) and website API keys.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshProjectionBatch } from '../../src/application/work.js';
import { call, harness, offerData } from '../helpers.js';
import type { Harness } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(() => h.close());

const auditsOf = async (h: Harness, action: string) =>
  (
    await h.deps.db
      .selectFrom('outbox')
      .select('payload')
      .where('tenant_id', '=', h.tenant)
      .where('event_type', '=', 'audit.recorded.v1')
      .execute()
  ).filter((r) => (r.payload as { data: { action: string } }).data.action === action);

/**
 * contracts/openapi/listings.yaml defect: PublicationSettings = allOf [PublicationSettingsInput
 * (additionalProperties: false), {version, updatedAt, updatedBy}] can't be satisfied by any object, so contract response
 * validation is off for this block and the exact response keys are asserted instead (proposed CR in the LIS report).
 */
describe('publication settings', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ validateResponses: false });
  });
  afterAll(() => h.close());
  const audits = (action: string) => auditsOf(h, action);

  it('responds with exactly the PublicationSettings fields', async () => {
    const put = await call(
      h,
      'PUT',
      '/v1/publication-settings',
      await h.staff('Admin', { tenant: randomUUID() }),
      {
        mahareraAgentNumber: 'A51900011111',
      },
    );
    expect(Object.keys((await put.json()) as object).sort()).toEqual(
      ['mahareraAgentNumber', 'subjectToConfirmationNote', 'updatedAt', 'updatedBy', 'version'].sort(),
    );
  });

  it('404 until set; Admin sets it; staff and journeys (service token) read it', async () => {
    expect((await call(h, 'GET', '/v1/publication-settings', await h.staff('Data operator'))).status).toBe(
      404,
    );
    const put = await call(h, 'PUT', '/v1/publication-settings', await h.staff('Admin'), {
      mahareraAgentNumber: 'A51900012345',
    });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await put.json()).toMatchObject({
      mahareraAgentNumber: 'A51900012345',
      subjectToConfirmationNote: 'Details subject to confirmation',
      version: 1,
      updatedBy: h.user,
    });
    const staff = await call(h, 'GET', '/v1/publication-settings', await h.staff('Data operator'));
    expect(staff.status).toBe(200);
    expect(staff.headers.get('etag')).toBe('"1"');
    const journeys = await call(h, 'GET', '/v1/publication-settings', await h.service('journeys'));
    expect(((await journeys.json()) as { mahareraAgentNumber: string }).mahareraAgentNumber).toBe(
      'A51900012345',
    );
    expect((await audits('settings.changed')).length).toBe(1);
  });

  it('Admin only, If-Match, and the number format', async () => {
    expect(
      (
        await call(h, 'PUT', '/v1/publication-settings', await h.staff('Manager'), {
          mahareraAgentNumber: 'A51900012345',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          h,
          'PUT',
          '/v1/publication-settings',
          { ...(await h.staff()), 'if-match': '7' },
          { mahareraAgentNumber: 'A51900099999' },
        )
      ).status,
    ).toBe(412);
    expect(
      (await call(h, 'PUT', '/v1/publication-settings', await h.staff(), { mahareraAgentNumber: '12345' }))
        .status,
    ).toBe(400);
  });

  it('a change refreshes every public item (projection-refresh) with an `updated` feed row', async () => {
    const data = offerData();
    await h.event('offer.created.v1', data);
    const put = await call(h, 'PUT', `/v1/offers/${data.offerId}/publication`, await h.staff(), {
      level: 'Anonymous',
    });
    const { publicId } = (await put.json()) as { publicId: string };
    const r = await call(
      h,
      'PUT',
      '/v1/publication-settings',
      { ...(await h.staff()), 'if-match': '"1"' },
      {
        mahareraAgentNumber: 'A51900054321',
        subjectToConfirmationNote: 'Subject to confirmation by 11 Estates',
      },
    );
    expect(r.status).toBe(200);
    await refreshProjectionBatch(h.deps.services, h.tenant, null);
    const item = await h.deps.db
      .selectFrom('public_item')
      .select('payload')
      .where('tenant_id', '=', h.tenant)
      .where('public_id', '=', publicId)
      .executeTakeFirstOrThrow();
    expect(item.payload).toMatchObject({
      agentReraNumber: 'A51900054321',
      note: 'Subject to confirmation by 11 Estates',
    });
    const feed = await h.deps.db
      .selectFrom('change_feed')
      .select('change_type')
      .where('tenant_id', '=', h.tenant)
      .where('public_id', '=', publicId)
      .orderBy('seq')
      .execute();
    expect(feed.map((f) => f.change_type)).toEqual(['published', 'updated']);
  });
});

describe('API keys', () => {
  const audits = (action: string) => auditsOf(h, action);
  it('create returns the secret once; list and replays never do; only a hash is stored', async () => {
    const key = randomUUID();
    const headers = { ...(await h.staff('Admin')), 'idempotency-key': key };
    const r = await call(h, 'POST', '/v1/api-keys', headers, {
      name: '11estates.in',
      allowedOrigins: ['https://www.11estates.in'],
    });
    expect(r.status).toBe(201);
    const created = (await r.json()) as {
      keyId: string;
      secret: string;
      prefix: string;
      status: string;
      rateLimitRps: number;
      burst: number;
    };
    expect(created.secret).toMatch(/^lk_live_[0-9A-Za-z]{40}$/);
    expect(created).toMatchObject({
      prefix: created.secret.slice(0, 10),
      status: 'active',
      rateLimitRps: 50,
      burst: 100,
    });
    const replay = await call(h, 'POST', '/v1/api-keys', headers, {
      name: '11estates.in',
      allowedOrigins: ['https://www.11estates.in'],
    });
    expect(replay.status).toBe(201);
    const again = (await replay.json()) as Record<string, unknown>;
    expect(again['keyId']).toBe(created.keyId);
    expect(again).not.toHaveProperty('secret');
    const stored = JSON.stringify(
      await h.deps.db.selectFrom('idempotency_keys').selectAll().where('tenant_id', '=', h.tenant).execute(),
    );
    expect(stored).not.toContain(created.secret);
    const row = await h.deps.db
      .selectFrom('api_key')
      .selectAll()
      .where('id', '=', created.keyId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(created.secret);
    const list = (await (await call(h, 'GET', '/v1/api-keys?status=active', await h.staff())).json()) as {
      items: Record<string, unknown>[];
    };
    expect(list.items.map((k) => k['keyId'])).toContain(created.keyId);
    expect(JSON.stringify(list)).not.toContain('secret');
    expect((await audits('api_key.created')).length).toBe(1);
  });

  it('rotate keeps the old key valid for the grace period; revoke is immediate and idempotent', async () => {
    const created = (await (
      await call(h, 'POST', '/v1/api-keys', await h.staff(), {
        name: 'PRJ-0031 microsite',
        rateLimitRps: 10,
        burst: 20,
      })
    ).json()) as { keyId: string; secret: string };
    const probe = (secret: string) => call(h, 'GET', '/v1/listings', { 'x-api-key': secret });
    expect((await probe(created.secret)).status).toBe(200);

    const rot = await call(h, 'POST', `/v1/api-keys/${created.keyId}/rotate`, await h.staff(), {
      graceHours: 1,
    });
    expect(rot.status).toBe(201);
    const next = (await rot.json()) as { keyId: string; secret: string; rateLimitRps: number };
    expect(next.rateLimitRps).toBe(10);
    expect((await probe(created.secret)).status).toBe(200); // grace
    expect((await probe(next.secret)).status).toBe(200);
    const again = await call(h, 'POST', `/v1/api-keys/${created.keyId}/rotate`, await h.staff(), {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('key-already-rotating');

    // Grace over → the api-key-expire job revokes it.
    await h.deps.db
      .updateTable('api_key')
      .set({ grace_ends_at: new Date(Date.now() - 1000) })
      .where('id', '=', created.keyId)
      .execute();
    expect((await probe(created.secret)).status).toBe(401);
    await h.app.request('/internal/v1/jobs/api-key-expire', { method: 'POST', headers: h.cron });
    const old = (await (await call(h, 'GET', '/v1/api-keys?status=revoked', await h.staff())).json()) as {
      items: { keyId: string; replacedByKeyId: string }[];
    };
    expect(old.items.find((k) => k.keyId === created.keyId)?.replacedByKeyId).toBe(next.keyId);

    const rev = await call(h, 'POST', `/v1/api-keys/${next.keyId}/revoke`, await h.staff());
    expect(rev.status).toBe(200);
    expect(((await rev.json()) as { status: string }).status).toBe('revoked');
    expect((await probe(next.secret)).status).toBe(401);
    const rev2 = await call(h, 'POST', `/v1/api-keys/${next.keyId}/revoke`, await h.staff());
    expect(rev2.status).toBe(200);
    expect((await call(h, 'POST', `/v1/api-keys/${randomUUID()}/revoke`, await h.staff())).status).toBe(404);
  });

  it('only Admin manages keys, and keys are tenant-bound', async () => {
    expect((await call(h, 'GET', '/v1/api-keys', await h.staff('Manager'))).status).toBe(403);
    expect(
      (await call(h, 'POST', '/v1/api-keys', await h.staff('Supply agent'), { name: 'x-site' })).status,
    ).toBe(403);
    const created = (await (
      await call(h, 'POST', '/v1/api-keys', await h.staff(), { name: 'tenant-a-site' })
    ).json()) as { keyId: string };
    const other = await h.staff('Admin', { tenant: randomUUID() });
    expect((await call(h, 'POST', `/v1/api-keys/${created.keyId}/revoke`, other)).status).toBe(404);
    const list = (await (await call(h, 'GET', '/v1/api-keys', other)).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });
});
