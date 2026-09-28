// ENG-04: incremental matching on events, propagation, demand.matching_completed.v1 and match.* events (LLD §4.5–4.7).
import { randomUUID } from 'node:crypto';
import { sql } from '@11e/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import {
  deliver,
  envelopeFor,
  matchesOf,
  officeDemandFacts,
  officeFacts,
  outbox,
  settle,
} from '../pipeline-helpers.js';
import { SOURCE } from '../unit/fixtures.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.tx((s) => s.hierarchy.replace(h.tenant, SOURCE, 1));
});
afterAll(() => h.close());

// per-aggregate journeys counters (records and journeys version independently)
const versions = new Map<string, number>();
const next = (id: string) => {
  const v = (versions.get(id) ?? 1) + 1;
  versions.set(id, v);
  return v;
};

async function newOffer(over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await deliver(h, envelopeFor(h, 'offer.created.v1', id, 1, officeFacts(id, over)));
  return id;
}
async function newDemand(over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await deliver(h, envelopeFor(h, 'demand.created.v1', id, 1, officeDemandFacts(id, over)));
  return id;
}
const stage = (
  subjectType: 'offer' | 'demand',
  id: string,
  to: 'Fresh' | 'Ageing' | 'Stale' | 'Expired' | 'Paused',
) =>
  deliver(
    h,
    envelopeFor(
      h,
      'lifecycle.stage_changed.v1',
      id,
      next(id),
      { subjectType, subjectId: id, from: 'x', to, day: 1 },
      'journeys',
    ),
  );
const commercial = (id: string, to: 'Available' | 'Closed' | 'Inactive' | 'Upcoming') =>
  deliver(
    h,
    envelopeFor(
      h,
      'offer.commercial_status_changed.v1',
      id,
      next(id),
      { offerId: id, from: 'x', to },
      'journeys',
    ),
  );
const eventsFor = async (matchId: string) =>
  (await outbox(h)).filter((e) => e.aggregateId === matchId).map((e) => e.type);

