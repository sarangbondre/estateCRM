// PRD Appendix B acceptance scenarios (docs/inputs/vinit-journeys-artifact.md) at the matching-engine level, plus the
// ENG-07 precision check: every suggestion the engine makes on the labelled scenario inventory must be one a broker
// would make (precision), and every labelled-relevant pairing must be suggested (recall). Synthetic, PII-free data.
import { describe, expect, it } from 'vitest';
import { runDemand } from '../../src/domain/engine.js';
import { offerCloseCause, planMerge } from '../../src/domain/lifecycle.js';
import type { MatchState } from '../../src/domain/lifecycle.js';
import type { DemandMx, OfferMx } from '../../src/domain/types.js';
import { DEFAULT_WEIGHTS } from '../../src/domain/weights.js';
import { ctx, demand, offer } from './fixtures.js';

const T = DEFAULT_WEIGHTS.tuning;
const TODAY = '2026-10-01';

/** One engine run for a demand from scratch: the suggestions a broker would see. */
function suggest(d: DemandMx, inventory: readonly OfferMx[]) {
  const run = runDemand(d, inventory, [], ctx(DEFAULT_WEIGHTS, TODAY));
  const plan = planMerge(d, [], run.evaluations, T);
  return { run, plan, keys: plan.inserts.map((i) => i.offerSetKey) };
}
const keyOf = (...offers: OfferMx[]) =>
  offers
    .map((o) => o.id)
    .sort()
    .join(',');

// --- DEM-000127: Commercial Lease, office 5,000–7,000 sq ft built up, Andheri East / Marol, ₹8–10 L, 60 days ------
const dem127 = demand({
  code: 'DEM-000127',
  dealTypes: ['Lease'],
  segment: 'Commercial',
  propertyTypes: ['Office'],
  areaSqftMin: 5000,
  areaSqftMax: 7000,
  areaBasis: 'Builtup',
  rentMonthlyInrMin: 800_000,
  rentMonthlyInrMax: 1_000_000,
  micromarkets: ['Andheri East'],
  localities: ['Marol'],
  moveInBy: '2026-11-30', // within 60 days
});
const inv452 = offer({
  code: 'INV-00452',
  areaSqftMin: 5000,
  areaSqftMax: 5000,
  rentMonthlyInrMin: 850_000,
  furnishing: 'Furnished',
  locality: 'Marol',
});
const chakala6500 = offer({
  code: 'INV-00460',
  areaSqftMin: 6500,
  areaSqftMax: 6500,
  rentMonthlyInrMin: 950_000,
  locality: 'Chakala',
});
const marolFloor1 = offer({
  code: 'INV-00471',
  areaSqftMin: 3200,
  areaSqftMax: 3200,
  rentMonthlyInrMin: 420_000,
  buildingKey: 'bk-marol-tower',
  locality: 'Marol',
});
const marolFloor2 = offer({
  code: 'INV-00472',
  areaSqftMin: 3000,
  areaSqftMax: 3000,
  rentMonthlyInrMin: 400_000,
  buildingKey: 'bk-marol-tower',
  locality: 'Marol',
});
const noise = {
  powai: offer({ code: 'INV-00480', micromarket: 'Powai', locality: 'Hiranandani Gardens' }),
  shop: offer({ code: 'INV-00481', propertyTypes: ['Shop'] }),
  saleOffice: offer({
    code: 'INV-00482',
    dealType: 'Sale',
    salePriceInrMin: 110_000_000,
    rentMonthlyInrMin: null,
  }),
  tinyOffice: offer({
    code: 'INV-00483',
    areaSqftMin: 900,
    areaSqftMax: 900,
    rentMonthlyInrMin: 150_000,
    locality: 'Saki Naka',
  }),
  flat: offer({
    code: 'INV-00484',
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
  }),
  gala: offer({ code: 'INV-00485', segment: 'Industrial', propertyTypes: ['Gala'], locality: 'MIDC' }),
  expired: offer({ code: 'INV-00486', lifeStage: 'Expired' }),
  late: offer({ code: 'INV-00487', possessionStatus: 'Available From', possessionDateRaw: '2027-03' }),
  outside: offer({ code: 'INV-00488', outsideLaunchArea: true }),
  leased: offer({ code: 'INV-00489', commercialStatus: 'Closed' }),
};
const inventory127 = [inv452, chakala6500, marolFloor1, marolFloor2, ...Object.values(noise)];

