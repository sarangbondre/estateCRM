// Scoring (LLD §4.2) and flags (§4.4), table-driven from the PRD/BRD examples (DEM-000127: Commercial Lease, office
// 5,000–7,000 sq ft built up, Andheri East / Marol, ₹8–10 L/month).
import { describe, expect, it } from 'vitest';
import {
  areaValue,
  bhkFactor,
  combine,
  formatInr,
  furnishingFactor,
  mustHaves,
  priceValue,
  scorePair,
  timingFactor,
} from '../../src/domain/scoring.js';
import { evaluateSingle } from '../../src/domain/engine.js';
import { DEFAULT_WEIGHTS } from '../../src/domain/weights.js';
import type { FactorName } from '../../src/domain/types.js';
import { ctx, demand, offer } from './fixtures.js';

const factor = (r: ReturnType<typeof scorePair>, f: FactorName) => r.factors.find((x) => x.factor === f);

describe('score = round(100 × Σ w·v / Σ w) over applicable factors', () => {
  it('a perfect pair scores 100 (micromarket, price, area applicable; bhk/timing/furnishing not)', () => {
    const r = scorePair(offer({ rentMonthlyInrMin: 900_000 }), demand(), ctx());
    expect(r.score).toBe(100);
    expect(r.factors.filter((f) => f.applicable).map((f) => f.factor)).toEqual([
      'micromarket',
      'price',
      'area',
    ]);
    expect(r.factors.reduce((s, f) => s + f.points, 0)).toBeCloseTo(100, 1);
    expect(r.flags).toEqual([]);
    expect(factor(r, 'price')?.note).toBe('rent ₹9L vs budget ₹8L–₹10L');
  });

  it('INV-00452 (5,000 sq ft office, ₹8.5 L) is a top match for DEM-000127', () => {
    const r = scorePair(
      offer({ areaSqftMin: 5000, areaSqftMax: 5000, rentMonthlyInrMin: 850_000, furnishing: 'Furnished' }),
      demand(),
      ctx(),
    );
    expect(r.score).toBe(100);
  });

  it('micromarket proximity: same locality 1.0, same micromarket 0.85, coarser 0.6', () => {
    const d = demand({ micromarkets: ['Andheri East'], localities: ['Marol'] });
    expect(factor(scorePair(offer({ locality: 'Marol' }), d, ctx()), 'micromarket')?.value).toBe(1);
    expect(factor(scorePair(offer({ locality: 'Chakala' }), d, ctx()), 'micromarket')?.value).toBe(0.85);
    const locOnly = demand({ micromarkets: [], localities: ['Marol'] });
    expect(factor(scorePair(offer({ locality: null }), locOnly, ctx()), 'micromarket')?.value).toBe(0.6);
  });

  describe('price vs budget (JB-3: scored, never a hard filter)', () => {
    it('within budget 1.0; falls linearly to 0 at 20% over; unknown price 0.5', () => {
      expect(priceValue(900_000, 1_000_000, 20)).toBe(1);
      expect(priceValue(1_000_000, 1_000_000, 20)).toBe(1);
      expect(priceValue(1_100_000, 1_000_000, 20)).toBeCloseTo(0.5);
      expect(priceValue(1_200_000, 1_000_000, 20)).toBe(0);
      expect(priceValue(5_000_000, 1_000_000, 20)).toBe(0);
      expect(priceValue(null, 1_000_000, 20)).toBe(0.5);
    });
    it('over budget flags price_above_budget and lowers the score', () => {
      const r = scorePair(offer({ rentMonthlyInrMin: 1_100_000 }), demand(), ctx());
      expect(r.flags).toContain('price_above_budget');
      expect(r.score).toBe(82); // (0.25·1 + 0.25·0.5 + 0.2·1) / 0.7
    });
    it('Sale uses sale price min (else max) against budget_inr_max; Lease uses rent', () => {
      const buyer = demand({
        dealTypes: ['Sale'],
        budgetInrMax: 25_000_000,
        rentMonthlyInrMax: null,
        rentMonthlyInrMin: null,
      });
      const r = scorePair(
        offer({
          dealType: 'Sale',
          salePriceInrMin: null,
          salePriceInrMax: 24_000_000,
          rentMonthlyInrMin: null,
        }),
        buyer,
        ctx(),
      );
      expect(factor(r, 'price')).toMatchObject({ applicable: true, value: 1 });
      expect(factor(r, 'price')?.note).toBe('price ₹2.4Cr vs budget ₹2.5Cr');
    });
    it('not applicable for JV or without a budget', () => {
      const jv = demand({ dealTypes: ['JV'], budgetInrMax: 1e8 });
      expect(
        factor(scorePair(offer({ dealType: 'JV', salePriceInrMin: 1e9 }), jv, ctx()), 'price')?.applicable,
      ).toBe(false);
      const noBudget = demand({ rentMonthlyInrMax: null, rentMonthlyInrMin: null });
      expect(factor(scorePair(offer(), noBudget, ctx()), 'price')?.applicable).toBe(false);
    });
    it('offer without a price scores 0.5', () => {
      expect(factor(scorePair(offer({ rentMonthlyInrMin: null }), demand(), ctx()), 'price')?.value).toBe(
        0.5,
      );
    });
  });

  describe('area like with like (R-14, JB-2)', () => {
    it('overlapping ranges → 1.0; else 1 − gap / (tol × nearest demand bound)', () => {
      expect(areaValue({ min: 6000, max: 6000 }, 5000, 7000, 15)).toBe(1);
      expect(areaValue({ min: 4000, max: 5200 }, 5000, 7000, 15)).toBe(1);
      expect(areaValue({ min: 4500, max: 4500 }, 5000, 7000, 15)).toBeCloseTo(1 - 500 / 750);
      expect(areaValue({ min: 7700, max: 7700 }, 5000, 7000, 15)).toBeCloseTo(1 - 700 / 1050);
      expect(areaValue({ min: 4000, max: 4000 }, 5000, 7000, 15)).toBe(0);
      expect(areaValue({ min: 9000, max: 9000 }, 5000, null, 15)).toBe(1); // no max: open ended
      expect(areaValue({ min: 900, max: 900 }, null, 1000, 15)).toBe(1); // no min
    });
    it('blank basis widens tolerance to ±25% and flags area_basis_unknown', () => {
      const r = scorePair(offer({ areaSqftMin: 4000, areaSqftMax: 4000, areaBasis: null }), demand(), ctx());
      expect(factor(r, 'area')?.value).toBeCloseTo(0.2);
      expect(r.flags).toContain('area_basis_unknown');
      expect(r.areaOutOfRange).toBe(false);
    });
    it('known but different bases use ±25% without the flag (JB-2); no conversion', () => {
      const r = scorePair(
        offer({ areaSqftMin: 4000, areaSqftMax: 4000, areaBasis: 'Carpet' }),
        demand(),
        ctx(),
      );
      expect(factor(r, 'area')?.value).toBeCloseTo(0.2);
      expect(r.flags).not.toContain('area_basis_unknown');
    });
    it('beyond tolerance → value 0 and not suggestible as a single match', () => {
      const r = scorePair(offer({ areaSqftMin: 3200, areaSqftMax: 3200 }), demand(), ctx());
      expect(factor(r, 'area')?.value).toBe(0);
      expect(r.areaOutOfRange).toBe(true);
    });
    it('Land compares land_area_sqft', () => {
      const land = demand({
        segment: 'Land',
        propertyTypes: [],
        dealTypes: ['Sale'],
        areaSqftMin: 40_000,
        areaSqftMax: 60_000,
        areaBasis: null,
      });
      const r = scorePair(
        offer({
          segment: 'Land',
          propertyTypes: [],
          dealType: 'Sale',
          landAreaSqft: 43_560,
          areaSqftMin: 100,
          areaSqftMax: 100,
          areaBasis: null,
        }),
        land,
        ctx(),
      );
      expect(factor(r, 'area')?.value).toBe(1);
      expect(r.flags).not.toContain('area_basis_unknown');
    });
    it('not applicable when either side has no area', () => {
      expect(
        factor(scorePair(offer({ areaSqftMin: null, areaSqftMax: null }), demand(), ctx()), 'area')
          ?.applicable,
      ).toBe(false);
      expect(
        factor(scorePair(offer(), demand({ areaSqftMin: null, areaSqftMax: null }), ctx()), 'area')
          ?.applicable,
      ).toBe(false);
    });
  });

  it('bhk (Residential only) within the ±1 band (CR-011): exact 1.0, off by 0.5 → 0.6, by 1 → 0.3 (more is filtered; 0 kept for safety)', () => {
    const d = demand({ segment: 'Residential', bhkMin: 2, bhkMax: 2 });
    const v = (bhk: number) =>
      bhkFactor(offer({ segment: 'Residential', bhkMin: bhk, bhkMax: bhk }), d).value;
    expect(v(2)).toBe(1);
    expect(v(2.5)).toBe(0.6);
    expect(v(1.5)).toBe(0.6);
    expect(v(3)).toBe(0.3);
    expect(v(4)).toBe(0);
    expect(bhkFactor(offer({ bhkMin: 2, bhkMax: 2 }), demand({ bhkMin: 2 })).applicable).toBe(false); // Commercial
    expect(bhkFactor(offer({ segment: 'Residential' }), d).applicable).toBe(false); // offer bhk unknown
    expect(
      bhkFactor(offer({ segment: 'Residential', bhkMin: 2, bhkMax: 2 }), demand({ segment: 'Residential' }))
        .applicable,
    ).toBe(false); // demand bhk unknown
    // a "2 or 3 BHK" demand: both are exact
    const range = demand({ segment: 'Residential', bhkMin: 2, bhkMax: 3 });
    expect(bhkFactor(offer({ segment: 'Residential', bhkMin: 3, bhkMax: 3 }), range)).toMatchObject({
      value: 1,
      note: '3 BHK vs 2–3 BHK',
    });
    expect(bhkFactor(offer({ segment: 'Residential', bhkMin: 4, bhkMax: 4 }), range).value).toBe(0.3);
  });

  describe('timing (demand has move_in_by)', () => {
    const c = ctx(DEFAULT_WEIGHTS, '2026-10-01');
    const d = demand({ moveInBy: '2026-12-01' });
    const v = (possessionStatus: string | null, possessionDateRaw: string | null, dd = d) =>
      timingFactor({ possessionStatus, possessionDateRaw }, dd, c).value;
    it('available by move_in_by − 30 days → 1.0; by move_in_by → 0.7; straddling month → 0.4', () => {
      expect(v('Ready', null)).toBe(1);
      expect(v('Available From', '2026-10-20')).toBe(1);
      expect(v('Available From', '2026-11')).toBe(0.7);
      expect(v('Available From', '2026-12')).toBe(0.4);
    });
    it('available much earlier than move_in_from − 90 days → × 0.8', () => {
      expect(v('Ready', null, demand({ moveInBy: '2027-06-01', moveInFrom: '2027-03-01' }))).toBe(0.8);
      expect(v('Ready', null, demand({ moveInBy: '2027-06-01', moveInFrom: '2026-12-01' }))).toBe(1);
    });
    it('not applicable without move_in_by', () => {
      expect(
        timingFactor({ possessionStatus: 'Ready', possessionDateRaw: null }, demand(), c).applicable,
      ).toBe(false);
    });
  });

  describe('furnishing and must-haves', () => {
    const f = (
      furnishing: string | null,
      tags: Record<string, string>,
      p: { parking?: number | null; amenities?: string[] } = {},
    ) =>
      furnishingFactor(
        { furnishing, parking: p.parking ?? null, amenities: p.amenities ?? [] },
        demand({ statedTags: tags }),
      );
    it('equal 1.0, adjacent level 0.5, otherwise 0.2, blank 0.5', () => {
      expect(f('Furnished', { furnishing: 'Furnished' }).value).toBe(1);
      expect(f('Semi Furnished', { furnishing: 'Furnished' }).value).toBe(0.5);
      expect(f('Bare Shell', { furnishing: 'Furnished' }).value).toBe(0.2);
      expect(f(null, { furnishing: 'Furnished' }).value).toBe(0.5);
    });
    it('must-haves: present 1, absent 0, unknown 0.5; mean with furnishing', () => {
      expect(f('Furnished', { furnishing: 'Furnished', parking: '2' }, { parking: 1 }).value).toBe(0.5);
      expect(f(null, { parking: '2' }, { parking: 3 }).value).toBe(1);
      expect(f(null, { parking: '2' }).value).toBe(0.5);
      expect(f(null, { 'amenity:Gym': 'yes' }, { amenities: ['Gym', 'Pool'] }).value).toBe(1);
      expect(f(null, { 'amenity:Gym': 'yes' }, { amenities: ['Pool'] }).value).toBe(0);
      expect(f(null, { 'amenity:Gym': 'yes' }).value).toBe(0.5);
    });
    it('not applicable when the client stated nothing', () => {
      expect(f('Furnished', {}).applicable).toBe(false);
      expect(mustHaves({ 'amenity:Gym': 'no', parking: 'many' })).toEqual({ parking: null, amenities: [] });
    });
  });

  it('weights are normalised by the applicable factors; custom weights change the score', () => {
    const values = {
      micromarket: { applicable: true, value: 1 },
      price: { applicable: true, value: 0 },
      area: { applicable: false, value: 0 },
      bhk: { applicable: false, value: 0 },
      timing: { applicable: false, value: 0 },
      furnishing: { applicable: false, value: 0 },
    };
    expect(combine(values, DEFAULT_WEIGHTS).score).toBe(50);
    const priceHeavy = { ...DEFAULT_WEIGHTS, factors: { ...DEFAULT_WEIGHTS.factors, price: 0.75 } };
    expect(combine(values, priceHeavy).score).toBe(25);
    const zeroApplicable = {
      ...DEFAULT_WEIGHTS,
      factors: { ...DEFAULT_WEIGHTS.factors, micromarket: 0, price: 0 },
    };
    expect(combine(values, zeroApplicable).score).toBe(50); // falls back to the plain mean
  });

  it('a Stale offer carries the reconfirm flag (BRD §7)', () => {
    expect(scorePair(offer({ lifeStage: 'Stale' }), demand(), ctx()).flags).toEqual(['reconfirm']);
  });

  it('formats INR in lakhs and crores for notes', () => {
    expect(formatInr(850_000)).toBe('₹8.5L');
    expect(formatInr(110_000_000)).toBe('₹11Cr');
    expect(formatInr(75_000)).toBe('₹75,000');
  });
});

