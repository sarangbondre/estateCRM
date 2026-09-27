// REC-04 demand, people and quick add (contract-validated responses): first touch, demand dedup (US-08), masked
// people, phone ownership, flags, phone-first lookup, R-10 stages; demand.* / person.* / merge_candidate.* events.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const wish = (over: Record<string, unknown> = {}) => ({
  dealTypes: ['Lease'],
  segment: 'Residential',
  propertyTypes: ['Apartment'],
  localities: ['Bandra West'],
  rentMonthlyInrMin: 100_000,
  rentMonthlyInrMax: 150_000,
  bhkMin: 2,
  bhkMax: 3,
  ...over,
});

describe('demands', () => {
  it('creates a demand with its client and first touch (created v1, touch_added v2)', async () => {
    const t = await readyTenant(h);
    const dem = await h.staff(t, 'Demand agent');
    const r = await h.call('POST', '/v1/demands', dem, {
      ...wish({ statedTags: { furnishing: 'furnished', isJodi: false } }),
      newPerson: { name: 'Asha Rao', phones: ['9000000002'], emails: ['asha.rao1@example.com'] },
      sourceType: 'Direct',
    });
    expect(r.status).toBe(201);
    expect(r.body['code']).toMatch(/^DEM-\d{6}$/);
    expect(r.body['clientDisplayName']).toBe('A. R.');
    expect(r.body['label']).toBe('Wants to Rent');
    expect((r.body['micromarkets'] as { name: string }[]).map((m) => m.name)).toEqual(['Bandra West']);
    expect(r.body['statedTags']).toEqual({ furnishing: 'Furnished', isJodi: false });
    expect(r.body['touchCount']).toBe(1);
    const evs = (await h.events(t)).filter((e) => e.aggregateId === r.body['id']);
    expect(evs.map((e) => [e.eventType, e.aggregateVersion])).toEqual([
      ['demand.created.v1', 1],
      ['demand.touch_added.v1', 2],
    ]);
    expect(evs[0]?.data['statedTags']).toEqual({ furnishing: 'Furnished', isJodi: 'false' });
    expect(evs[1]?.data['isFirstTouch']).toBe(true);
  });

  it('patch, record stage, touches (first touch keeps the credit), 409 on unknown stages', async () => {
    const t = await readyTenant(h);
    const dem = await h.staff(t, 'Demand agent');
    const d = await h.call('POST', '/v1/demands', dem, wish());
    const id = String(d.body['id']);
    const p = await h.call('PATCH', `/v1/demands/${id}`, { ...dem, 'if-match': String(d.body['version']) }, { budgetInrMax: null, rentMonthlyInrMax: 175_000 });
    expect(p.status).toBe(200);
    expect(p.body['rentMonthlyInrMax']).toBe(175_000);
    expect((await h.call('POST', `/v1/demands/${id}/record-stage`, dem, { to: 'Verified' })).body['recordStage']).toBe('Verified');
    expect((await h.call('POST', `/v1/demands/${id}/record-stage`, dem, { to: 'Contacted' })).status).toBe(400);
    const touch = await h.call('POST', `/v1/demands/${id}/touches`, dem, { sourceType: 'Channel', sourceDetail: 'Referral' });
    expect(touch.status).toBe(201);
    expect(touch.body['isFirstTouch']).toBe(false);
    const list = await h.call('GET', `/v1/demands/${String(d.body['code'])}/touches`, dem);
    expect(list.body.items?.map((x) => x['isFirstTouch'])).toEqual([true, false]);
    expect((await h.call('GET', `/v1/demands/${id}`, dem)).body['touchCount']).toBe(2);
    expect((await h.call('GET', '/v1/demands?dealType=Lease&segment=Residential', dem)).body.items).toHaveLength(1);
    expect((await h.call('GET', '/v1/demands?dealType=Sale', dem)).body.items).toHaveLength(0);
  });
});

describe('people', () => {
  it('masked by default, phone owned by one person, contacts write-only', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const r = await h.call('POST', '/v1/people', sup, { person: { name: 'Ravi Menon', phones: ['+91 90000 00003'], whatsappPhone: '+919000000003', partyType: 'owner' } });
    expect(r.status).toBe(201);
    expect(r.body['displayName']).toBe('R. M.');
    expect(r.body['phonesMasked']).toEqual(['+91 90•••••003']);
    expect(r.body['hasWhatsapp']).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('Ravi');
    const dup = await h.call('POST', '/v1/people', sup, { person: { name: 'Other', phones: ['09000000003'] } });
    expect(dup.status).toBe(409);
    expect(dup.body['code']).toBe('person-phone-exists');
    expect(dup.body['personId']).toBe(r.body['id']);
    const bad = await h.call('POST', '/v1/people', sup, { person: { phones: ['12'] } });
    expect(bad.body['code']).toBe('phone-invalid');
    const patched = await h.call('PATCH', `/v1/people/${String(r.body['code'])}`, sup, { phones: ['+91 90000 00004'], name: 'Ravi K Menon' });
    expect(patched.status).toBe(200);
    expect(patched.body['phonesMasked']).toEqual(['+91 90•••••004']);
    expect(patched.body['displayName']).toBe('R. K. M.');
  });

  it('flags: add emits once, removal needs a manager', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const p = await h.call('POST', '/v1/people', sup, { person: { name: 'Flag Me', phones: ['9000000005'] } });
    const id = String(p.body['id']);
    expect((await h.call('POST', `/v1/people/${id}/flags`, sup, { flag: 'broker_posing' })).body['flags']).toEqual(['broker_posing']);
    await h.call('POST', `/v1/people/${id}/flags`, sup, { flag: 'broker_posing', reason: 'again' });
    expect((await h.call('POST', `/v1/people/${id}/flags`, sup, { flag: 'broker_posing', action: 'remove' })).status).toBe(403);
    expect((await h.call('POST', `/v1/people/${id}/flags`, await h.staff(t, 'Manager'), { flag: 'broker_posing', action: 'remove' })).body['flags']).toEqual([]);
    expect(await h.events(t, 'person.flagged.v1')).toHaveLength(1);
    expect(await h.events(t, 'person.flag_removed.v1')).toHaveLength(1);
    expect((await h.call('GET', '/v1/people?flag=broker_posing', sup)).body.items).toHaveLength(0);
  });
});

