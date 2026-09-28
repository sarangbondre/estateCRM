// REC-06 merges (US-09): candidate queue and dismissal, merge (children re-pointed, undo log), column-level undo
// with conflicts, undo blocked by a later merge, guards; records.merged/merge_undone + audit events.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, readyTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const person = async (t: string, phone: string, name: string) =>
  (await h.call('POST', '/v1/people', await h.staff(t, 'Supply agent'), { person: { name, phones: [phone] } })).body;

describe('merges', () => {
  it('merges people (phones, demands move), undoes it, refuses a second undo', async () => {
    const t = await readyTenant(h);
    const a = await person(t, '9000200001', 'Anil Shah');
    const b = await person(t, '9000200002', 'A Shah');
    const dem = await h.staff(t, 'Demand agent');
    const d = await h.call('POST', '/v1/demands', dem, { dealTypes: ['Lease'], segment: 'Residential', personId: b['id'] });
    const mgr = await h.staff(t, 'Manager');
    const m = await h.call('POST', '/v1/merges', mgr, { aggregateType: 'person', survivorId: a['id'], mergedIds: [b['id']] });
    expect(m.status).toBe(201);
    expect(m.body['movedCounts']).toMatchObject({ person_phones: 1, demands: 1 });
    expect((await h.call('GET', `/v1/demands/${String(d.body['id'])}`, dem)).body['personId']).toBe(a['id']);
    const merged = await h.call('GET', `/v1/people/${String(b['id'])}`, mgr);
    expect(merged.body).toMatchObject({ status: 'merged', mergedIntoId: a['id'] });
    expect((await h.call('GET', `/v1/people/${String(a['id'])}`, mgr)).body['phonesMasked']).toHaveLength(2);
    expect((await h.call('POST', '/v1/merges', mgr, { aggregateType: 'person', survivorId: a['id'], mergedIds: [b['id']] })).body['code']).toBe('merge-not-allowed');

    const undo = await h.call('POST', `/v1/merges/${String(m.body['id'])}/undo`, mgr);
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ status: 'undone', movedCounts: { conflicts: 0 } });
    expect((await h.call('GET', `/v1/demands/${String(d.body['id'])}`, dem)).body['personId']).toBe(b['id']);
    expect((await h.call('GET', `/v1/people/${String(b['id'])}`, mgr)).body['status']).toBe('active');
    expect((await h.call('POST', `/v1/merges/${String(m.body['id'])}/undo`, mgr)).body['code']).toBe('merge-already-undone');
    expect((await h.call('GET', `/v1/merges/${String(m.body['id'])}`, mgr)).body['status']).toBe('undone');
    const types = (await h.events(t)).map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['records.merged.v1', 'records.merge_undone.v1', 'audit.recorded.v1']));
    const audits = await h.events(t, 'audit.recorded.v1');
    expect(audits.map((e) => e.data['action'])).toEqual(['records_merged', 'merge_undone']);
  });

  it('property merge moves a new deal type, turns a same-deal-type clash into an offer candidate; undo restores', async () => {
    const t = await readyTenant(h);
    const sup = await h.staff(t, 'Supply agent');
    const base = { segment: 'Commercial', propertyTypes: ['Office'], locality: 'Worli', city: 'Mumbai', buildingName: 'One Tower', areaSqftMin: 5000 };
    const p1 = await h.call('POST', '/v1/properties', sup, { property: base, offers: [{ dealType: 'Lease', rentMonthlyInrMin: 900_000 }] });
    const p2 = await h.call('POST', '/v1/properties', sup, {
      property: base,
      offers: [{ dealType: 'Lease', rentMonthlyInrMin: 950_000 }, { dealType: 'Sale', salePriceInrMin: 400_000_000 }],
      confirmNewDespiteCandidates: true,
    });
    const s = (p1.body['property'] as { id: string }).id;
    const mid = (p2.body['property'] as { id: string }).id;
    const op = await h.staff(t, 'Data operator');
    const m = await h.call('POST', '/v1/merges', op, { aggregateType: 'property', survivorId: s, mergedIds: [mid] });
    expect(m.status).toBe(201);
    const survivor = await h.call('GET', `/v1/properties/${s}`, sup);
    expect((survivor.body['offers'] as { dealType: string }[]).map((o) => o.dealType).sort()).toEqual(['Lease', 'Sale']);
    const cands = await h.call('GET', '/v1/merge-candidates?aggregateType=offer', op);
    expect(cands.body.items).toHaveLength(1);
    const undo = await h.call('POST', `/v1/merges/${String(m.body['id'])}/undo`, await h.staff(t, 'Admin'));
    expect(undo.status).toBe(200);
    expect(((await h.call('GET', `/v1/properties/${s}`, sup)).body['offers'] as unknown[]).length).toBe(1);
    expect((await h.call('GET', `/v1/properties/${mid}`, sup)).body['status']).toBe('active');
  });

  it('demand merge keeps the earliest touch as first touch; a later merge blocks undo; conflicts are reported', async () => {
    const t = await readyTenant(h);
    const dem = await h.staff(t, 'Demand agent');
    const mk = async () => (await h.call('POST', '/v1/demands', dem, { dealTypes: ['Sale'], segment: 'Residential' })).body;
    const d1 = await mk();
    const d2 = await mk();
    const d3 = await mk();
    const mgr = await h.staff(t, 'Manager');
    const m1 = await h.call('POST', '/v1/merges', mgr, { aggregateType: 'demand', survivorId: d2['id'], mergedIds: [d1['id']] });
    expect(m1.status).toBe(201);
    const touches = await h.call('GET', `/v1/demands/${String(d2['id'])}/touches`, dem);
    expect(touches.body.items?.map((x) => x['isFirstTouch'])).toEqual([true, false]);
    expect(touches.body.items?.[0]?.['demandId']).toBe(d2['id']);
    expect(touches.body.items?.[0]?.['id']).toBe(d1['firstTouchId']);
    const m2 = await h.call('POST', '/v1/merges', mgr, { aggregateType: 'demand', survivorId: d2['id'], mergedIds: [d3['id']] });
    expect(m2.status).toBe(201);
    expect((await h.call('POST', `/v1/merges/${String(m1.body['id'])}/undo`, mgr)).body['code']).toBe('merge-undo-blocked');
    // Undo the later one, then change a moved row before undoing the first: that column is left and reported.
    expect((await h.call('POST', `/v1/merges/${String(m2.body['id'])}/undo`, mgr)).status).toBe(200);
    await h.appCtx.uow.run({ tenantId: t, correlationId: 't' }, async (tx) => {
      await tx.store.updateWhere('touches', { id: String(d1['firstTouchId']) }, { demand_id: String(d3['id']), is_first_touch: false });
    });
    const undo = await h.call('POST', `/v1/merges/${String(m1.body['id'])}/undo`, mgr);
    expect(undo.status).toBe(200);
    expect((undo.body['movedCounts'] as { conflicts: number }).conflicts).toBeGreaterThan(0);
  });

  it('candidate queue: dismiss as different (remembered), closed candidates refuse', async () => {
    const t = await readyTenant(h);
    const dem = await h.staff(t, 'Demand agent');
    const wish = { dealTypes: ['Lease'], segment: 'Residential', localities: ['Bandra West'], rentMonthlyInrMin: 100_000 };
    await h.call('POST', '/v1/quick-add', dem, { phone: '9000200003', side: 'Demand', demand: wish });
    await h.call('POST', '/v1/quick-add', dem, { phone: '9000200003', side: 'Demand', demand: { ...wish, localities: ['Powai'], rentMonthlyInrMin: 300_000, bhkMin: 4 } });
    const op = await h.staff(t, 'Data operator');
    const q = await h.call('GET', '/v1/merge-candidates?reason=demand_similarity', op);
    expect(q.body.items).toHaveLength(1);
    const id = String(q.body.items?.[0]?.['id']);
    expect(q.body.items?.[0]?.['leftCode']).toMatch(/^DEM-/);
    const r = await h.call('POST', `/v1/merge-candidates/${id}/dismiss`, op, { decision: 'different', note: 'two separate needs' });
    expect(r.body['status']).toBe('different');
    expect((await h.call('POST', `/v1/merge-candidates/${id}/dismiss`, op, { decision: 'skipped' })).body['code']).toBe('candidate-closed');
    expect((await h.call('GET', '/v1/merge-candidates?status=different', op)).body.items).toHaveLength(1);
    expect((await h.call('GET', '/v1/merge-candidates', await h.staff(t, 'Supply agent'))).status).toBe(403);
  });
});
