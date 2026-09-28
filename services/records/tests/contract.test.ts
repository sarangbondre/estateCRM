// REC-12 contract coverage: every operation of records.yaml is implemented, refuses callers without credentials with
// an RFC 7807 problem, and the remaining reads (enquiries, source ad) and every scheduled job answer in the contract
// shape (responses are validated against the contract in tests).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { FakeIntake, supplyRow, toIntakeRow } from './support/intake.js';

const intake = new FakeIntake();
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ intake });
});
afterAll(() => h.close());

const sample: Record<string, string> = {
  idOrCode: 'INV-00001',
  id: '0192c0de-0000-7000-8000-000000000001',
  desk: 'business',
  queue: 'q_records',
  name: 'reconcile-counters',
};

describe('records contract', () => {
  it('implements all 69 operations', () => {
    expect(h.svc.contract.operations.size).toBe(69);
    expect(h.svc.unimplemented()).toEqual([]);
  });

  it('every secured operation answers 401 problem+json without credentials', async () => {
    const ops = [...h.svc.contract.operations.values()].filter((o) => o.security.length > 0);
    expect(ops.length).toBe(67);
    for (const op of ops) {
      const path = op.path.replace(/\{(\w+)\}/g, (_, k: string) => sample[k] ?? 'x');
      const res = await h.app.request(path, {
        method: op.method,
        headers: { 'content-type': 'application/json' },
        ...(['POST', 'PUT', 'PATCH'].includes(op.method) ? { body: '{}' } : {}),
      });
      expect([op.operationId, res.status]).toEqual([op.operationId, 401]);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const body = (await res.json()) as { code: string; correlationId: string; type: string };
      expect(body).toMatchObject({ code: 'unauthenticated', type: 'https://errors.11estates.in/unauthenticated' });
      expect(body.correlationId).toBeTruthy();
    }
  });

  it('staff roles outside x-roles get 403 (e.g. Supply agent on micromarket admin, Demand agent on merges)', async () => {
    const t = await readyTenant(h);
    expect((await h.call('PUT', '/v1/launch-area', await h.staff(t, 'Manager'), { cities: [] })).status).toBe(403);
    expect((await h.call('POST', '/v1/merges', await h.staff(t, 'Demand agent'), { aggregateType: 'person', survivorId: sample['id'], mergedIds: [randomUUID()] })).status).toBe(403);
    expect((await h.call('POST', '/v1/offers', await h.staff(t, 'Data operator'), { propertyId: sample['id'], offer: { dealType: 'Sale' } })).status).toBe(403);
  });

  it('enquiries and source ads from a Digi upload row', async () => {
    const t = await readyTenant(h);
    const uploadId = randomUUID();
    const row = toIntakeRow(supplyRow({ record_id: 'e1', side: 'Demand', deal_type: 'Lease', sale_price_inr_min: null, rent_monthly_inr_min: 90_000, phones: '+919000700001' }));
    row.sourceType = 'Digi';
    row.campaignRef = 'CAMP-7';
    row.enquiryMessage = 'Please call after 6';
    intake.add(uploadId, 1, [row]);
    await h.deliver({ eventType: 'rows.classified.v1', tenantId: t, data: { uploadId, batchNo: 1, rows: [] } });
    const staff = await h.staff(t, 'Demand agent');
    const list = await h.call('GET', '/v1/enquiries?campaignRef=CAMP-7', staff);
    expect(list.status).toBe(200);
    const enq = list.body.items?.[0];
    expect(enq).toMatchObject({ campaignRef: 'CAMP-7', hasMessage: true });
    expect(enq).not.toHaveProperty('message');
    expect((await h.call('GET', `/v1/enquiries/${String(enq?.['code'])}`, staff)).body['id']).toBe(enq?.['id']);
    expect((await h.call('GET', '/v1/enquiries/ENQ-999999', staff)).status).toBe(404);
    expect((await h.events(t, 'enquiry.received.v1'))[0]?.data).toMatchObject({ campaignRef: 'CAMP-7' });
    const ad = (await h.call('GET', '/v1/source-ads?externalRef=e1', staff)).body.items?.[0];
    const got = await h.call('GET', `/v1/source-ads/${String(ad?.['code'])}`, staff);
    expect(got.body).toMatchObject({ externalRef: 'e1', hasRawText: true, children: [expect.objectContaining({ subjectType: 'demand' })] });
    const revealed = await h.call('POST', '/v1/reveals', staff, { subjectType: 'enquiry', subjectId: String(enq?.['id']), purpose: 'call' });
    expect(revealed.body['fields']).toEqual({ message: 'Please call after 6' });
  });

  it('every scheduled job of the contract enum runs (single-flight lease, contract response)', async () => {
    const t = await readyTenant(h);
    const h2 = await createHarness({ tenantIds: [t], knownTenants: async () => [] });
    try {
      for (const job of ['activate-vocabulary', 'recompute-launch-area', 'resolve-pending-repeats', 'retention-purge', 'expire-idempotency-keys', 'reconcile-counters']) {
        const r = await h2.call('POST', `/internal/v1/jobs/${job}`, h2.cron);
        expect([job, r.status]).toEqual([job, 200]);
        expect(typeof r.body['processed']).toBe('number');
      }
      expect((await h2.call('POST', '/internal/v1/drain/q_records_photo_fetch', h2.cron)).status).toBe(200);
    } finally {
      await h2.close();
    }
  });
});