describe("the user's example: an industrial requirement of 4,000 sq ft", () => {
  const need = demand({
    segment: 'Industrial',
    propertyTypes: ['Warehouse'],
    dealTypes: ['Lease'],
    micromarkets: ['Bhiwandi'],
    localities: [],
    areaSqftMin: 4000,
    areaSqftMax: 4000,
    areaBasis: 'Builtup',
    rentMonthlyInrMin: null,
    rentMonthlyInrMax: 200_000,
  });
  const shed = (area: number, rent = 180_000) =>
    offer({
      segment: 'Industrial',
      propertyTypes: ['Warehouse'],
      micromarket: 'Bhiwandi',
      locality: 'Vadape',
      areaSqftMin: area,
      areaSqftMax: area,
      rentMonthlyInrMin: rent,
    });
  it('4,000–4,200 sq ft sheds score high', () => {
    // micromarket 0.85 (Vadape lies in the listed Bhiwandi micromarket), price 1, area 1 → 95
    expect(scorePair(shed(4000), need, ctx()).score).toBe(95);
    expect(scorePair(shed(4200), need, ctx()).score).toBe(85); // 200 sq ft over: area 1 − 200/600
  });
  it('CR-011 item 1: a single match needs the offer area within tolerance — 3,600 sq ft is inside the ±15% band and suggestible; 2,500 and 400 sq ft are not single matches (bundles only)', () => {
    expect(scorePair(shed(3600), need, ctx()).areaOutOfRange).toBe(false);
    expect(scorePair(shed(2500), need, ctx()).areaOutOfRange).toBe(true);
    expect(scorePair(shed(400), need, ctx()).areaOutOfRange).toBe(true);
    // the engine never suggests it alone, even though it passes every hard filter
    const single = evaluateSingle(shed(400), need, ctx());
    expect(single.filter.kind).toBe('pass');
    expect(single.eval).toMatchObject({ kind: 'pass', suggestible: false });
    expect(evaluateSingle(shed(3600), need, ctx()).eval).toMatchObject({ kind: 'pass', suggestible: true });
  });
});
