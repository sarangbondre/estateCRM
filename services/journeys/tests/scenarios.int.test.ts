// PRD Appendix B supply scenarios AS-S1 and AS-S2, journeys' part end to end (records, crm-engine and listings are
// represented by their events). The demand scenarios and AS-S3…S6 are in the feature suites.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import type { EventDataMap } from '@11e/contracts/events';
import { ensureMigrated, eventProblems, harness, ids } from './helpers.js';

const h = harness();
const supply = ids();
const demandAgent = ids();
beforeAll(async () => {
  await ensureMigrated();
  h.clock.day('2026-02-02');
  for (const [userId, role] of [
    [supply, 'Supply agent'],
    [demandAgent, 'Demand agent'],
  ] as const)
    await h.deliver('user.changed.v1', { userId, role, active: true }, { aggregateId: userId });
});
afterAll(() => h.close());

let seq = 0;
async function demands(count: number, micromarket: string, dealType: string, budget: number) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const demandId = ids();
    await h.deliver(
      'demand.created.v1',
      {
        demandId,
        code: `DEM-S${String(++seq).padStart(4, '0')}`,
        dealTypes: [dealType],
        segment: 'Residential',
        micromarkets: [micromarket],
        ...(dealType === 'Lease' ? { rentMonthlyInrMax: budget + i * 5000 } : { budgetInrMax: budget + i * 100000 }),
        ownerUserId: demandAgent,
      },
      { aggregateId: demandId },
    );
    out.push(demandId);
  }
  return out;
}
const items = (subjectId: string) =>
  h.rows<{ section: string; reason: string; rank_score: number; rank_factors: Record<string, number> }>(
    sql`select * from queue_items where tenant_id = ${h.tenantId} and subject_id = ${subjectId} and status = 'open'`,
  );
const journey = async (id: string) => (await (await h.as(supply, 'Supply agent')).get(`/v1/offers/${id}/journey`)).body;

describe('AS-S2 proactive vetting', () => {
  it('a newspaper 2BHK in Andheri West ranks by demand gap (12), is confirmed, published and matched twice', async () => {
    await demands(12, 'Andheri West', 'Lease', 60000);
    await h.runJob('demand-gap-refresh');
    const offer: EventDataMap['offer.created.v1'] = {
      offerId: ids(),
      code: 'INV-S2',
      propertyId: ids(),
      dealType: 'Lease',
      segment: 'Residential',
      propertyTypes: ['Apartment'],
      bhkMin: 2,
      micromarket: 'Andheri West',
      rentMonthlyInrMin: 65000,
      sourceType: 'Channel',
      ownerUserId: supply,
    };
    await h.deliver('offer.created.v1', offer, { aggregateId: offer.offerId });
    const [item] = await items(offer.offerId);
    expect(item).toMatchObject({ section: 'should_call', reason: 'new_capture' });
    // gap = 12 open demands − 1 matching offer (the capture itself counts as supply once created)
    expect(item?.rank_factors['demandGap']).toBeCloseTo(11 / 20);
    const top = (await (await h.as(supply, 'Supply agent')).get('/v1/queues/me/sections/should_call')).body.items?.[0];
    expect(top?.['subjectCode']).toBe('INV-S2');

    await (await h.as(supply, 'Supply agent')).post('/v1/calls', { subjectType: 'offer', subjectId: offer.offerId, outcome: 'confirmed' });
    await h.deliver('offer.record_stage_changed.v1', { offerId: offer.offerId, from: 'Enriched', to: 'Verified', hasRealPhotos: true }, { aggregateId: offer.offerId, version: 2 });
    await h.deliver('publication.changed.v1', { subjectType: 'offer', subjectId: offer.offerId, from: 'Private', to: 'Public', reason: 'user' }, { aggregateId: offer.offerId, version: 1 });
    const [d1, d2] = await demands(2, 'Andheri West', 'Lease', 70000);
    for (const demandId of [d1, d2]) {
      const matchId = ids();
      await h.deliver('match.suggested.v1', { matchId, code: 'MAT-S2', demandId: demandId as string, offerIds: [offer.offerId], score: 82 }, { aggregateId: matchId });
    }
    // Verified offers get no Must call for Suggested matches (JA-3); counts show on the journey.
    expect((await items(offer.offerId)).map((i) => i.section)).toEqual([]);
    expect(await journey(offer.offerId)).toMatchObject({ commercialStatus: 'Available', signals: { openMatches: 2 } });
  });
});

