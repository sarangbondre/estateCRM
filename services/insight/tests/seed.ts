// A small synthetic read model with known answers for the PRD Appendix A questions (used by the query, dashboard and
// benchmark tests). Seeded through the projectors, like real events. Clock: Wed 7 Oct 2026, 12:00 IST.
import { randomUUID } from 'node:crypto';
import { sql } from '@11e/db';
import { demandCreated, offerCreated } from './fixtures.js';
import type { Harness } from './helpers.js';

export const NOW = '2026-10-07T06:30:00.000Z';
const id = () => randomUUID();

export interface Seeded {
  me: string;
  supplyAgentA: string;
  supplyAgentB: string;
  expected: Record<string, number | string>;
}

/** Micromarket hierarchy with aliases (records reference data), as vocabulary-refresh stores it. */
export async function seedLocations(h: Harness): Promise<void> {
  const nodes: [string, string, string[]][] = [
    ['micromarket', 'Andheri West', ['Andheri W']],
    ['micromarket', 'Andheri East', ['Andheri E']],
    ['locality', 'Chakala', []],
    ['locality', 'Marol', []],
    ['micromarket', 'Powai', []],
    ['micromarket', 'BKC', ['Bandra Kurla Complex']],
    ['micromarket', 'Bhiwandi', []],
    ['micromarket', 'Juhu', []],
  ];
  for (const [level, name, aliases] of nodes)
    await sql`insert into micromarket_ref (tenant_id, id, level, name, aliases, city) values (${h.tenantId}, ${id()}, ${level}, ${name}, ${aliases}, 'Mumbai')`.execute(h.db);
}

