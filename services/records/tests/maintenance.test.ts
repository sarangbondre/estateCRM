// REC-12 jobs: retention purge (NFR-18: personal data erased 24 months after the last activity) and counter
// reconciliation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemActor } from '../src/application/context.js';
import { reconcileCountersStep, retentionCutoff, retentionPurgeStep } from '../src/application/maintenance.js';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('retention purge', () => {
  it('erases contacts, unit details and texts of long-inactive people and records; keeps the business records', async () => {
    const t = await readyTenant(h);
    const A = await h.staff(t, 'Admin');
    const created = await h.call('POST', '/v1/properties', A, {
      property: { segment: 'Residential', propertyTypes: ['Apartment'], locality: 'Sion', city: 'Mumbai', unitNo: '5', wing: 'A' },
      offers: [{ dealType: 'Lease', rentMonthlyInrMin: 40_000 }],
      parties: [{ role: 'Landlord', newPerson: { name: 'Old Owner', phones: ['9000900001'] } }],
    });
    const property = created.body['property'] as { id: string; parties: { personId: string }[] };
    const personId = property.parties[0]?.personId as string;
    const fresh = await h.call('POST', '/v1/people', A, { person: { name: 'Fresh Person', phones: ['9000900002'] } });
    const old = new Date(retentionCutoff(new Date()).getTime() - 86_400_000);
    await h.db.updateTable('persons').set({ last_activity_at: old }).where('tenant_id', '=', t).where('id', '=', personId).execute();
    await h.db.updateTable('offers').set({ updated_at: old }).where('tenant_id', '=', t).where('property_id', '=', property.id).execute();
    await h.db.updateTable('properties').set({ updated_at: old }).where('tenant_id', '=', t).where('id', '=', property.id).execute();

    const r = await retentionPurgeStep(h.appCtx, systemActor(t, 'test'));
    expect(r.processed).toBeGreaterThanOrEqual(2);
    const reveal = await h.call('POST', '/v1/reveals', A, { subjectType: 'person', subjectId: personId, purpose: 'review' });
    expect(reveal.body['fields']).toEqual({ name: null, phones: [], whatsappPhone: null, emails: [], otherContact: null });
    expect((await h.call('POST', '/v1/reveals', A, { subjectType: 'property', subjectId: property.id, purpose: 'review' })).body['code']).toBe('reveal-not-applicable');
    const batch = await h.call('POST', '/internal/v1/contacts:batch', await h.service(t, 'insight'), {
      personIds: [personId, String(fresh.body['id'])],
      purpose: 'export',
      exportId: crypto.randomUUID(),
      requestedBy: crypto.randomUUID(),
    });
    const items = batch.body['items'] as { personId: string; purged: boolean }[];
    expect(items.find((i) => i.personId === personId)).toEqual({ personId, purged: true });
    expect(items.find((i) => i.personId === fresh.body['id'])?.purged).toBe(false);
    expect((await h.call('GET', `/v1/offers?propertyId=${property.id}`, A)).body.items).toHaveLength(1);
  });
});

describe('reconcile counters', () => {
  it('fixes drifted signal counters', async () => {
    const t = await readyTenant(h);
    const A = await h.staff(t, 'Admin');
    const created = await h.call('POST', '/v1/properties', A, {
      property: { segment: 'Commercial', propertyTypes: ['Shop'], locality: 'Dadar', city: 'Mumbai' },
      offers: [{ dealType: 'Lease' }],
    });
    const offer = (created.body['offers'] as { id: string }[])[0] as { id: string };
    await h.db.updateTable('offers').set({ enquiry_count: 7, has_price_gap: true }).where('tenant_id', '=', t).where('id', '=', offer.id).execute();
    let more = true;
    while (more) more = (await reconcileCountersStep(h.appCtx, systemActor(t, 'test'))).more;
    const o = await h.call('GET', `/v1/offers/${offer.id}`, A);
    expect(o.body['signals']).toMatchObject({ enquiryCount: 0, hasPriceGap: false });
  });
});