describe('incremental matching', () => {
  it('a new offer and demand produce one Suggested match with a code, rank and match.suggested.v1', async () => {
    const o = await newOffer();
    const d = await newDemand();
    await settle(h);
    const [m] = await matchesOf(h, d);
    expect(m).toMatchObject({ offer_ids: [o], status: 'Suggested', rank: 1, score: 100, is_bundle: false });
    expect(m?.code).toMatch(/^MAT-\d{4,}$/);
    const ev = (await outbox(h, 'match.suggested.v1')).find((e) => e.aggregateId === m?.id);
    expect(ev?.data).toMatchObject({
      matchId: m?.id,
      code: m?.code,
      demandId: d,
      offerIds: [o],
      isBundle: false,
      score: 100,
      flags: [],
    });
    expect(ev?.version).toBe(1);
  });

  it('AS-D1: two Marol floors in one building become one bundle match with a BND bundle row', async () => {
    const d = await newDemand({ localities: ['Marol'], micromarkets: [] });
    const f1 = await newOffer({
      areaSqftMin: 3200,
      areaSqftMax: 3200,
      rentMonthlyInrMin: 420_000,
      buildingKey: `bk-${d}`,
    });
    const f2 = await newOffer({
      areaSqftMin: 3000,
      areaSqftMax: 3000,
      rentMonthlyInrMin: 400_000,
      buildingKey: `bk-${d}`,
    });
    await settle(h);
    const bundle = (await matchesOf(h, d)).find((m) => m.is_bundle && m.offer_ids.includes(f1));
    expect(bundle?.offer_ids.sort()).toEqual([f1, f2].sort());
    const b = await h.tx((s) => s.bundles.get(h.tenant, bundle?.bundle_id as string));
    expect(b).toMatchObject({
      grouping: 'same_building',
      combinedAreaSqft: 6200,
      combinedRentMonthlyInr: 820_000,
      origin: 'engine',
      matchId: bundle?.id,
    });
    expect(b?.code).toMatch(/^BND-\d{4,}$/);
    // the floors alone are not single matches
    expect(
      (await matchesOf(h, d)).filter(
        (m) => !m.is_bundle && (m.offer_ids.includes(f1) || m.offer_ids.includes(f2)),
      ),
    ).toEqual([]);
  });

  it('demand.qualified.v1 runs the inventory check and publishes demand.matching_completed.v1', async () => {
    const d = await newDemand({ micromarkets: ['Powai'], localities: [] });
    const o = await newOffer({ micromarket: 'Powai', locality: null });
    await settle(h);
    await deliver(h, envelopeFor(h, 'demand.qualified.v1', d, next(d), { demandId: d }, 'journeys'));
    const run = await h.tx((s) => s.runs.activeForSubject(h.tenant, d));
    expect(run).toMatchObject({ status: 'queued', trigger: 'demand.qualified' });
    await settle(h);
    expect(await h.tx((s) => s.runs.get(h.tenant, run?.id as string))).toMatchObject({
      status: 'done',
      suggested: 0,
    });
    const done = (await outbox(h, 'demand.matching_completed.v1')).find((e) => e.aggregateId === d);
    expect(done?.data).toEqual({ demandId: d, runId: run?.id, matchCount: 1, bundleCount: 0 });
    expect((await matchesOf(h, d))[0]?.offer_ids).toEqual([o]);
  });

  it('no inventory: matchCount 0 (journeys starts sourcing)', async () => {
    const d = await newDemand({ micromarkets: ['Bandra Kurla Complex'], localities: [] });
    await deliver(h, envelopeFor(h, 'demand.qualified.v1', d, next(d), { demandId: d }, 'journeys'));
    await settle(h);
    expect(
      (await outbox(h, 'demand.matching_completed.v1')).find((e) => e.aggregateId === d)?.data,
    ).toMatchObject({ matchCount: 0, bundleCount: 0 });
  });

  it('available too late → exclusion row with dates (AS-S5)', async () => {
    const d = await newDemand({ micromarkets: ['Andheri West'], localities: [], moveInBy: '2026-12-15' });
    const o = await newOffer({
      micromarket: 'Andheri West',
      locality: null,
      possessionStatus: 'Available From',
      possessionDate: '2027-02-01',
    });
    await settle(h);
    const ex = await h.tx((_s, trx) =>
      sql<{
        reason: string;
        offer_id: string;
      }>`select reason, offer_id from ${sql.table('exclusions')} where tenant_id = ${h.tenant} and demand_id = ${d}`.execute(
        trx,
      ),
    );
    expect(ex.rows).toEqual([{ reason: 'available_too_late', offer_id: o }]);
    expect(await matchesOf(h, d)).toEqual([]);
  });

  it('a price change above budget flags the match (AS-S6) and a drop clears it', async () => {
    const d = await newDemand({ micromarkets: ['Andheri West'], localities: ['Versova'] });
    const o = await newOffer({ micromarket: 'Andheri West', locality: 'Versova' });
    await settle(h);
    await deliver(
      h,
      envelopeFor(h, 'offer.price_changed.v1', o, 2, {
        offerId: o,
        previous: { rentMonthlyInrMin: 900_000 },
        current: { rentMonthlyInrMin: 1_100_000 },
        cause: 'call',
      }),
    );
    await settle(h);
    const m = (await matchesOf(h, d)).find((x) => x.offer_ids.includes(o));
    expect(m?.flags).toEqual(['price_above_budget']);
    const flagged = (await outbox(h, 'match.flagged.v1')).filter((e) => e.aggregateId === m?.id);
    expect(flagged.map((e) => e.data)).toEqual([
      { matchId: m?.id, flag: 'price_above_budget', cleared: false },
    ]);
    expect((await outbox(h, 'match.suggested.v1')).filter((e) => e.aggregateId === m?.id)).toHaveLength(2); // re-rank
    await deliver(
      h,
      envelopeFor(h, 'offer.price_changed.v1', o, 3, {
        offerId: o,
        previous: {},
        current: { rentMonthlyInrMin: 950_000 },
      }),
    );
    await settle(h);
    expect((await matchesOf(h, d)).find((x) => x.offer_ids.includes(o))?.flags).toEqual([]);
  });

  it('top 20: a demand keeps at most 20 open suggestions', async () => {
    const d = await newDemand({
      micromarkets: ['Bhiwandi'],
      localities: [],
      segment: 'Industrial',
      propertyTypes: ['Warehouse'],
      areaSqftMin: 4000,
      areaSqftMax: 4000,
      rentMonthlyInrMin: null,
      rentMonthlyInrMax: 200_000,
    });
    for (let i = 0; i < 22; i++)
      await newOffer({
        micromarket: 'Bhiwandi',
        locality: 'Vadape',
        segment: 'Industrial',
        propertyTypes: ['Warehouse'],
        areaSqftMin: 4000,
        areaSqftMax: 4000,
        rentMonthlyInrMin: 150_000 + i * 1000,
      });
    await settle(h);
    const open = (await matchesOf(h, d)).filter((m) => m.status === 'Suggested');
    expect(open).toHaveLength(20);
    expect(open.map((m) => m.rank).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
});

describe('life curve effects (NFR-9: applied by the event handler)', () => {
  it('Stale offer → reconfirm flag; confirmed → cleared', async () => {
    const d = await newDemand({ micromarkets: ['Andheri West'], localities: ['Lokhandwala'] });
    const o = await newOffer({ micromarket: 'Andheri West', locality: 'Lokhandwala' });
    await settle(h);
    await stage('offer', o, 'Stale');
    const [m] = await matchesOf(h, d);
    expect(m?.flags).toEqual(['reconfirm']);
    await deliver(
      h,
      envelopeFor(
        h,
        'offer.confirmed.v1',
        o,
        next(o),
        { offerId: o, confirmedAt: h.now.value.toISOString(), how: 'call' },
        'journeys',
      ),
    );
    expect((await matchesOf(h, d))[0]?.flags).toEqual([]);
    expect(
      (await outbox(h, 'match.flagged.v1'))
        .filter((e) => e.aggregateId === m?.id)
        .map((e) => e.data['cleared']),
    ).toEqual([false, true]);
    await settle(h);
    expect((await matchesOf(h, d))[0]?.flags).toEqual([]);
  });

  it('Expired offer → Closed offer_expired; reconfirmed → reopened (offer_reactivated)', async () => {
    const d = await newDemand({
      micromarkets: ['Andheri West'],
      localities: ['Versova'],
      areaSqftMin: 1000,
      areaSqftMax: 2000,
    });
    const o = await newOffer({
      micromarket: 'Andheri West',
      locality: 'Versova',
      areaSqftMin: 1500,
      areaSqftMax: 1500,
    });
    await settle(h);
    await stage('offer', o, 'Expired');
    const [m] = await matchesOf(h, d);
    expect(m).toMatchObject({ status: 'Closed', closed_reason: 'offer_expired' });
    await deliver(
      h,
      envelopeFor(
        h,
        'offer.confirmed.v1',
        o,
        next(o),
        { offerId: o, confirmedAt: h.now.value.toISOString(), how: 'call' },
        'journeys',
      ),
    );
    await settle(h);
    expect((await matchesOf(h, d))[0]).toMatchObject({ status: 'Suggested', closed_reason: null });
    expect(await eventsFor(m?.id as string)).toEqual([
      'match.suggested.v1',
      'match.closed.v1',
      'match.reopened.v1',
    ]);
  });

  it('demand exited → matches Closed demand_exited; reactivated → reopened demand_reactivated', async () => {
    const d = await newDemand({
      micromarkets: ['Andheri West'],
      localities: [],
      areaSqftMin: 2500,
      areaSqftMax: 3000,
    });
    await newOffer({ micromarket: 'Andheri West', locality: null, areaSqftMin: 2800, areaSqftMax: 2800 });
    await settle(h);
    await deliver(
      h,
      envelopeFor(
        h,
        'demand.exited.v1',
        d,
        next(d),
        { demandId: d, exit: 'Lost', competingTerms: 'Powai, 2 months rent free' },
        'journeys',
      ),
    );
    const [m] = await matchesOf(h, d);
    expect(m).toMatchObject({ status: 'Closed', closed_reason: 'demand_exited' });
    await deliver(h, envelopeFor(h, 'demand.reactivated.v1', d, next(d), { demandId: d }, 'journeys'));
    await settle(h);
    expect((await matchesOf(h, d))[0]).toMatchObject({ status: 'Suggested' });
    expect((await outbox(h, 'match.reopened.v1')).find((e) => e.aggregateId === m?.id)?.data).toEqual({
      matchId: m?.id,
      demandId: d,
      reason: 'demand_reactivated',
    });
  });
});

describe('close propagation and compensation (AS-S1, HLD §7)', () => {
  it('lease closes: the deal match closes deal_closed; others "leased_to_another_client"; cancel reopens', async () => {
    const o = await newOffer({
      micromarket: 'Powai',
      locality: 'Hiranandani Gardens',
      areaSqftMin: 5200,
      areaSqftMax: 5200,
    });
    const ds = [
      await newDemand({ micromarkets: ['Powai'], localities: [] }),
      await newDemand({ micromarkets: ['Powai'], localities: [] }),
      await newDemand({ micromarkets: ['Powai'], localities: [] }),
    ];
    await settle(h);
    const dealId = randomUUID();
    const [winner, ...others] = ds as [string, string, string];
    const winnerMatch = (await matchesOf(h, winner)).find((m) => m.offer_ids.includes(o));
    await h
      .tx((s) => s.matches.get(h.tenant, winnerMatch?.id as string))
      .then((m) => h.tx((s) => s.matches.update({ ...(m as NonNullable<typeof m>), status: 'Confirmed' })));
    await deliver(
      h,
      envelopeFor(
        h,
        'deal.opened.v1',
        dealId,
        1,
        { dealId, code: 'DEAL-0019', demandId: winner, offerId: o },
        'journeys',
      ),
    );
    expect((await matchesOf(h, winner)).find((m) => m.offer_ids.includes(o))?.open_deal_id).toBe(dealId);
    await deliver(
      h,
      envelopeFor(
        h,
        'deal.closed.v1',
        dealId,
        2,
        { dealId, demandId: winner, offerId: o, closedAt: h.now.value.toISOString(), dealType: 'Lease' },
        'journeys',
      ),
    );
    await commercial(o, 'Closed');
    expect((await matchesOf(h, winner)).find((m) => m.offer_ids.includes(o))).toMatchObject({
      status: 'Closed',
      closed_reason: 'deal_closed',
      closed_by_deal_id: dealId,
    });
    for (const d of others)
      expect((await matchesOf(h, d)).find((m) => m.offer_ids.includes(o))).toMatchObject({
        status: 'Closed',
        closed_reason: 'leased_to_another_client',
        closed_by_deal_id: dealId,
      });

    await deliver(
      h,
      envelopeFor(
        h,
        'deal.cancelled.v1',
        dealId,
        3,
        { dealId, demandId: winner, offerId: o, reason: 'client backed out' },
        'journeys',
      ),
    );
    expect((await matchesOf(h, winner)).find((m) => m.offer_ids.includes(o))).toMatchObject({
      status: 'Confirmed',
      closed_reason: null,
      open_deal_id: null,
    });
    for (const d of others)
      expect((await matchesOf(h, d)).find((m) => m.offer_ids.includes(o))).toMatchObject({
        status: 'Suggested',
      });
    const reopened = (await outbox(h, 'match.reopened.v1')).filter(
      (e) => e.data['reason'] === 'deal_cancelled',
    );
    expect(reopened.filter((e) => (ds as string[]).includes(e.data['demandId'] as string))).toHaveLength(3);
  });

  it('offer Closed before deal.closed: the deal match reason is corrected to deal_closed', async () => {
    const o = await newOffer({ micromarket: 'Powai', locality: null, areaSqftMin: 6100, areaSqftMax: 6100 });
    const d = await newDemand({ micromarkets: ['Powai'], localities: [] });
    await settle(h);
    await commercial(o, 'Closed');
    const dealId = randomUUID();
    await deliver(
      h,
      envelopeFor(
        h,
        'deal.closed.v1',
        dealId,
        2,
        { dealId, demandId: d, offerId: o, closedAt: h.now.value.toISOString() },
        'journeys',
      ),
    );
    expect((await matchesOf(h, d)).find((m) => m.offer_ids.includes(o))).toMatchObject({
      closed_reason: 'deal_closed',
      closed_by_deal_id: dealId,
    });
  });

  it('offer retired / voided close with their reasons', async () => {
    const d = await newDemand({ micromarkets: ['Bandra Kurla Complex'], localities: [] });
    const a = await newOffer({ micromarket: 'BKC', locality: null });
    const b = await newOffer({ micromarket: 'BKC', locality: null });
    await settle(h);
    await deliver(
      h,
      envelopeFor(
        h,
        'offer.retired.v1',
        a,
        next(a),
        { offerId: a, reason: 'already_gone', knownPriceInr: 500_000 },
        'journeys',
      ),
    );
    await deliver(h, envelopeFor(h, 'offer.voided.v1', b, 2, { offerId: b, reason: 'duplicate_discarded' }));
    const ms = await matchesOf(h, d);
    expect(ms.find((m) => m.offer_ids.includes(a))).toMatchObject({
      status: 'Closed',
      closed_reason: 'offer_retired',
    });
    expect(ms.find((m) => m.offer_ids.includes(b))).toMatchObject({
      status: 'Closed',
      closed_reason: 'voided',
    });
  });
});

describe('merges (LLD §4.7)', () => {
  it('merging a duplicate offer collapses two matches; undo restores and reopens', async () => {
    const d = await newDemand({
      micromarkets: ['Andheri East'],
      localities: ['Saki Naka'],
      areaSqftMin: 800,
      areaSqftMax: 1200,
    });
    const a = await newOffer({ locality: 'Saki Naka', areaSqftMin: 1000, areaSqftMax: 1000 });
    const b = await newOffer({ locality: 'Saki Naka', areaSqftMin: 1000, areaSqftMax: 1000 });
    await settle(h);
    const before = await matchesOf(h, d);
    const onB = before.find((m) => m.offer_ids.includes(b) && !m.is_bundle);
    const mergeId = randomUUID();
    await deliver(
      h,
      envelopeFor(h, 'records.merged.v1', mergeId, 1, {
        mergeId,
        aggregateType: 'offer',
        survivorId: a,
        mergedIds: [b],
      }),
    );
    const after = await matchesOf(h, d);
    expect(after.find((m) => m.id === onB?.id)).toMatchObject({ status: 'Closed', closed_reason: 'merged' });
    expect(await h.tx((s) => s.mx.getOffer(h.tenant, b))).toMatchObject({ mergedInto: a });
    const undoId = randomUUID();
    await deliver(
      h,
      envelopeFor(h, 'records.merge_undone.v1', undoId, 2, {
        mergeId,
        aggregateType: 'offer',
        restoredIds: [b],
      }),
    );
    expect((await matchesOf(h, d)).find((m) => m.id === onB?.id)).toMatchObject({
      status: 'Suggested',
      offer_ids: [b],
    });
    expect(
      (await outbox(h, 'match.reopened.v1')).find((e) => e.aggregateId === onB?.id)?.data['reason'],
    ).toBe('merge_undone');
    expect(await h.tx((s) => s.mx.getOffer(h.tenant, b))).toMatchObject({ mergedInto: null });
  });
});

describe('engagement', () => {
  it('proposal.sent.v1 and site_visit.completed.v1 stamp the matches', async () => {
    const d = await newDemand({
      micromarkets: ['Andheri East'],
      localities: ['MIDC'],
      areaSqftMin: 300,
      areaSqftMax: 500,
    });
    const o = await newOffer({ locality: 'MIDC', areaSqftMin: 400, areaSqftMax: 400 });
    await settle(h);
    const [m] = await matchesOf(h, d);
    await deliver(
      h,
      envelopeFor(
        h,
        'proposal.sent.v1',
        randomUUID(),
        1,
        { proposalId: randomUUID(), demandId: d, matchIds: [m?.id as string] },
        'journeys',
      ),
    );
    await deliver(
      h,
      envelopeFor(
        h,
        'site_visit.completed.v1',
        randomUUID(),
        1,
        { visitId: randomUUID(), demandId: d, offerIds: [o] },
        'journeys',
      ),
    );
    const r = await h.tx((s) => s.matches.get(h.tenant, m?.id as string));
    expect(r?.proposalSentAt).toBeInstanceOf(Date);
    expect(r?.visitedAt).toBeInstanceOf(Date);
  });
});
