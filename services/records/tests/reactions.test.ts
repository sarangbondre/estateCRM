// REC-10 consumers: offer.confirmed, site_visit.completed, call.logged, demand.exited/reactivated, deal.closed/
// cancelled, offer.retired, lease_renewal.due, publication.changed, review_item.resolved — delivered like the drain
// (processed_events dedupe in the same transaction), stale versions dropped; market data API.
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

async function setup() {
  const t = await readyTenant(h);
  const sup = await h.staff(t, 'Supply agent');
  const r = await h.call('POST', '/v1/properties', sup, {
    property: { segment: 'Residential', propertyTypes: ['Apartment'], locality: 'Andheri West', city: 'Mumbai', areaSqftMin: 800 },
    offers: [{ dealType: 'Lease', rentMonthlyInrMin: 60_000 }],
    parties: [{ role: 'Landlord', newPerson: { name: 'React Owner', phones: ['9000500001'] } }],
  });
  const offer = (r.body['offers'] as { id: string; propertyId: string }[])[0] as { id: string; propertyId: string };
  const personId = ((r.body['property'] as { parties: { personId: string }[] }).parties[0] as { personId: string }).personId;
  const d = await h.call('POST', '/v1/demands', await h.staff(t, 'Demand agent'), { dealTypes: ['Lease'], segment: 'Residential', newPerson: { name: 'React Client', phones: ['9000500002'] } });
  return { t, sup, offer, personId, demand: d.body as { id: string; personId: string } };
}

describe('journeys reactions', () => {
  it('offer.confirmed lifts the record stage to Contacted once (dedupe on eventId)', async () => {
    const { t, sup, offer } = await setup();
    const eventId = randomUUID();
    const confirm = { eventType: 'offer.confirmed.v1', tenantId: t, eventId, data: { offerId: offer.id, confirmedAt: new Date().toISOString(), how: 'call' } };
    expect(await h.deliver(confirm)).toBe(true);
    expect(await h.deliver(confirm)).toBe(false);
    expect((await h.call('GET', `/v1/offers/${offer.id}`, sup)).body['recordStage']).toBe('Contacted');
    const stage = await h.events(t, 'offer.record_stage_changed.v1');
    expect(stage.map((e) => e.data)).toEqual([expect.objectContaining({ from: 'Captured', to: 'Contacted', changedBy: '00000000-0000-0000-0000-000000000001' })]);
    await h.deliver({ eventType: 'site_visit.completed.v1', tenantId: t, data: { visitId: randomUUID(), demandId: randomUUID(), offerIds: [offer.id] } });
    expect(await h.events(t, 'offer.record_stage_changed.v1')).toHaveLength(1);
  });

  it('call.logged: unreachable flags the person once; confirmed lifts the offer', async () => {
    const { t, sup, offer, personId } = await setup();
    const call = (extra: Record<string, unknown>) =>
      h.deliver({ eventType: 'call.logged.v1', tenantId: t, data: { callId: randomUUID(), subjectType: 'offer', subjectId: offer.id, personId, outcome: 'no_answer', ...extra } });
    await call({ personUnreachable: true });
    await call({ personUnreachable: true });
    expect((await h.call('GET', `/v1/people/${personId}`, sup)).body['flags']).toEqual(['unreachable']);
    expect(await h.events(t, 'person.flagged.v1')).toHaveLength(1);
    await call({ outcome: 'confirmed' });
    expect((await h.call('GET', `/v1/offers/${offer.id}`, sup)).body['recordStage']).toBe('Contacted');
  });

  it('demand.exited / reactivated apply by version; Lost with a competing price records market data; flagPerson', async () => {
    const { t, demand } = await setup();
    const mgr = await h.staff(t, 'Manager');
    await h.deliver({ eventType: 'demand.exited.v1', tenantId: t, aggregateVersion: 5, data: { demandId: demand.id, exit: 'Lost', competingPriceInr: 55_000, competingTerms: 'Andheri, 1 month free', flagPerson: true, personId: demand.personId } });
    await h.deliver({ eventType: 'demand.reactivated.v1', tenantId: t, aggregateVersion: 4, data: { demandId: demand.id } });
    const ex = await h.appCtx.uow.run({ tenantId: t, correlationId: 't' }, (tx) => tx.store.get('demands', demand.id));
    expect(ex).toMatchObject({ exit_state: 'Lost', exit_version: 5 });
    expect((await h.call('GET', `/v1/people/${demand.personId}`, mgr)).body['flags']).toEqual(['invalid']);
    const md = await h.call('GET', '/v1/market-data?source=lost_competing', mgr);
    expect(md.body.items?.[0]).toMatchObject({ source: 'lost_competing', rentMonthlyInr: 55_000, dealType: 'Lease', voided: false });
    await h.deliver({ eventType: 'demand.reactivated.v1', tenantId: t, aggregateVersion: 6, data: { demandId: demand.id } });
    const back = await h.appCtx.uow.run({ tenantId: t, correlationId: 't' }, (tx) => tx.store.get('demands', demand.id));
    expect(back?.exit_state).toBeNull();
  });

  it('deal.closed records closed_by_us market data; deal.cancelled voids it; cancel-first wins', async () => {
    const { t, offer, demand } = await setup();
    const mgr = await h.staff(t, 'Manager');
    const dealId = randomUUID();
    await h.deliver({ eventType: 'deal.closed.v1', tenantId: t, data: { dealId, demandId: demand.id, offerId: offer.id, closedAt: '2026-09-20T10:00:00Z', closingPriceInr: 58_000, dealType: 'Lease' } });
    const md = await h.call('GET', '/v1/market-data', mgr);
    expect(md.body.items?.[0]).toMatchObject({ source: 'closed_by_us', rentMonthlyInr: 58_000, observedOn: '2026-09-20', dealId });
    expect((await h.events(t, 'market_data.recorded.v1'))[0]?.data).toMatchObject({ kind: 'closed_by_us', priceInr: 58_000, recordedOn: '2026-09-20' });
    await h.deliver({ eventType: 'deal.cancelled.v1', tenantId: t, data: { dealId, demandId: demand.id, offerId: offer.id, reason: 'buyer backed out' } });
    expect((await h.call('GET', '/v1/market-data', mgr)).body.items).toHaveLength(0);
    expect((await h.call('GET', '/v1/market-data?includeVoided=true', mgr)).body.items?.[0]?.['voided']).toBe(true);
    const late = randomUUID();
    await h.deliver({ eventType: 'deal.cancelled.v1', tenantId: t, data: { dealId: late, demandId: demand.id, offerId: offer.id, reason: 'x' } });
    await h.deliver({ eventType: 'deal.closed.v1', tenantId: t, data: { dealId: late, demandId: demand.id, offerId: offer.id, closedAt: '2026-09-21T10:00:00Z' } });
    expect((await h.call('GET', '/v1/market-data?includeVoided=true', mgr)).body.items).toHaveLength(1);
  });

  it('offer.retired records closed_elsewhere; lease_renewal.due creates one Upcoming offer', async () => {
    const { t, sup, offer } = await setup();
    await h.deliver({ eventType: 'offer.retired.v1', tenantId: t, data: { offerId: offer.id, reason: 'already_gone', knownPriceInr: 62_000 } });
    expect((await h.events(t, 'market_data.recorded.v1'))[0]?.data).toMatchObject({ kind: 'closed_elsewhere', priceInr: 62_000 });
    const due = { eventType: 'lease_renewal.due.v1', tenantId: t, data: { propertyId: offer.propertyId, previousOfferId: offer.id, availableFrom: '2027-04-01' } };
    await h.deliver(due);
    await h.deliver({ ...due, eventId: randomUUID() });
    const offers = await h.call('GET', `/v1/offers?propertyId=${offer.propertyId}`, sup);
    const upcoming = (offers.body.items ?? []).filter((o) => o['id'] !== offer.id);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({ dealType: 'Lease', possessionStatus: 'Available From', possessionDate: '2027-04-01', recordStage: 'Contacted', rentMonthlyInrMin: 60_000 });
  });

  it('publication.changed caches the level for newer versions only', async () => {
    const { t, sup, offer, demand } = await setup();
    const pub = (v: number, to: string, subjectType = 'offer', subjectId = offer.id) =>
      h.deliver({ eventType: 'publication.changed.v1', tenantId: t, aggregateVersion: v, data: { subjectType, subjectId, from: 'Private', to, reason: 'user' } });
    await pub(3, 'Public');
    await pub(2, 'Anonymous');
    expect((await h.call('GET', `/v1/offers/${offer.id}`, sup)).body['publicationLevel']).toBe('Public');
    await pub(1, 'Anonymous', 'demand_post', demand.id);
    expect((await h.call('GET', `/v1/demands/${demand.id}`, sup)).body['publicationLevel']).toBe('Anonymous');
  });
});