describe('AS-S1 interest first', () => {
  it('capture → enquiry → Must call → confirmed (₹8.5 L + a sale offer) → matches → leased → others notified', async () => {
    const propertyId = ids();
    const lease: EventDataMap['offer.created.v1'] = {
      offerId: ids(),
      code: 'INV-S1L',
      propertyId,
      dealType: 'Lease',
      segment: 'Commercial',
      propertyTypes: ['Office'],
      micromarket: 'Lower Parel',
      rentMonthlyInrMin: 900000,
      sourceType: 'Channel',
      ownerUserId: supply,
    };
    await h.deliver('offer.created.v1', lease, { aggregateId: lease.offerId });
    expect((await items(lease.offerId)).map((i) => i.section)).toEqual(['should_call']);
    await h.deliver('publication.changed.v1', { subjectType: 'offer', subjectId: lease.offerId, from: 'Private', to: 'Anonymous', reason: 'user' }, { aggregateId: lease.offerId, version: 1 });

    await h.deliver('enquiry.received.v1', { enquiryId: ids(), code: 'ENQ-0901', offerId: lease.offerId, receivedAt: h.clock.now().toISOString() }, { aggregateId: ids() });
    expect((await items(lease.offerId)).map((i) => i.section).sort()).toEqual(['must_call', 'should_call']);
    const me = await h.as(supply, 'Supply agent');
    const r = await me.post('/v1/calls', { subjectType: 'offer', subjectId: lease.offerId, outcome: 'confirmed', knownPriceInr: 850000 });
    expect(r.body['commercialStatus']).toBe('Available');
    expect(await items(lease.offerId)).toEqual([]);
    // the owner also sells: records adds a second offer on the same property
    const sale: EventDataMap['offer.created.v1'] = { ...lease, offerId: ids(), code: 'INV-S1S', dealType: 'Sale', rentMonthlyInrMin: 0, salePriceInrMin: 110_000_000, recordStage: 'Contacted' };
    await h.deliver('offer.created.v1', sale, { aggregateId: sale.offerId });

    const buyers = [];
    for (let i = 0; i < 3; i++) {
      const demandId = ids();
      await h.deliver('demand.created.v1', { demandId, code: `DEM-S1${i}`, dealTypes: ['Lease'], segment: 'Commercial', micromarkets: ['Lower Parel'], ownerUserId: demandAgent }, { aggregateId: demandId });
      const matchId = ids();
      await h.deliver('match.suggested.v1', { matchId, code: `MAT-S1${i}`, demandId, offerIds: [lease.offerId], score: 70 + i }, { aggregateId: matchId });
      await h.deliver('match.confirmed.v1', { matchId, demandId, offerIds: [lease.offerId] }, { aggregateId: matchId });
      buyers.push({ demandId, matchId });
    }
    expect(await journey(lease.offerId)).toMatchObject({ commercialStatus: 'Matched', signals: { confirmedMatches: 3 } });

    const da = await h.as(demandAgent, 'Demand agent');
    const winner = buyers[0] as { demandId: string; matchId: string };
    const deal = await da.post('/v1/deals', { demandId: winner.demandId, offerId: lease.offerId, matchId: winner.matchId, nextAction: 'LOI', followUpDate: '2026-02-03' });
    await da.patch(`/v1/deals/${deal.body['id']}`, { stage: 'Closed', closingPriceInr: 850000, agreedTerms: { leaseMonths: 36 } });
    expect((await journey(lease.offerId))['commercialStatus']).toBe('Closed');
    for (const b of buyers.slice(1))
      await h.deliver('match.closed.v1', { matchId: b.matchId, demandId: b.demandId, reason: 'leased_to_another_client' }, { aggregateId: b.matchId });
    const notified = await h.rows(sql`select id from notifications where tenant_id = ${h.tenantId} and kind = 'match_closed' and user_id = ${demandAgent}`);
    expect(notified).toHaveLength(2);
    // the sale offer stays live ("tenant in place" is a records fact)
    expect((await journey(sale.offerId))['commercialStatus']).toBe('Available');
    expect((await h.outbox('lease_renewal.due.v1')).length).toBe(0); // 36-month lease: no 11-month renewal
    for (const e of await h.outbox()) expect(eventProblems(e.payload)).toBeNull();
  });
});