describe('AS-D1: DEM-000127 inventory check → 3 matches incl. a Marol bundle', () => {
  const { run, plan, keys } = suggest(dem127, inventory127);
  it('suggests INV-00452, the Chakala office and ONE bundle of the two Marol floors', () => {
    expect(new Set(keys)).toEqual(
      new Set([keyOf(inv452), keyOf(chakala6500), keyOf(marolFloor1, marolFloor2)]),
    );
    expect(plan.inserts).toHaveLength(3);
  });
  it('the bundle is one match with combined area 6,200 sq ft and rent ₹8.2 L, same building', () => {
    expect(run.bundles).toHaveLength(1);
    expect(run.bundles[0]).toMatchObject({
      grouping: 'same_building',
      combinedAreaSqft: 6200,
      combinedRentMonthlyInr: 820_000,
    });
  });
  it('INV-00452 ranks first (same locality, within budget and area)', () => {
    expect(plan.inserts[0]?.offerSetKey).toBe(keyOf(inv452));
    expect(plan.inserts[0]?.score).toBe(100);
  });
  it('records date-aware and liveness exclusions with reasons; other mismatches are silently skipped', () => {
    expect(run.exclusions.map((e) => [e.offerId, e.reason]).sort()).toEqual(
      [
        [noise.expired.id, 'offer_expired'],
        [noise.late.id, 'available_too_late'],
      ].sort(),
    );
    expect(run.exclusions.find((e) => e.reason === 'available_too_late')?.detail).toBe(
      'Available from 2027-03-01, demand needs by 2026-11-30',
    );
  });
});

describe('AS-D2: sourced supply; INV-00611 found leased → its match is dropped', () => {
  const sourced = [11, 12, 13].map((i) =>
    offer({
      code: `INV-006${i}`,
      areaSqftMin: 5500,
      areaSqftMax: 5500,
      rentMonthlyInrMin: 900_000,
      locality: 'Marol',
    }),
  );
  it('all three match on creation; the leased one closes "leased_to_another_client" on the next run', () => {
    const first = suggest(dem127, sourced);
    expect(first.keys).toHaveLength(3);
    const existing: MatchState[] = first.plan.inserts.map((ins, i) => ({
      id: `m-${i}`,
      demandId: dem127.id,
      offerIds: [ins.offerSetKey],
      offerSetKey: ins.offerSetKey,
      isBundle: false,
      score: ins.score,
      rank: ins.rank,
      factors: ins.factors,
      flags: ins.flags,
      status: 'Suggested',
      closedReason: null,
      closedByDealId: null,
      priorStatus: null,
      rejectedScore: null,
      rejectedFactsVersion: null,
      weightsVersion: 0,
    }));
    const leased = { ...(sourced[0] as OfferMx), commercialStatus: 'Closed' };
    const again = runDemand(dem127, [leased, ...sourced.slice(1)], [], ctx(DEFAULT_WEIGHTS, TODAY));
    const plan = planMerge(dem127, existing, again.evaluations, T);
    const dropped = existing.find((m) => m.offerSetKey === leased.id);
    expect(plan.events).toEqual([
      { type: 'closed', matchId: dropped?.id, reason: 'leased_to_another_client' },
    ]);
  });
});

