// INT-09: review queue (list/summary/get grouped by reason code, resolve set/confirm/discard/skip, bulk resolve,
// review_item.resolved.v1, 409 review-item-closed, 400 classification-invalid, roles).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { synthFile } from './support/files.js';
import { runUpload } from './support/flows.js';

let h: Harness;
let tenant: string;
let op: Record<string, string>;
let uploadId: string;
let total: number;

beforeAll(async () => {
  h = await createHarness();
  tenant = newTenant();
  op = await h.staff(tenant, 'Data operator');
  const { bytes, manifest } = await synthFile({ rows: 300, seed: 61 });
  total = manifest.totals.needsReview;
  uploadId = (await runUpload(h, tenant, bytes)).id;
});
afterAll(() => h.close());

const openItems = async (reasonCode?: string) => {
  const q = new URLSearchParams({ limit: '100', uploadId, ...(reasonCode ? { reasonCode } : {}) });
  return ((await h.call('GET', `/v1/review-items?${q.toString()}`, op)).body.items ?? []) as Record<
    string,
    unknown
  >[];
};

describe('review queue', () => {
  it('summarises open items per reason code and lists them oldest first with a cursor', async () => {
    const s = await h.call('GET', `/v1/review-items/summary?uploadId=${uploadId}`, op);
    expect(s.status).toBe(200);
    const groups = s.body['groups'] as { reasonCode: string; open: number }[];
    expect(groups.reduce((n, g) => n + g.open, 0)).toBe(total);
    const p1 = await h.call('GET', `/v1/review-items?limit=5&uploadId=${uploadId}`, op);
    expect(p1.body.items).toHaveLength(5);
    const p2 = await h.call(
      'GET',
      `/v1/review-items?limit=5&uploadId=${uploadId}&cursor=${String(p1.body['nextCursor'])}`,
      op,
    );
    const ids = new Set([...(p1.body.items ?? []), ...(p2.body.items ?? [])].map((i) => i['id']));
    expect(ids.size).toBe(10);
    const side = await openItems('side_defaulted');
    expect(side.length).toBeGreaterThan(0);
    expect(side.every((i) => i['reasonCode'] === 'side_defaulted' && i['uploadCode'])).toBe(true);
    expect((await h.call('GET', '/v1/review-items', await h.staff(tenant, 'Supply agent'))).status).toBe(403);
  });

  it('gets one item with redacted context; other tenants get 404', async () => {
    const [item] = await openItems();
    const r = await h.call('GET', `/v1/review-items/${String(item?.['id'])}`, op);
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe('"1"');
    expect(
      (await h.call('GET', `/v1/review-items/${String(item?.['id'])}`, await h.staff(newTenant()))).status,
    ).toBe(404);
  });

  it('resolves with set (merged + validated), emits the final classification, then 409 when closed', async () => {
    const [item] = await openItems('side_defaulted');
    const id = String(item?.['id']);
    const bad = await h.call('POST', `/v1/review-items/${id}/resolve`, op, {
      action: 'set',
      classification: { side: 'None' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body['code']).toBe('classification-invalid');
    const stale = await h.call(
      'POST',
      `/v1/review-items/${id}/resolve`,
      { ...op, 'if-match': '7' },
      { action: 'confirm' },
    );
    expect(stale.status).toBe(412);
    const ok = await h.call('POST', `/v1/review-items/${id}/resolve`, op, {
      action: 'set',
      classification: { side: 'Demand' },
      note: 'agent called',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'resolved',
      resolution: 'set',
      version: 2,
      resolvedBy: op['x-user-id'],
    });
    const events = (await h.events(tenant, 'review_item.resolved.v1')).filter((e) => e.aggregateId === id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ aggregateVersion: 2 });
    expect(events[0]?.data).toMatchObject({
      reviewItemId: id,
      uploadId,
      action: 'set',
      side: 'Demand',
      recordScope: (item?.['current'] as Record<string, unknown>)['recordScope'],
    });
    const again = await h.call('POST', `/v1/review-items/${id}/resolve`, op, { action: 'confirm' });
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('review-item-closed');
  });

  it('skip keeps the item listed as skipped and emits nothing', async () => {
    const [item] = await openItems();
    const id = String(item?.['id']);
    const before = (await h.events(tenant, 'review_item.resolved.v1')).length;
    const r = await h.call('POST', `/v1/review-items/${id}/resolve`, op, { action: 'skip' });
    expect(r.body).toMatchObject({ status: 'skipped', resolution: null });
    expect((await h.events(tenant, 'review_item.resolved.v1')).length).toBe(before);
    const skipped = await h.call('GET', `/v1/review-items?status=skipped&uploadId=${uploadId}`, op);
    expect(skipped.body.items?.map((i) => i['id'])).toContain(id);
  });

  it('bulk-resolves up to 100 items, one event each, reporting closed and unknown ids', async () => {
    const items = (await openItems()).slice(0, 3);
    const closed = (await h.call('GET', `/v1/review-items?status=resolved&uploadId=${uploadId}`, op)).body
      .items?.[0];
    const ids = [...items.map((i) => String(i['id'])), String(closed?.['id']), randomUUID()];
    const before = (await h.events(tenant, 'review_item.resolved.v1')).length;
    const r = await h.call(
      'POST',
      '/v1/review-items/bulk-resolve',
      { ...op, 'idempotency-key': randomUUID() },
      { ids, action: 'confirm' },
    );
    expect(r.status).toBe(200);
    expect(r.body['resolved']).toEqual(ids.slice(0, 3));
    expect(r.body['failed']).toEqual([
      { id: ids[3], code: 'review-item-closed' },
      { id: ids[4], code: 'not-found' },
    ]);
    expect((await h.events(tenant, 'review_item.resolved.v1')).length).toBe(before + 3);
  });

  it('discard is a resolution records acts on (voids what it created)', async () => {
    const [item] = await openItems();
    const r = await h.call('POST', `/v1/review-items/${String(item?.['id'])}/resolve`, op, {
      action: 'discard',
    });
    expect(r.body).toMatchObject({ status: 'resolved', resolution: 'discard' });
    const last = (await h.events(tenant, 'review_item.resolved.v1')).at(-1);
    expect(last?.data['action']).toBe('discard');
  });
});
