// Bundles (LLD §4.3, PRD §4.5, A-38, R-13, AS-D1).
import { describe, expect, it } from 'vitest';
import {
  bundleEligible,
  findBundles,
  groupingOf,
  manualBundleRuleError,
  scoreBundle,
} from '../../src/domain/bundles.js';
import type { BundleMember } from '../../src/domain/bundles.js';
import { scorePair } from '../../src/domain/scoring.js';
import { DEFAULT_WEIGHTS } from '../../src/domain/weights.js';
import type { DemandMx, OfferMx } from '../../src/domain/types.js';
import { ctx, demand, hierarchy, offer } from './fixtures.js';

const member = (o: OfferMx, d: DemandMx): BundleMember => ({ offer: o, pair: scorePair(o, d, ctx()) });
const floor = (area: number, rent: number, p: Partial<OfferMx> = {}) =>
  offer({ areaSqftMin: area, areaSqftMax: area, rentMonthlyInrMin: rent, buildingKey: 'bk-marol-1', ...p });

describe('bundle eligibility', () => {
  it('Commercial or Industrial demands with a minimum area that accept new suggestions', () => {
    expect(bundleEligible(demand())).toBe(true);
    expect(bundleEligible(demand({ segment: 'Industrial' }))).toBe(true);
    expect(bundleEligible(demand({ segment: 'Residential' }))).toBe(false);
    expect(bundleEligible(demand({ segment: 'Land' }))).toBe(false);
    expect(bundleEligible(demand({ areaSqftMin: null }))).toBe(false);
    expect(bundleEligible(demand({ lifeStage: 'Stale' }))).toBe(false);
  });
});

describe('AS-D1: a 2-offer bundle of adjacent Marol floors (3,200 + 3,000 sq ft) for DEM-000127', () => {
  const d = demand(); // 5,000–7,000 built up, ₹8–10 L, Marol
  const a = floor(3200, 420_000);
  const b = floor(3000, 400_000);
  it('is found as one same-building bundle with combined area and rent', () => {
    const found = findBundles(d, [member(a, d), member(b, d)], ctx());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      grouping: 'same_building',
      combinedAreaSqft: 6200,
      combinedRentMonthlyInr: 820_000,
      combinedPriceInr: null,
      offerIds: [a.id, b.id].sort(),
    });
    expect(found[0]?.score).toBe(100);
  });
  it('the floors alone are not single matches (each below the area tolerance)', () => {
    expect(scorePair(a, d, ctx()).areaOutOfRange).toBe(true);
    expect(scorePair(b, d, ctx()).areaOutOfRange).toBe(true);
  });
  it('an offer that meets the area alone is never a bundle member', () => {
    const big = floor(5200, 500_000);
    expect(findBundles(d, [member(big, d), member(b, d)], ctx())).toEqual([]);
  });
});

describe('co-location (R-13)', () => {
  const d = demand({ micromarkets: ['Andheri East', 'Powai', 'Bhiwandi'], localities: [] });
  it('same micromarket without a common building', () => {
    const x = floor(3000, 400_000, { buildingKey: 'bk-1', locality: 'Marol' });
    const y = floor(2500, 350_000, { buildingKey: 'bk-2', locality: 'Chakala' });
    expect(groupingOf([x, y], hierarchy)).toBe('same_micromarket');
    expect(findBundles(d, [member(x, d), member(y, d)], ctx())[0]?.grouping).toBe('same_micromarket');
  });
  it('adjacent micromarkets from the Admin-maintained list', () => {
    const x = floor(3000, 400_000, { buildingKey: null, micromarket: 'Andheri East', locality: null });
    const y = floor(2500, 350_000, { buildingKey: null, micromarket: 'Powai', locality: null });
    expect(groupingOf([x, y], hierarchy)).toBe('adjacent_micromarket');
    expect(findBundles(d, [member(x, d), member(y, d)], ctx())[0]?.grouping).toBe('adjacent_micromarket');
  });
  it('non-adjacent micromarkets are never bundled', () => {
    const x = floor(3000, 400_000, { buildingKey: null, micromarket: 'Andheri East', locality: null });
    const y = floor(2500, 350_000, { buildingKey: null, micromarket: 'Bhiwandi', locality: null });
    expect(groupingOf([x, y], hierarchy)).toBeNull();
    expect(findBundles(d, [member(x, d), member(y, d)], ctx())).toEqual([]);
  });
  it('three offers must be pairwise same-or-adjacent', () => {
    const w = floor(2000, 250_000, { buildingKey: null, micromarket: 'Andheri West', locality: null });
    const x = floor(2000, 250_000, { buildingKey: null, micromarket: 'Andheri East', locality: null });
    const y = floor(2000, 250_000, { buildingKey: null, micromarket: 'Powai', locality: null });
    expect(groupingOf([w, x, y], hierarchy)).toBeNull(); // Andheri West is not adjacent to Powai
    expect(groupingOf([x, y], hierarchy)).toBe('adjacent_micromarket');
  });
});