describe('quick add (US-04)', () => {
  it('lookup by phone (POST) returns the masked person, open demands and offers', async () => {
    const t = await readyTenant(h);
    const dem = await h.staff(t, 'Demand agent');
    await h.call('POST', '/v1/demands', dem, { ...wish(), newPerson: { name: 'Look Up', phones: ['9000000006'] } });
    const r = await h.call('POST', '/v1/quick-add/lookup', dem, { phone: '+91-90000-00006' });
    expect(r.status).toBe(200);
    expect(r.body['normalised']).toBe(true);
    const people = r.body['people'] as { person: { displayName: string }; openDemands: unknown[] }[];
    expect(people[0]?.person.displayName).toBe('L. U.');
    expect(people[0]?.openDemands).toHaveLength(1);
    const none = await h.call('POST', '/v1/quick-add/lookup', dem, { phone: 'abc' });
    expect(none.body).toEqual({ people: [], normalised: false });
  });

  it('same person + same wish → touch; a different wish → new demand + demand_similarity candidate', async () => {
    const t = await readyTenant(h);
    const dem = await h.staff(t, 'Demand agent');
    const first = await h.call('POST', '/v1/quick-add', dem, { phone: '9000000007', name: 'Quick One', side: 'Demand', demand: wish() });
    expect(first.status).toBe(201);
    expect(first.body['outcome']).toBe('demand_created');
    expect((first.body['demand'] as { recordStage: string }).recordStage).toBe('Captured');
    const again = await h.call('POST', '/v1/quick-add', dem, { phone: '+919000000007', side: 'Demand', demand: wish({ rentMonthlyInrMax: 160_000 }) });
    expect(again.status).toBe(200);
    expect(again.body['outcome']).toBe('touch_added');
    expect((again.body['demand'] as { id: string }).id).toBe((first.body['demand'] as { id: string }).id);
    const other = await h.call('POST', '/v1/quick-add', dem, {
      phone: '9000000007',
      side: 'Demand',
      demand: wish({ localities: ['Powai'], bhkMin: 4, bhkMax: 4, rentMonthlyInrMin: 400_000, rentMonthlyInrMax: 500_000 }),
    });
    expect(other.body['outcome']).toBe('demand_created');
    expect(other.body['mergeCandidateIds']).toHaveLength(1);
    const raised = await h.events(t, 'merge_candidate.raised.v1');
    expect(raised[0]?.data).toMatchObject({ kind: 'uncertain_merge', aggregateType: 'demand' });
    const picked = await h.call('POST', '/v1/quick-add', dem, {
      phone: '9000000007',
      side: 'Demand',
      existingDemandId: (other.body['demand'] as { id: string }).id,
    });
    expect(picked.body['outcome']).toBe('touch_added');
  });

  it('supply during a call starts at Contacted; roles are enforced', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const r = await h.call('POST', '/v1/quick-add', sup, {
      phone: '9000000008',
      name: 'Owner Call',
      side: 'Supply',
      duringCall: true,
      property: { segment: 'Commercial', propertyTypes: ['Office'], locality: 'Lower Parel', city: 'Mumbai', areaSqftMin: 2000 },
      offers: [{ dealType: 'Lease', rentMonthlyInrMin: 300_000 }],
    });
    expect(r.status).toBe(201);
    expect(r.body['outcome']).toBe('offers_created');
    expect((r.body['offers'] as { recordStage: string; captureMode: string }[])[0]).toMatchObject({ recordStage: 'Contacted', captureMode: 'typed_in' });
    expect((r.body['property'] as { parties: { role: string }[] }).parties[0]?.role).toBe('Landlord');
    expect((await h.call('POST', '/v1/quick-add', sup, { phone: '9000000008', side: 'Demand', demand: wish() })).status).toBe(403);
    expect((await h.call('POST', '/v1/quick-add', sup, { phone: 'x', side: 'Supply' })).body['code']).toBe('phone-invalid');
  });
});
