// REC-11 desks (US-36): Business / Capital / Archive / Watchlist lists (watchlist by deadline), Network = people
// with a participant role, desk item patch (assign, archive, If-Match) with desk_item.updated.v1.
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

describe('desks', () => {
  it('lists, gets and patches desk items; network entries are read-only', async () => {
    const t = await readyTenant(h);
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const uploadId = randomUUID();
    intake.add(uploadId, 1, [
      toIntakeRow(supplyRow({ record_id: 'k1', record_scope: 'Business', sector: 'Hospitality', deal_type: 'Asset Sale', segment: null, property_type: null })),
      toIntakeRow(supplyRow({ record_id: 'k2', record_scope: 'Capital', deal_type: 'Debt', segment: null, property_type: null })),
      toIntakeRow(supplyRow({ record_id: 'k3', record_scope: 'Equipment', deal_type: 'Sale', segment: null, property_type: null })),
      toIntakeRow(supplyRow({ record_id: 'k4', record_scope: 'Market Signal', side: 'None', signal_type: 'Auction Notice', deal_type: null, deadline_date: later })),
      toIntakeRow(supplyRow({ record_id: 'k5', record_scope: 'Market Signal', side: 'None', signal_type: 'Auction Notice', deal_type: null, deadline_date: soon, phones: '+919000600001' })),
      toIntakeRow(supplyRow({ record_id: 'k6', record_scope: 'Market Participant', side: 'None', participant_role: 'Broker', deal_type: null, phones: '+919000600002' })),
    ]);
    await h.deliver({ eventType: 'rows.classified.v1', tenantId: t, data: { uploadId, batchNo: 1, rows: [] } });
    const agent = await h.staff(t, 'Demand agent');
    const biz = await h.call('GET', '/v1/desks/business', agent);
    expect(biz.body.items).toHaveLength(1);
    expect(biz.body.items?.[0]).toMatchObject({ desk: 'business', recordScope: 'Business', sector: 'Hospitality', archived: false });
    expect(String(biz.body.items?.[0]?.['code'])).toMatch(/^BIZ-\d{4}$/);
    expect((await h.call('GET', '/v1/desks/capital', agent)).body.items).toHaveLength(1);
    expect(String((await h.call('GET', '/v1/desks/archive', agent)).body.items?.[0]?.['code'])).toMatch(/^EQP-/);
    const watch = await h.call('GET', '/v1/desks/watchlist', agent);
    expect(watch.body.items?.map((i) => i['deadlineDate'])).toEqual([soon, later]);
    expect((await h.call('GET', '/v1/desks/watchlist?deadlineWithinDays=14', agent)).body.items).toHaveLength(1);
    const net = await h.call('GET', '/v1/desks/network', agent);
    expect(net.body.items?.[0]).toMatchObject({ desk: 'network', participantRole: 'Broker', recordScope: 'Market Participant' });

    const code = String(biz.body.items?.[0]?.['code']);
    expect((await h.call('GET', `/v1/desk-items/${code}`, agent)).body['code']).toBe(code);
    expect((await h.call('GET', `/v1/desk-items/${String(net.body.items?.[0]?.['id'])}`, agent)).body['desk']).toBe('network');
    const mgr = await h.staff(t, 'Manager');
    const assignee = randomUUID();
    expect((await h.call('PATCH', `/v1/desk-items/${code}`, agent, { assigneeUserId: assignee })).status).toBe(403);
    expect((await h.call('PATCH', `/v1/desk-items/${code}`, { ...mgr, 'if-match': '9' }, { assigneeUserId: assignee })).status).toBe(412);
    const assigned = await h.call('PATCH', `/v1/desk-items/${code}`, mgr, { assigneeUserId: assignee, note: 'call owner' });
    expect(assigned.body).toMatchObject({ assigneeUserId: assignee, version: 2 });
    const archived = await h.call('PATCH', `/v1/desk-items/${code}`, mgr, { archived: true });
    expect(archived.body['archived']).toBe(true);
    expect((await h.call('GET', '/v1/desks/business', agent)).body.items).toHaveLength(0);
    expect((await h.call('GET', '/v1/desks/business?archived=true', agent)).body.items).toHaveLength(1);
    expect((await h.events(t, 'desk_item.updated.v1')).map((e) => e.data['status'])).toEqual(['assigned', 'archived']);
    const netPatch = await h.call('PATCH', `/v1/desk-items/${String(net.body.items?.[0]?.['id'])}`, mgr, { archived: true });
    expect(netPatch.body['code']).toBe('desk-item-not-editable');
  });
});