describe('bundle rules', () => {
  const d = demand();
  it('same deal type only (JB-6)', () => {
    const x = floor(3000, 400_000);
    const y = floor(3000, 400_000, { dealType: 'Sale', salePriceInrMin: 1e8 });
    expect(scoreBundle([member(x, d), member(y, d)], 'same_building', d, ctx())).toBeNull();
  });
  it('combined price within the budget max', () => {
    const x = floor(3000, 600_000);
    const y = floor(3000, 600_000);
    expect(findBundles(d, [member(x, d), member(y, d)], ctx())).toEqual([]);
  });
  it('combined area between the minimum and max × (1 + tolerance)', () => {
    const e = demand({ areaSqftMin: 5000, areaSqftMax: 5500 });
    const x = floor(3200, 300_000);
    const y = floor(3200, 300_000);
    expect(findBundles(e, [member(x, e), member(y, e)], ctx())).toEqual([]); // 6,400 > 5,500 × 1.15
    const z = floor(2000, 300_000);
    expect(findBundles(e, [member(x, e), member(z, e)], ctx())).toHaveLength(1); // 5,200
  });
  it('up to three offers per bundle; two when bundleMaxOffers = 2', () => {
    const offers = [floor(2000, 250_000), floor(2000, 250_000), floor(2000, 250_000)];
    const found = findBundles(
      d,
      offers.map((o) => member(o, d)),
      ctx(),
    );
    expect(found[0]?.offerIds).toHaveLength(3);
    const two = { ...DEFAULT_WEIGHTS, tuning: { ...DEFAULT_WEIGHTS.tuning, bundleMaxOffers: 2 } };
    expect(
      findBundles(
        d,
        offers.map((o) => member(o, d)),
        ctx(two),
      ),
    ).toEqual([]);
  });
  it('keeps the best bundlesPerDemand bundles that do not share offers', () => {
    const offers = [2600, 2600, 2600, 2600, 2600, 2600].map((a) => floor(a, 300_000));
    const found = findBundles(
      d,
      offers.map((o) => member(o, d)),
      ctx(),
    );
    expect(found).toHaveLength(3);
    const ids = found.flatMap((b) => b.offerIds);
    expect(new Set(ids).size).toBe(ids.length);
    const one = { ...DEFAULT_WEIGHTS, tuning: { ...DEFAULT_WEIGHTS.tuning, bundlesPerDemand: 1 } };
    expect(
      findBundles(
        d,
        offers.map((o) => member(o, d)),
        ctx(one),
      ),
    ).toHaveLength(1);
  });
  it('caps candidates per group at bundleCandidateCap (largest first)', () => {
    const offers = Array.from({ length: 40 }, (_, i) => floor(2500 + i, 100_000));
    const cap = { ...DEFAULT_WEIGHTS, tuning: { ...DEFAULT_WEIGHTS.tuning, bundleCandidateCap: 5 } };
    const found = findBundles(
      d,
      offers.map((o) => member(o, d)),
      ctx(cap),
    );
    const largest = new Set(offers.slice(-5).map((o) => o.id));
    expect(found.flatMap((b) => b.offerIds).every((id) => largest.has(id))).toBe(true);
  });
  it('not for Residential demands', () => {
    const r = demand({ segment: 'Residential', propertyTypes: ['Apartment'] });
    const offers = [
      floor(3000, 300_000, { segment: 'Residential', propertyTypes: ['Apartment'] }),
      floor(3000, 300_000, { segment: 'Residential', propertyTypes: ['Apartment'] }),
    ];
    expect(
      findBundles(
        r,
        offers.map((o) => member(o, r)),
        ctx(),
      ),
    ).toEqual([]);
  });
  it('flags of members carry over (reconfirm on a Stale floor; area basis unknown)', () => {
    const x = floor(3000, 400_000, { lifeStage: 'Stale' });
    const y = floor(3000, 400_000, { areaBasis: null });
    const b = findBundles(d, [member(x, d), member(y, d)], ctx())[0];
    expect(b?.flags).toEqual(['reconfirm', 'area_basis_unknown']);
  });
});

describe('manual bundle validation (POST /v1/bundles, LLD §6)', () => {
  const d = demand();
  const x = floor(3000, 400_000);
  const y = floor(3000, 400_000);
  it('accepts a valid bundle', () => expect(manualBundleRuleError(d, [x, y], ctx())).toBeNull());
  it('bundle-too-large for fewer than 2 or more than 3 offers', () => {
    expect(manualBundleRuleError(d, [x], ctx())).toBe('bundle-too-large');
    expect(manualBundleRuleError(d, [x, y, floor(1, 1), floor(1, 1)], ctx())).toBe('bundle-too-large');
  });
  it('bundle-segment-not-allowed for Residential demands', () =>
    expect(manualBundleRuleError(demand({ segment: 'Residential' }), [x, y], ctx())).toBe(
      'bundle-segment-not-allowed',
    ));
  it('bundle-mixed-deal-type', () =>
    expect(manualBundleRuleError(d, [x, floor(3000, 1, { dealType: 'Sale' })], ctx())).toBe(
      'bundle-mixed-deal-type',
    ));
  it('bundle-not-colocated', () =>
    expect(
      manualBundleRuleError(
        d,
        [x, floor(3000, 1, { buildingKey: null, micromarket: 'Bhiwandi', locality: null })],
        ctx(),
      ),
    ).toBe('bundle-not-colocated'));
  it('bundle-area-insufficient', () =>
    expect(manualBundleRuleError(d, [floor(2000, 1), floor(2000, 1)], ctx())).toBe(
      'bundle-area-insufficient',
    ));
});
