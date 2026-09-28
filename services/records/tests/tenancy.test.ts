// NFR-15 tenant isolation: a caller of tenant B can never read or write tenant A's records — by id, by code, in
// lists, through merges, reveals or the internal endpoints (another tenant's resource is reported as not found).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('tenant isolation (NFR-15)', () => {
  it('tenant B sees and changes nothing of tenant A', async () => {
    const a = await readyTenant(h);
    const b = await readyTenant(h);
    const A = await h.staff(a, 'Admin');
    const B = await h.staff(b, 'Admin');
    const created = await h.call('POST', '/v1/properties', A, {
      property: { segment: 'Residential', propertyTypes: ['Apartment'], locality: 'Powai', city: 'Mumbai', buildingName: 'Tenant Tower', unitNo: '101' },
      offers: [{ dealType: 'Sale', salePriceInrMin: 10_000_000 }],
      parties: [{ role: 'Seller', newPerson: { name: 'Tenant Owner', phones: ['9000800001'] } }],
    });
    const property = created.body['property'] as { id: string; code: string; parties: { personId: string; personCode: string }[] };
    const offer = (created.body['offers'] as { id: string; code: string }[])[0] as { id: string; code: string };
    const person = property.parties[0] as { personId: string; personCode: string };
    const demand = (await h.call('POST', '/v1/demands', A, { dealTypes: ['Sale'], segment: 'Residential' })).body as { id: string; code: string };
    const project = (await h.call('POST', '/v1/projects', A, { name: 'Tenant Park', locality: 'Powai' })).body as { id: string; code: string };

    for (const path of [
      `/v1/offers/${offer.id}`,
      `/v1/offers/${offer.code}`,
      `/v1/properties/${property.id}`,
      `/v1/properties/${property.code}`,
      `/v1/properties/${property.id}/sightings`,
      `/v1/properties/${property.id}/photos`,
      `/v1/people/${person.personId}`,
      `/v1/people/${person.personCode}`,
      `/v1/demands/${demand.id}`,
      `/v1/demands/${demand.code}/touches`,
      `/v1/projects/${project.code}`,
      `/v1/projects/${project.id}/price-sheets`,
    ]) {
      expect([path, (await h.call('GET', path, B)).status]).toEqual([path, 404]);
    }
    for (const path of ['/v1/offers', '/v1/properties', '/v1/people', '/v1/demands', '/v1/projects', '/v1/source-ads', '/v1/merge-candidates']) {
      expect([path, (await h.call('GET', path, B)).body.items]).toEqual([path, []]);
    }
    expect((await h.call('PATCH', `/v1/offers/${offer.id}`, B, { salePriceInrMin: 1 })).status).toBe(404);
    expect((await h.call('PATCH', `/v1/people/${person.personId}`, B, { name: 'x' })).status).toBe(404);
    expect((await h.call('POST', `/v1/offers/${offer.id}/record-stage`, B, { to: 'Contacted' })).status).toBe(404);
    expect((await h.call('POST', `/v1/demands/${demand.id}/touches`, B, { sourceType: 'Direct' })).status).toBe(404);
    expect((await h.call('POST', '/v1/reveals', B, { subjectType: 'person', subjectId: person.personId, purpose: 'call' })).status).toBe(404);
    expect((await h.call('POST', '/v1/merges', B, { aggregateType: 'demand', survivorId: demand.id, mergedIds: [demand.id] })).status).toBe(404);
    expect((await h.call('POST', '/v1/offers', B, { propertyId: property.id, offer: { dealType: 'Lease' } })).status).toBe(404);
    expect((await h.call('GET', `/internal/v1/properties/${property.id}/scan-terms`, await h.service(b, 'listings'))).status).toBe(404);
    const batch = await h.call('POST', '/internal/v1/contacts:batch', await h.service(b, 'insight'), {
      personIds: [person.personId],
      purpose: 'export',
      exportId: crypto.randomUUID(),
      requestedBy: crypto.randomUUID(),
    });
    expect(batch.body['items']).toEqual([]);
    // A header/claim mismatch (tenant A token presented as tenant B) is refused outright.
    expect((await h.call('GET', '/v1/offers', { ...A, 'x-tenant-id': b })).status).toBe(401);
    // Tenant A still sees its data unchanged.
    expect((await h.call('GET', `/v1/offers/${offer.id}`, A)).body['salePriceInrMin']).toBe(10_000_000);
  });
});