export async function seedBenchmark(h: Harness): Promise<Seeded> {
  const me = id();
  const supplyAgentA = id();
  const supplyAgentB = id();
  await seedLocations(h);
  const offer = async (over: Parameters<typeof offerCreated>[0], extra: (offerId: string) => Promise<void> = async () => undefined, at = '2026-09-01T06:00:00.000Z') => {
    const o = offerCreated(over);
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId, occurredAt: at });
    await extra(o.offerId);
    return o;
  };
  const status = (offerId: string, to: 'Closed' | 'Upcoming' | 'Available') =>
    h.deliver('offer.commercial_status_changed.v1', { offerId, from: 'Available', to }, { aggregateId: offerId });
  const life = (subjectId: string, to: 'Fresh' | 'Stale', at: string, subjectType: 'offer' | 'demand' = 'offer') =>
    h.deliver('lifecycle.stage_changed.v1', { subjectType, subjectId, from: 'Ageing', to, day: to === 'Stale' ? 61 : 1 }, { aggregateId: subjectId, occurredAt: at });

  // Q1: active 2BHK lease offers in Andheri West → 3 (one Closed, one in Powai)
  for (let i = 0; i < 3; i++) await offer({ bhkMin: 2, bhkMax: 2 });
  await offer({ bhkMin: 2, bhkMax: 2 }, (o) => status(o, 'Closed'));
  await offer({ bhkMin: 2, bhkMax: 2, micromarket: 'Powai', locality: 'Powai' });

  // Q2: resale 3BHK in Powai under ₹3 Cr that are Fresh → 2
  const resale = { dealType: 'Sale', market: 'Secondary', bhkMin: 3, bhkMax: 3, micromarket: 'Powai', locality: 'Powai', rentMonthlyInrMin: undefined, rentMonthlyInrMax: undefined };
  await offer({ ...resale, salePriceInrMin: 25_000_000, salePriceInrMax: 25_000_000 }, (o) => life(o, 'Fresh', '2026-10-01T05:00:00.000Z'));
  await offer({ ...resale, salePriceInrMin: 29_000_000, salePriceInrMax: 29_000_000 }, (o) => life(o, 'Fresh', '2026-10-01T05:00:00.000Z'));
  await offer({ ...resale, salePriceInrMin: 35_000_000, salePriceInrMax: 35_000_000 }, (o) => life(o, 'Fresh', '2026-10-01T05:00:00.000Z'));
  await offer({ ...resale, salePriceInrMin: 28_000_000, salePriceInrMax: 28_000_000 }, (o) => life(o, 'Stale', '2026-09-10T05:00:00.000Z'));

  // Q3: commercial lease — Marol 5 open demands vs 1 supply (gap 4), BKC 1 (+3 from Q11) vs 2
  const office = { dealType: 'Lease', segment: 'Commercial', propertyTypes: ['Office'], bhkMin: undefined, bhkMax: undefined, areaSqftMin: 1500, areaSqftMax: 2000 };
  await offer({ ...office, micromarket: 'Marol', locality: 'Marol' });
  await offer({ ...office, micromarket: 'BKC', locality: 'BKC' });
  await offer({ ...office, micromarket: 'BKC', locality: 'BKC' });
  const officeDemand = { dealTypes: ['Lease'], segment: 'Commercial', propertyTypes: ['Office'], bhkMin: undefined, bhkMax: undefined };
  for (let i = 0; i < 5; i++) {
    const d = demandCreated({ ...officeDemand, micromarkets: ['Marol'], localities: ['Marol'] });
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
  }
  const bkc = demandCreated({ ...officeDemand, micromarkets: ['BKC'], localities: ['BKC'] });
  await h.deliver('demand.created.v1', bkc, { aggregateId: bkc.demandId });

  // Q4: closed office rents in Marol this quarter: ₹1,00,000 and ₹1,24,000 (avg ₹1,12,000); a September close excluded
  for (const [rent, at] of [
    [100_000, '2026-10-02T06:00:00.000Z'],
    [124_000, '2026-10-03T06:00:00.000Z'],
    [90_000, '2026-09-15T06:00:00.000Z'],
  ] as const) {
    const o = await offer({ ...office, micromarket: 'Marol', locality: 'Marol' }, (x) => status(x, 'Closed'));
    const d = demandCreated(officeDemand);
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    await h.deliver('demand.status_changed.v1', { demandId: d.demandId, from: 'In process', to: 'Closed' }, { aggregateId: d.demandId });
    const dealId = id();
    await h.deliver('deal.opened.v1', { dealId, code: `DEAL-${1000 + rent}`, demandId: d.demandId, offerId: o.offerId });
    await h.deliver('deal.closed.v1', { dealId, demandId: d.demandId, offerId: o.offerId, closedAt: at, closingPriceInr: rent, dealType: 'Lease' });
  }

  const juhu = { micromarket: 'Juhu', locality: 'Juhu' };
  // Q5: my follow-ups overdue today → 1 (another due later; another agent's overdue one)
  for (const [owner, follow] of [
    [me, '2026-10-05'],
    [me, '2026-10-20'],
    [id(), '2026-10-01'],
  ] as const) {
    const d = demandCreated({ ownerUserId: owner, micromarkets: ['Juhu'], localities: ['Juhu'] });
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    const o = await offer(juhu);
    const dealId = id();
    await h.deliver('deal.opened.v1', { dealId, code: `DEAL-${follow.replace(/-/g, '')}`, demandId: d.demandId, offerId: o.offerId });
    await h.deliver('deal.updated.v1', { dealId, stage: 'Negotiation', followUpDate: follow, overdue: follow < '2026-10-07' }, { aggregateId: dealId, version: 2 });
  }

  // Q6: Public offers that turned Stale this week → 1
  const pub = (o: string) => h.deliver('publication.changed.v1', { subjectType: 'offer', subjectId: o, from: 'Private', to: 'Public', reason: 'user' }, { aggregateId: o });
  await offer({ micromarket: 'Powai', locality: 'Powai', bhkMin: 1, bhkMax: 1 }, async (o) => {
    await pub(o);
    await life(o, 'Stale', '2026-10-06T04:00:00.000Z');
  });
  await offer({ micromarket: 'Powai', locality: 'Powai', bhkMin: 1, bhkMax: 1 }, async (o) => {
    await pub(o);
    await life(o, 'Stale', '2026-09-20T04:00:00.000Z');
  });
  await offer({ micromarket: 'Powai', locality: 'Powai', bhkMin: 1, bhkMax: 1 }, (o) => life(o, 'Stale', '2026-10-06T04:00:00.000Z'));

  // Q7: demands in Sourcing for more than 7 days → 1
  for (const since of ['2026-09-25T06:00:00.000Z', '2026-10-04T06:00:00.000Z']) {
    const d = demandCreated({ micromarkets: ['Juhu'], localities: ['Juhu'] });
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    await h.deliver('demand.status_changed.v1', { demandId: d.demandId, from: 'Active', to: 'Sourcing' }, { aggregateId: d.demandId, occurredAt: since });
  }

  // Q8: qualified demand last month by source → Channel 2, Digi 1 (an October one excluded)
  for (const [source, at] of [
    ['Channel', '2026-09-10T06:00:00.000Z'],
    ['Channel', '2026-09-12T06:00:00.000Z'],
    ['Digi', '2026-09-14T06:00:00.000Z'],
    ['Digi', '2026-10-02T06:00:00.000Z'],
    ['Digi', '2026-10-03T06:00:00.000Z'],
  ] as const) {
    const d = demandCreated({ sourceType: source, micromarkets: ['Juhu'], localities: ['Juhu'] });
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    await h.deliver('demand.qualified.v1', { demandId: d.demandId }, { occurredAt: at });
  }

  // Q9: industrial galas for lease in Bhiwandi → 2 (Q13: both 4,000 sq ft)
  const gala = { dealType: 'Lease', segment: 'Industrial', propertyTypes: ['Gala'], bhkMin: undefined, bhkMax: undefined, micromarket: 'Bhiwandi', locality: 'Bhiwandi', areaSqftMin: 4000, areaSqftMax: 4000 };
  await offer(gala);
  await offer(gala);
  // Q13 also: an industrial shed 3,500–4,500 sq ft (covers 4,000), and one of 10,000 (does not)
  await offer({ ...gala, propertyTypes: ['Shed'], areaSqftMin: 3500, areaSqftMax: 4500, micromarket: 'Andheri East', locality: 'Chakala' });
  await offer({ ...gala, propertyTypes: ['Warehouse'], areaSqftMin: 10_000, areaSqftMax: 10_000 });

  // Q10: offers verified this week per supply agent → A 2, B 1 (a September verification excluded)
  for (const [agent, at] of [
    [supplyAgentA, '2026-10-05T06:00:00.000Z'],
    [supplyAgentA, '2026-10-06T06:00:00.000Z'],
    [supplyAgentB, '2026-10-06T07:00:00.000Z'],
    [supplyAgentB, '2026-09-30T07:00:00.000Z'],
  ] as const) {
    await offer(juhu, (o) =>
      h.deliver('offer.record_stage_changed.v1', { offerId: o, from: 'Contacted', to: 'Verified', changedBy: agent }, { aggregateId: o, occurredAt: at }),
    );
  }

  // Q11: bundles suggested for office demand above 5,000 sq ft → 1
  for (const [area, bundle] of [
    [[6000, 8000], true],
    [[3000, 3500], true],
    [[6000, 8000], false],
  ] as const) {
    const d = demandCreated({ ...officeDemand, micromarkets: ['BKC'], localities: ['BKC'], areaSqftMin: area[0], areaSqftMax: area[1] });
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    const matchId = id();
    await h.deliver(
      'match.suggested.v1',
      { matchId, code: `MAT-${area[0]}${bundle ? 'B' : 'S'}`, demandId: d.demandId, offerIds: bundle ? [id(), id()] : [id()], isBundle: bundle, score: 80 },
      { aggregateId: matchId },
    );
  }

  // Q12: Upcoming offers available in the next 60 days → 1
  await offer({ ...juhu, possessionDate: '2026-11' }, (o) => status(o, 'Upcoming'));
  await offer({ ...juhu, possessionDate: '2027-06' }, (o) => status(o, 'Upcoming'));

  return {
    me,
    supplyAgentA,
    supplyAgentB,
    expected: {
      q1: 3,
      q2: 2,
      q3_top: 'Marol',
      q4_avg: 112_000,
      q5: 1,
      q6: 1,
      q7: 1,
      q8_top: 'Channel',
      q9: 2,
      q10_a: 2,
      q11: 1,
      q12: 1,
      q13: 3,
    },
  };
}