describe('AS-S1: INV-00452 matches 3 demands; the lease closes → other demands notified; sale offer matches an investor', () => {
  const tenants = [
    dem127,
    demand({
      code: 'DEM-000130',
      areaSqftMin: 4500,
      areaSqftMax: 6000,
      rentMonthlyInrMax: 900_000,
      micromarkets: ['Andheri East'],
      localities: [],
    }),
    demand({
      code: 'DEM-000131',
      areaSqftMin: 5000,
      areaSqftMax: 5500,
      areaBasis: null,
      rentMonthlyInrMax: 1_200_000,
      micromarkets: [],
      localities: ['Marol'],
    }),
  ];
  const notTenant = demand({ code: 'DEM-000132', micromarkets: ['Powai'], localities: [] });
  const investor = demand({
    code: 'DEM-000140',
    dealTypes: ['Sale'],
    market: 'Any',
    rentMonthlyInrMin: null,
    rentMonthlyInrMax: null,
    budgetInrMax: 120_000_000,
    areaSqftMin: 4000,
    areaSqftMax: 6000,
    statedTags: { tenancy_status: 'Tenanted' },
    micromarkets: ['Andheri East'],
    localities: [],
  });
  const inv453 = offer({
    code: 'INV-00453',
    propertyId: inv452.propertyId,
    dealType: 'Sale',
    market: 'Secondary',
    salePriceInrMin: 110_000_000,
    rentMonthlyInrMin: null,
    tenancyStatus: 'Tenanted',
    areaSqftMin: 5000,
    areaSqftMax: 5000,
  });

  it('INV-00452 is suggested for exactly the three tenant demands (not the Powai one)', () => {
    for (const d of tenants) expect(suggest(d, [inv452]).keys).toEqual([keyOf(inv452)]);
    expect(suggest(notTenant, [inv452]).keys).toEqual([]);
  });
  it('the unknown area basis on DEM-000131 is flagged', () => {
    expect(suggest(tenants[2] as DemandMx, [inv452]).plan.inserts[0]?.flags).toEqual(['area_basis_unknown']);
  });
  it('the lease closes: every other open match closes "Leased to another client"', () => {
    const closed = { ...inv452, commercialStatus: 'Closed' };
    expect(offerCloseCause(closed)).toBe('leased_to_another_client');
    for (const d of tenants.slice(1)) {
      const run = runDemand(d, [closed], [], ctx(DEFAULT_WEIGHTS, TODAY));
      expect(run.evaluations.get(keyOf(inv452))).toEqual({
        kind: 'fail',
        closeCause: 'leased_to_another_client',
      });
    }
  });
  it('the sale offer on the same property (tenant in place) matches the investor who stated Tenanted', () => {
    expect(suggest(investor, [inv453, inv452]).keys).toEqual([keyOf(inv453)]);
    expect(suggest(investor, [{ ...inv453, tenancyStatus: 'Vacant' }]).keys).toEqual([]);
  });
});

describe('AS-S2: newspaper 2BHK Andheri West at ₹75K → 2 rent demands', () => {
  const flat = offer({
    code: 'INV-00520',
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
    micromarket: 'Andheri West',
    locality: 'Lokhandwala',
    areaSqftMin: 750,
    areaSqftMax: 750,
    areaBasis: 'Carpet',
    rentMonthlyInrMin: 75_000,
  });
  const renter = (p: Partial<DemandMx>) =>
    demand({
      segment: 'Residential',
      propertyTypes: ['Apartment'],
      bhkMin: 2,
      bhkMax: 2,
      micromarkets: ['Andheri West'],
      localities: [],
      areaSqftMin: 650,
      areaSqftMax: 900,
      areaBasis: 'Carpet',
      rentMonthlyInrMin: 60_000,
      rentMonthlyInrMax: 80_000,
      ...p,
    });
  const relevant = [
    renter({ code: 'DEM-000201' }),
    renter({ code: 'DEM-000202', localities: ['Lokhandwala'], micromarkets: [], rentMonthlyInrMax: 90_000 }),
  ];
  const irrelevant = [
    renter({ code: 'DEM-000203', micromarkets: ['Powai'] }),
    renter({ code: 'DEM-000204', dealTypes: ['Sale'], budgetInrMax: 30_000_000 }),
    renter({ code: 'DEM-000205', bhkMin: 4, bhkMax: 4 }),
  ];
  it('matches exactly the two relevant rent demands', () => {
    for (const d of relevant) expect(suggest(d, [flat]).keys).toEqual([keyOf(flat)]);
    expect(suggest(relevant[0] as DemandMx, [flat]).plan.inserts[0]?.score).toBe(95); // same micromarket 0.85
    expect(suggest(irrelevant[0] as DemandMx, [flat]).keys).toEqual([]);
    expect(suggest(irrelevant[1] as DemandMx, [flat]).keys).toEqual([]);
    // bhk is scored, not filtered (LLD §4.2): a 4BHK seeker still sees the 2BHK, ranked lower (bhk value 0)
    const fourBhk = suggest(irrelevant[2] as DemandMx, [flat]).plan.inserts[0];
    expect(fourBhk?.score).toBe(83);
    expect(fourBhk?.factors.find((f) => f.factor === 'bhk')).toMatchObject({ applicable: true, value: 0 });
  });
});

