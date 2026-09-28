// REC-03 supply records API (contract-validated responses): properties + offers with dedup, offers, record axis,
// photo selection, projects, second sources, lists with stored-field filters and cursors; offer.* / project.* events.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const flat = (over: Record<string, unknown> = {}) => ({
  property: {
    segment: 'Residential',
    propertyTypes: ['apartment'],
    locality: 'Bandra West',
    city: 'Mumbai',
    buildingName: 'Sea Breeze CHS',
    floorNo: 7,
    totalFloors: 12,
    wing: 'B',
    unitNo: '703',
    areaSqftMin: 1000,
    areaBasis: 'Carpet',
    bhkMin: 2,
    bhkMax: 2,
    amenities: ['Gym'],
    ...over,
  },
  offers: [
    { dealType: 'Sale', market: 'Secondary', salePriceInrMin: 30_000_000 },
    { dealType: 'lease', rentMonthlyInrMin: 90_000, depositInr: 500_000, furnishing: 'semi furnished' },
  ],
  parties: [{ role: 'Seller', newPerson: { name: 'Test Owner', phones: ['+91 90000 00001'] } }],
});

describe('properties and offers', () => {
  it('creates a property with one offer per deal type, masked parties and offer.created.v1 events', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const r = await h.call('POST', '/v1/properties', sup, flat());
    expect(r.status).toBe(201);
    const property = r.body['property'] as Record<string, unknown>;
    const offers = r.body['offers'] as Record<string, unknown>[];
    expect(property['code']).toMatch(/^PRP-\d{5}$/);
    expect(property['hasUnitDetails']).toBe(true);
    expect(property['floorBand']).toBe('Mid');
    expect(property).not.toHaveProperty('unitNo');
    expect((property['micromarket'] as { name: string }).name).toBe('Bandra West');
    expect((property['parties'] as { displayName: string }[])[0]?.displayName).toBe('T. O.');
    expect(offers.map((o) => o['dealType'])).toEqual(['Sale', 'Lease']);
    expect(offers[1]?.['furnishing']).toBe('Semi Furnished');
    expect(offers[1]?.['label']).toBe('For Rent');
    expect(offers[0]?.['recordStage']).toBe('Captured');
    const events = await h.events(t, 'offer.created.v1');
    expect(events).toHaveLength(2);
    const facts = events[0]?.data ?? {};
    expect(facts['buildingKey']).toMatch(/^[0-9a-f]{32}$/);
    expect(facts['contactPersonIds']).toHaveLength(1);
    expect(JSON.stringify(facts)).not.toContain('Sea Breeze');
    // Word boundaries: random UUIDs/hashes in the payload may contain the digits 703 by chance.
    expect(JSON.stringify(facts)).not.toMatch(/\b703\b/);
  });

  it('suspects a duplicate (409 with candidates) unless confirmed; dedup-check reports it', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    expect((await h.call('POST', '/v1/properties', sup, flat())).status).toBe(201);
    const again = await h.call('POST', '/v1/properties', sup, flat({ areaSqftMin: 1020 }));
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('duplicate-property-suspected');
    const cands = again.body['candidates'] as { score: number; reasons: string[] }[];
    expect(cands[0]?.score).toBeGreaterThanOrEqual(0.85);
    expect(cands[0]?.reasons).toContain('building');
    const check = await h.call('POST', '/v1/properties/dedup-check', sup, { property: flat().property });
    expect(check.status).toBe(200);
    expect(check.body['decision']).toBe('same_property');
    const confirmed = await h.call('POST', '/v1/properties', sup, { ...flat(), confirmNewDespiteCandidates: true });
    expect(confirmed.status).toBe(201);
  });

  it('validates vocabulary values and ranges', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const bad = await h.call('POST', '/v1/properties', sup, { ...flat(), offers: [{ dealType: 'Rent' }] });
    expect(bad.status).toBe(400);
    expect(bad.body['code']).toBe('vocabulary-value-invalid');
    const inverted = await h.call('POST', '/v1/properties', sup, flat({ areaSqftMin: 2000, areaSqftMax: 1000 }));
    expect(inverted.status).toBe(400);
    expect(inverted.body['code']).toBe('range-inverted');
    const marketOnLease = await h.call('POST', '/v1/properties', sup, { ...flat(), offers: [{ dealType: 'Lease', market: 'Primary' }] });
    expect(marketOnLease.status).toBe(400);
  });

  it('offers: one per deal type, patch with If-Match, price_changed then updated, staff edits remembered', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const created = await h.call('POST', '/v1/properties', sup, { ...flat(), offers: [{ dealType: 'Sale', salePriceInrMin: 10_000_000 }] });
    const property = created.body['property'] as { id: string };
    const offer = (created.body['offers'] as { id: string; code: string; version: number }[])[0] as { id: string; code: string; version: number };
    expect((await h.call('POST', '/v1/offers', sup, { propertyId: property.id, offer: { dealType: 'Sale' } })).status).toBe(409);
    const lease = await h.call('POST', '/v1/offers', sup, { propertyId: property.id, offer: { dealType: 'Lease', rentMonthlyInrMin: 50_000 } });
    expect(lease.status).toBe(201);

    expect((await h.call('PATCH', `/v1/offers/${offer.code}`, { ...sup, 'if-match': '99' }, { salePriceInrMin: 1 })).status).toBe(412);
    const patched = await h.call('PATCH', `/v1/offers/${offer.code}`, { ...sup, 'if-match': String(offer.version) }, { salePriceInrMin: 9_500_000 });
    expect(patched.status).toBe(200);
    expect(patched.body['salePriceInrMin']).toBe(9_500_000);
    const evs = (await h.events(t)).filter((e) => e.aggregateId === offer.id);
    expect(evs.map((e) => e.eventType)).toEqual(['offer.created.v1', 'offer.price_changed.v1', 'offer.updated.v1']);
    expect(evs.map((e) => e.aggregateVersion)).toEqual([1, 2, 3]);
    expect(evs[1]?.data).toMatchObject({ previous: { salePriceInrMin: 10_000_000 }, current: { salePriceInrMin: 9_500_000 }, cause: 'edit' });
    const owner = await h.call('PATCH', `/v1/offers/${offer.id}`, sup, { ownerUserId: '0192c0de-0000-7000-8000-000000000009' });
    expect(owner.status).toBe(403);
  });

  it('record axis: forward by agents, backward needs a manager, Verified needs a real photo', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const created = await h.call('POST', '/v1/properties', sup, { ...flat(), offers: [{ dealType: 'Sale' }] });
    const offer = (created.body['offers'] as { id: string }[])[0] as { id: string };
    const fwd = await h.call('POST', `/v1/offers/${offer.id}/record-stage`, sup, { to: 'Contacted' });
    expect(fwd.status).toBe(200);
    expect(fwd.body['recordStage']).toBe('Contacted');
    const back = await h.call('POST', `/v1/offers/${offer.id}/record-stage`, sup, { to: 'Captured' });
    expect(back.body['code']).toBe('invalid-stage-transition');
    const verify = await h.call('POST', `/v1/offers/${offer.id}/record-stage`, sup, { to: 'Verified' });
    expect(verify.body['code']).toBe('verification-needs-real-photos');
    const mgrBack = await h.call('POST', `/v1/offers/${offer.id}/record-stage`, await h.staff(t, 'Manager'), { to: 'Enriched' });
    expect(mgrBack.status).toBe(200);
    const stages = await h.events(t, 'offer.record_stage_changed.v1');
    expect(stages.map((e) => `${String(e.data['from'])}>${String(e.data['to'])}`)).toEqual(['Captured>Contacted', 'Contacted>Enriched']);
    const photos = await h.call('PUT', `/v1/offers/${offer.id}/photos`, sup, { photoIds: ['0192c0de-0000-7000-8000-00000000abcd'] });
    expect(photos.body['code']).toBe('photo-not-on-property');
  });

  it('lists with stored-field filters, cursors and codes; tenant isolation', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    await h.call('POST', '/v1/properties', sup, { ...flat({ buildingName: 'Alpha' }), offers: [{ dealType: 'Sale', salePriceInrMin: 20_000_000 }] });
    await h.call('POST', '/v1/properties', sup, { ...flat({ buildingName: 'Beta', locality: 'Chakala', floorNo: 2 }), offers: [{ dealType: 'Lease', rentMonthlyInrMin: 80_000 }] });
    const all = await h.call('GET', '/v1/offers?limit=1', sup);
    expect(all.body.items).toHaveLength(1);
    expect(all.body['nextCursor']).toBeTruthy();
    const next = await h.call('GET', `/v1/offers?limit=1&cursor=${String(all.body['nextCursor'])}`, sup);
    expect(next.body.items?.[0]?.['id']).not.toBe(all.body.items?.[0]?.['id']);
    expect((await h.call('GET', '/v1/offers?dealType=Lease', sup)).body.items).toHaveLength(1);
    expect((await h.call('GET', '/v1/offers?priceInrMin=15000000&dealType=Sale', sup)).body.items).toHaveLength(1);
    expect((await h.call('GET', '/v1/offers?recordStage=Verified', sup)).body.items).toHaveLength(0);
    // Andheri East covers Chakala (descendants).
    const andheri = (await h.call('GET', '/v1/micromarkets?q=andheri%20east', sup)).body.items?.[0];
    expect((await h.call('GET', `/v1/offers?micromarketId=${String(andheri?.['id'])}`, sup)).body.items).toHaveLength(1);
    expect((await h.call('GET', '/v1/properties?buildingName=alp', sup)).body.items).toHaveLength(1);
    const code = String(all.body.items?.[0]?.['code']);
    expect((await h.call('GET', `/v1/offers/${code}`, sup)).status).toBe(200);
    expect((await h.call('GET', '/v1/offers/INV-99999', sup)).status).toBe(404);
    // NFR-15: another tenant sees nothing.
    const other = await h.staff(await readyTenant(h), 'Admin');
    expect((await h.call('GET', `/v1/offers/${code}`, other)).status).toBe(404);
    expect((await h.call('GET', '/v1/offers', other)).body.items).toHaveLength(0);
  });

  it('patching the property re-derives facts (outside launch area) and updates every offer', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const created = await h.call('POST', '/v1/properties', sup, flat());
    const property = created.body['property'] as { id: string; version: number };
    const r = await h.call('PATCH', `/v1/properties/${property.id}`, { ...sup, 'if-match': String(property.version) }, { city: 'Pune', locality: 'Baner' });
    expect(r.status).toBe(200);
    expect(r.body['outsideLaunchArea']).toBe(true);
    expect(r.body['micromarket']).toBeNull();
    const updated = await h.events(t, 'offer.updated.v1');
    expect(updated).toHaveLength(2);
    expect(updated.every((e) => e.data['outsideLaunchArea'] === true)).toBe(true);
  });

  it('second sources: price-gap queue, accept price, already resolved', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const created = await h.call('POST', '/v1/properties', sup, { ...flat(), offers: [{ dealType: 'Sale', salePriceInrMin: 10_000_000 }] });
    const property = created.body['property'] as { id: string };
    const offer = (created.body['offers'] as { id: string }[])[0] as { id: string };
    const srcId = h.appCtx.ids.next();
    await h.appCtx.uow.run({ tenantId: t, correlationId: 't' }, async (tx) => {
      await tx.store.insert('second_sources', {
        id: srcId,
        property_id: property.id,
        offer_id: offer.id,
        source_ad_id: null,
        person_id: null,
        source_type: 'Channel',
        source_name: 'Times of India',
        sale_price_inr_min: 11_000_000,
        sale_price_inr_max: null,
        rent_monthly_inr_min: null,
        rent_monthly_inr_max: null,
        price_gap_pct: 10,
        price_gap: true,
        status: 'open',
        seen_on: '2026-09-01',
        resolved_by: null,
        resolved_at: null,
      });
      await tx.store.update('offers', offer.id, { has_price_gap: true });
    });
    const queue = await h.call('GET', '/v1/second-sources', sup);
    expect(queue.body.items?.map((i) => i['id'])).toEqual([srcId]);
    expect((await h.call('GET', `/v1/properties/${property.id}/second-sources`, sup)).body.items).toHaveLength(1);
    const accepted = await h.call('POST', `/v1/second-sources/${srcId}/resolve`, sup, { action: 'accept_price' });
    expect(accepted.status).toBe(200);
    expect(accepted.body['status']).toBe('accepted');
    const o = await h.call('GET', `/v1/offers/${offer.id}`, sup);
    expect(o.body['salePriceInrMin']).toBe(11_000_000);
    expect((o.body['signals'] as { hasPriceGap: boolean }).hasPriceGap).toBe(false);
    expect((await h.call('POST', `/v1/second-sources/${srcId}/resolve`, sup, { action: 'dismiss' })).body['code']).toBe('already-resolved');
    expect((await h.call('GET', `/v1/properties/${property.id}/sightings`, sup)).status).toBe(200);
    expect((await h.call('GET', `/v1/properties/${property.id}/photos`, sup)).body.items).toEqual([]);
  });
});

