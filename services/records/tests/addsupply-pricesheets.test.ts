// REC-07: add supply for a demand (dedup first, Contacted, Sourced for DEM-…, owner check) and project price sheets
// (configurations created/updated, stale sheets refused, zero units, price_sheet.applied.v1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('add supply (US-05)', () => {
  it('demand agents add supply to their own demands only; the offer starts at Contacted, sourced for the demand', async () => {
    const t = await readyTenant(h);
    const owner = crypto.randomUUID();
    const dem = await h.staff(t, 'Demand agent', owner);
    const d = await h.call('POST', '/v1/demands', dem, { dealTypes: ['Lease'], segment: 'Commercial', localities: ['BKC'] });
    const body = {
      property: { segment: 'Commercial', propertyTypes: ['Office'], locality: 'BKC', city: 'Mumbai', buildingName: 'Platina', areaSqftMin: 3000 },
      offer: { dealType: 'Lease', rentMonthlyInrMin: 750_000 },
      parties: [{ role: 'Landlord', newPerson: { name: 'Land Lord', phones: ['9000400001'] } }],
    };
    const other = await h.staff(t, 'Demand agent');
    expect((await h.call('POST', `/v1/demands/${String(d.body['id'])}/add-supply`, other, body)).body['code']).toBe('not-demand-owner');
    const r = await h.call('POST', `/v1/demands/${String(d.body['code'])}/add-supply`, dem, body);
    expect(r.status).toBe(201);
    const offer = (r.body['offers'] as Record<string, unknown>[])[0];
    expect(offer).toMatchObject({ recordStage: 'Contacted', sourcedForDemandId: d.body['id'], sourcedForDemandCode: d.body['code'] });
    const evs = (await h.events(t)).filter((e) => e.aggregateId === offer?.['id']).map((e) => e.eventType);
    expect(evs).toEqual(['offer.created.v1', 'offer.record_stage_changed.v1']);
    expect((await h.call('GET', `/v1/offers?sourcedForDemandId=${String(d.body['id'])}`, dem)).body.items).toHaveLength(1);
    // Dedup first: the same property again is suspected; an existing property can be picked instead.
    const dup = await h.call('POST', `/v1/demands/${String(d.body['id'])}/add-supply`, dem, body);
    expect(dup.body['code']).toBe('duplicate-property-suspected');
    const propertyId = (r.body['property'] as { id: string }).id;
    const clash = await h.call('POST', `/v1/demands/${String(d.body['id'])}/add-supply`, dem, { existingPropertyId: propertyId, offer: { dealType: 'Lease' } });
    expect(clash.body['code']).toBe('deal-type-exists');
    const sale = await h.call('POST', `/v1/demands/${String(d.body['id'])}/add-supply`, dem, { existingPropertyId: propertyId, offer: { dealType: 'Sale', salePriceInrMin: 500_000_000 } });
    expect(sale.status).toBe(201);
    expect((await h.call('POST', `/v1/demands/${String(d.body['id'])}/add-supply`, dem, { offer: { dealType: 'Sale' } })).status).toBe(400);
  });
});

describe('price sheets (US-17)', () => {
  it('creates and updates configurations, refuses stale sheets, zeroes missing units', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const p = await h.call('POST', '/v1/projects', sup, { name: 'Harbour View', developerName: 'Acme', locality: 'Wadala', city: 'Mumbai', possessionDate: '2028' });
    const code = String(p.body['code']);
    const first = await h.call('POST', `/v1/projects/${code}/price-sheets`, sup, {
      sheetDate: '2026-09-01',
      receivedVia: 'developer_email',
      lines: [
        { propertyType: 'apartment', bhkMin: 2, bhkMax: 2, areaSqftMin: 750, areaBasis: 'Carpet', salePriceInrMin: 25_000_000, unitCount: 40 },
        { propertyType: 'Apartment', bhkMin: 3, bhkMax: 3, areaSqftMin: 1100, salePriceInrMin: 38_000_000, unitCount: 20 },
      ],
    });
    expect(first.status).toBe(201);
    expect(first.body['createdOffers']).toHaveLength(2);
    const project = await h.call('GET', `/v1/projects/${code}`, sup);
    const configs = project.body['configurations'] as Record<string, unknown>[];
    expect(configs.map((c) => [c['dealType'], c['market'], c['label'], c['unitCount']])).toEqual([
      ['Sale', 'Primary', 'New Project, For Sale', 40],
      ['Sale', 'Primary', 'New Project, For Sale', 20],
    ]);
    expect(project.body['latestPriceSheetDate']).toBe('2026-09-01');
    expect((await h.call('POST', `/v1/projects/${code}/price-sheets`, sup, { sheetDate: '2026-08-01', lines: [{ propertyType: 'Apartment' }] })).body['code']).toBe('stale-price-sheet');
    const second = await h.call('POST', `/v1/projects/${code}/price-sheets`, sup, {
      sheetDate: '2026-09-15',
      lines: [{ propertyType: 'Apartment', bhkMin: 2, bhkMax: 2, salePriceInrMin: 26_000_000 }],
      missingConfigurations: 'zero_units',
    });
    expect(second.body['priceChangedOffers']).toHaveLength(2);
    const changed = await h.events(t, 'offer.price_changed.v1');
    expect(changed.every((e) => e.data['cause'] === 'price_sheet')).toBe(true);
    const applied = await h.events(t, 'price_sheet.applied.v1');
    expect(applied.map((e) => e.data['sheetDate'])).toEqual(['2026-09-01', '2026-09-15']);
    const after = (await h.call('GET', `/v1/projects/${code}`, sup)).body['configurations'] as Record<string, unknown>[];
    expect(after.map((c) => c['unitCount'])).toEqual([40, 0]);
    expect(after[0]?.['salePriceInrMin']).toBe(26_000_000);
    const sheets = await h.call('GET', `/v1/projects/${code}/price-sheets`, sup);
    expect(sheets.body.items?.map((s) => s['sheetDate'])).toEqual(['2026-09-15', '2026-09-01']);
    const updated = await h.events(t, 'offer.updated.v1');
    expect(updated.at(-1)?.data['priceSheetDate']).toBe('2026-09-15');
  });
});