describe('AS-S5: Upcoming INV-00701 (free from 1 Feb) → fintech excluded "Available too late", logistics firm matched', () => {
  const inv701 = offer({
    code: 'INV-00701',
    commercialStatus: 'Upcoming',
    possessionStatus: 'Available From',
    possessionDateRaw: '2027-02-01',
    areaSqftMin: 3500,
    areaSqftMax: 3500,
    rentMonthlyInrMin: 500_000,
    locality: 'Marol',
  });
  const fintech = demand({
    code: 'DEM-000301',
    areaSqftMin: 3000,
    areaSqftMax: 4000,
    rentMonthlyInrMax: 600_000,
    moveInBy: '2026-12-15',
  });
  const logistics = demand({
    code: 'DEM-000302',
    areaSqftMin: 3000,
    areaSqftMax: 4000,
    rentMonthlyInrMax: 600_000,
    moveInBy: '2027-03-01',
    moveInFrom: '2027-01-15',
  });
  it('the fintech gets an exclusion with the dates, no suggestion', () => {
    const r = suggest(fintech, [inv701]);
    expect(r.keys).toEqual([]);
    expect(r.run.exclusions).toEqual([
      {
        offerId: inv701.id,
        reason: 'available_too_late',
        availableFrom: '2027-02-01',
        moveInBy: '2026-12-15',
        detail: 'Available from 2027-02-01, demand needs by 2026-12-15',
      },
    ]);
  });
  it('the logistics firm is matched, timing scored on the 1 Feb date (within 30 days of its 1 Mar deadline → 0.7)', () => {
    const r = suggest(logistics, [inv701]);
    expect(r.keys).toEqual([keyOf(inv701)]);
    expect(r.plan.inserts[0]?.factors.find((f) => f.factor === 'timing')).toMatchObject({
      applicable: true,
      value: 0.7,
    });
  });
});

describe('AS-S6: PRJ-0031 new project; price rises on a new sheet → one match flagged "price above budget"', () => {
  const twoBhk = offer({
    code: 'INV-00801',
    projectId: 'prj-0031',
    dealType: 'Sale',
    market: 'Primary',
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
    salePriceInrMin: 24_000_000,
    rentMonthlyInrMin: null,
    unitCount: 38,
    areaSqftMin: 750,
    areaSqftMax: 750,
    areaBasis: 'Carpet',
    micromarket: 'Andheri East',
    locality: 'Chakala',
  });
  const resale = offer({
    code: 'INV-00655',
    dealType: 'Sale',
    market: 'Secondary',
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
    salePriceInrMin: 23_500_000,
    rentMonthlyInrMin: null,
    areaSqftMin: 720,
    areaSqftMax: 720,
    areaBasis: 'Carpet',
    micromarket: 'Andheri East',
    locality: 'Marol',
  });
  const buyer = (code: string, budget: number, market: string | null = 'Primary') =>
    demand({
      code,
      dealTypes: ['Sale'],
      market,
      segment: 'Residential',
      propertyTypes: ['Apartment'],
      bhkMin: 2,
      bhkMax: 2,
      budgetInrMax: budget,
      rentMonthlyInrMin: null,
      rentMonthlyInrMax: null,
      areaSqftMin: 700,
      areaSqftMax: 800,
      areaBasis: 'Carpet',
      micromarkets: ['Andheri East'],
      localities: [],
    });
  const buyers = [
    buyer('DEM-000401', 25_000_000),
    buyer('DEM-000402', 27_000_000),
    buyer('DEM-000403', 26_500_000),
    buyer('DEM-000404', 25_000_000, 'Any'),
  ];
  it('the 2 BHK holds 4 matches; one buyer (market Any) is also matched to resale INV-00655', () => {
    for (const d of buyers) expect(suggest(d, [twoBhk, resale]).keys).toContain(keyOf(twoBhk));
    expect(
      buyers.filter((d) => suggest(d, [twoBhk, resale]).keys.includes(keyOf(resale))).map((d) => d.code),
    ).toEqual(['DEM-000404']);
  });
  it("the new sheet (₹2.40 Cr → ₹2.60 Cr, 38 → 30 units) flags exactly the ₹2.5 Cr buyers' matches; the others stay clean", () => {
    const repriced = { ...twoBhk, salePriceInrMin: 26_000_000, unitCount: 30, factsVersion: 2 };
    const flagged = buyers.filter((d) => {
      const before = suggest(d, [twoBhk]).plan.inserts[0] as NonNullable<
        ReturnType<typeof suggest>['plan']['inserts'][0]
      >;
      const existing: MatchState = {
        id: `m-${d.code}`,
        demandId: d.id,
        offerIds: [twoBhk.id],
        offerSetKey: before.offerSetKey,
        isBundle: false,
        score: before.score,
        rank: 1,
        factors: before.factors,
        flags: before.flags,
        status: 'Suggested',
        closedReason: null,
        closedByDealId: null,
        priorStatus: null,
        rejectedScore: null,
        rejectedFactsVersion: null,
        weightsVersion: 0,
      };
      const run = runDemand(d, [repriced], [], ctx(DEFAULT_WEIGHTS, TODAY));
      const plan = planMerge(d, [existing], run.evaluations, T);
      return plan.events.some((e) => e.type === 'flagged' && e.flag === 'price_above_budget' && !e.cleared);
    });
    expect(flagged.map((d) => d.code)).toEqual(['DEM-000401', 'DEM-000404']);
  });
});