describe('projects', () => {
  it('create (409 on the same developer/name/micromarket), get, patch, list', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const body = { name: 'Skyline Heights', developerName: 'Acme Developers', locality: 'Powai', city: 'Mumbai', reraNumber: 'P99900000001' };
    const r = await h.call('POST', '/v1/projects', sup, body);
    expect(r.status).toBe(201);
    expect(r.body['code']).toMatch(/^PRJ-\d{4}$/);
    expect((r.body['micromarket'] as { name: string }).name).toBe('Powai');
    expect((await h.call('POST', '/v1/projects', sup, { ...body, name: 'skyline  heights' })).body['code']).toBe('project-exists');
    const p = await h.call('PATCH', `/v1/projects/${String(r.body['code'])}`, { ...sup, 'if-match': '1' }, { possessionDate: '2028-06' });
    expect(p.status).toBe(200);
    expect(p.body['version']).toBe(2);
    expect((await h.call('GET', '/v1/projects?hasRera=true', sup)).body.items).toHaveLength(1);
    expect((await h.call('GET', '/v1/projects?hasRera=false', sup)).body.items).toHaveLength(0);
    const evs = await h.events(t);
    expect(evs.map((e) => e.eventType)).toEqual(expect.arrayContaining(['project.created.v1', 'project.updated.v1']));
  });
});