describe('review_item.resolved.v1 (§4.16)', () => {
  async function ingest(t: string, rows: ReturnType<typeof toIntakeRow>[]) {
    const uploadId = randomUUID();
    intake.add(uploadId, 1, rows);
    await h.deliver({ eventType: 'rows.classified.v1', tenantId: t, data: { uploadId, batchNo: 1, rows: [] } });
    return uploadId;
  }
  const resolve = (t: string, ref: string, extra: Record<string, unknown>, version = 1) =>
    h.deliver({
      eventType: 'review_item.resolved.v1',
      tenantId: t,
      aggregateVersion: version,
      aggregateId: randomUUID(),
      data: { reviewItemId: `00000000-0000-4000-8000-${ref.padStart(12, '0')}`, uploadId: randomUUID(), rowId: randomUUID(), externalRef: ref, action: 'set', ...extra },
    });

  it('routes a held row once its side is set', async () => {
    const t = await readyTenant(h);
    await ingest(t, [toIntakeRow(supplyRow({ record_id: '111', side: null }))]);
    await resolve(t, '111', { side: 'Supply', recordScope: 'Property' });
    const offers = await h.call('GET', '/v1/offers', await h.staff(t, 'Supply agent'));
    expect(offers.body.items).toHaveLength(1);
    expect(offers.body.items?.[0]?.['needsReview']).toBe(false);
  });

  it('a side change voids the offer and creates the demand; discard voids; stale resolutions are ignored', async () => {
    const t = await readyTenant(h);
    await ingest(t, [toIntakeRow(supplyRow({ record_id: '222' })), toIntakeRow(supplyRow({ record_id: '333', locality: 'Colaba', phones: '+919000500003' }))]);
    await resolve(t, '222', { side: 'Demand' }, 2);
    await resolve(t, '222', { side: 'Supply' }, 1);
    const voided = await h.events(t, 'offer.voided.v1');
    expect(voided.map((e) => e.data['reason'])).toEqual(['side_changed']);
    const m = await h.staff(t, 'Manager');
    expect((await h.call('GET', '/v1/demands', m)).body.items).toHaveLength(1);
    await resolve(t, '333', { action: 'discard' });
    expect((await h.events(t, 'offer.voided.v1')).map((e) => e.data['reason'])).toEqual(['side_changed', 'duplicate_discarded']);
    expect((await h.call('GET', '/v1/offers', m)).body.items).toHaveLength(0);
    expect((await h.call('GET', `/v1/offers/${String(voided[0]?.data['offerId'])}`, m)).status).toBe(404);
  });
});