describe('ENG-07 precision check on the Appendix B scenario inventory', () => {
  // Every (demand, offer set) a broker would propose, labelled by hand from the scenarios above.
  const flat = offer({
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
    micromarket: 'Andheri West',
    locality: 'Versova',
    areaSqftMin: 700,
    areaSqftMax: 700,
    areaBasis: 'Carpet',
    rentMonthlyInrMin: 70_000,
  });
  const renter = demand({
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
    micromarkets: ['Andheri West'],
    localities: [],
    areaSqftMin: 650,
    areaSqftMax: 900,
    areaBasis: 'Carpet',
    rentMonthlyInrMin: 60_000,
    rentMonthlyInrMax: 80_000,
  });
  const warehouseNeed = demand({
    segment: 'Industrial',
    propertyTypes: ['Warehouse'],
    micromarkets: ['Bhiwandi'],
    localities: [],
    areaSqftMin: 4000,
    areaSqftMax: 4000,
    rentMonthlyInrMin: null,
    rentMonthlyInrMax: 200_000,
  });
  const shed = (a: number) =>
    offer({
      segment: 'Industrial',
      propertyTypes: ['Warehouse'],
      micromarket: 'Bhiwandi',
      locality: 'Vadape',
      areaSqftMin: a,
      areaSqftMax: a,
      rentMonthlyInrMin: 45 * a,
    });
  const sheds = {
    s4000: shed(4000),
    s3800: shed(3800),
    s2500: shed(2500),
    s2000a: shed(2000),
    s2100: shed(2100),
    s400: shed(400),
  };
  const inventory = [...inventory127, flat, ...Object.values(sheds)];
  const cases: { d: DemandMx; relevant: string[] }[] = [
    { d: dem127, relevant: [keyOf(inv452), keyOf(chakala6500), keyOf(marolFloor1, marolFloor2)] },
    { d: renter, relevant: [keyOf(flat)] },
    // the user's example: an industrial requirement of 4,000 sq ft
    {
      d: warehouseNeed,
      relevant: [keyOf(sheds.s4000), keyOf(sheds.s3800), keyOf(sheds.s2000a, sheds.s2100)],
    },
  ];

  it('precision = recall = 1.0 (no irrelevant suggestion, no missed pairing)', () => {
    let suggested = 0;
    let correct = 0;
    let relevant = 0;
    const misses: string[] = [];
    for (const c of cases) {
      const keys = suggest(c.d, inventory).keys;
      suggested += keys.length;
      relevant += c.relevant.length;
      for (const k of keys)
        if (c.relevant.includes(k)) correct++;
        else misses.push(`${c.d.code}: unexpected ${k}`);
      for (const k of c.relevant) if (!keys.includes(k)) misses.push(`${c.d.code}: missed ${k}`);
    }
    expect(misses).toEqual([]);
    expect(correct / suggested).toBe(1);
    expect(correct / relevant).toBe(1);
  });
});
