// Hard filters (LLD §4.1, PRD §4.5, BRD §7): order, outcomes and reasons.
import { describe, expect, it } from 'vitest';
import { bhkGap, evaluateHardFilters, normaliseTagKey } from '../../src/domain/filters.js';
import { demand, offer } from './fixtures.js';

const kind = (o: ReturnType<typeof offer>, d: ReturnType<typeof demand>, requireAcceptsNew = false) =>
  evaluateHardFilters(o, d, { requireAcceptsNew });

describe('hard filters', () => {
  it('passes a same-cell pair and lists every check', () => {
    const r = kind(offer(), demand());
    expect(r.kind).toBe('pass');
    expect(r.checks.map((c) => c.filter)).toEqual([
      'side',
      'record_scope',
      'launch_area',
      'deal_type',
      'market',
      'segment',
      'property_type',
      'stated_tags',
      'micromarket',
      'possession_window',
      'offer_live',
      'demand_live',
    ]);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it('2: outside the launch area on either side is never a candidate (CR-006 Z-7)', () => {
    expect(kind(offer({ outsideLaunchArea: true }), demand())).toMatchObject({
      kind: 'skip',
      failed: 'launch_area',
    });
    expect(kind(offer(), demand({ outsideLaunchArea: true }))).toMatchObject({
      kind: 'skip',
      failed: 'launch_area',
    });
  });

  it('3: Closed / voided / merged offers are skipped; Expired → exclusion offer_expired; Inactive → offer_inactive', () => {
    expect(kind(offer({ commercialStatus: 'Closed' }), demand())).toMatchObject({
      kind: 'skip',
      failed: 'offer_live',
    });
    expect(kind(offer({ voided: true }), demand())).toMatchObject({ kind: 'skip', failed: 'offer_live' });
    expect(kind(offer({ mergedInto: 'x' }), demand())).toMatchObject({ kind: 'skip', failed: 'offer_live' });
    expect(kind(offer({ lifeStage: 'Expired' }), demand())).toMatchObject({
      kind: 'exclude',
      reason: 'offer_expired',
    });
    expect(kind(offer({ commercialStatus: 'Inactive' }), demand())).toMatchObject({
      kind: 'exclude',
      reason: 'offer_inactive',
    });
  });

  it('3: an Expired offer is excluded only if it passes filters 4–9 (otherwise skipped)', () => {
    expect(kind(offer({ lifeStage: 'Expired', dealType: 'Sale' }), demand())).toMatchObject({
      kind: 'skip',
      failed: 'deal_type',
    });
  });

  it('3: a Stale offer is still matchable (reconfirm flag comes from scoring); Upcoming offers match', () => {
    expect(kind(offer({ lifeStage: 'Stale' }), demand()).kind).toBe('pass');
    expect(kind(offer({ commercialStatus: 'Upcoming' }), demand()).kind).toBe('pass');
  });

  it('3: exited, Closed, Expired or Paused demands are skipped; Stale demands get no new suggestions', () => {
    expect(kind(offer(), demand({ exitType: 'Lost' }))).toMatchObject({
      kind: 'skip',
      failed: 'demand_live',
    });
    expect(kind(offer(), demand({ commercialStatus: 'Closed' }))).toMatchObject({
      kind: 'skip',
      failed: 'demand_live',
    });
    expect(kind(offer(), demand({ lifeStage: 'Expired' }))).toMatchObject({
      kind: 'skip',
      failed: 'demand_live',
    });
    expect(kind(offer(), demand({ lifeStage: 'Paused' }))).toMatchObject({
      kind: 'skip',
      failed: 'demand_live',
    });
    expect(kind(offer(), demand({ lifeStage: 'Stale' })).kind).toBe('pass');
    expect(kind(offer(), demand({ lifeStage: 'Stale' }), true)).toMatchObject({
      kind: 'exclude',
      reason: 'demand_stale',
    });
  });

  it('4: offer deal type must be one of the demand deal types', () => {
    expect(kind(offer({ dealType: 'Sale' }), demand())).toMatchObject({ kind: 'skip', failed: 'deal_type' });
    expect(kind(offer({ dealType: 'Lease' }), demand({ dealTypes: ['Sale', 'Lease'] })).kind).toBe('pass');
  });

  describe('5: market (Sale only)', () => {
    const sale = (market: string | null) =>
      offer({ dealType: 'Sale', market, salePriceInrMin: 1e8, rentMonthlyInrMin: null });
    const buyer = (market: string | null) => demand({ dealTypes: ['Sale'], market, budgetInrMax: 1.2e8 });
    it('demand Any matches Primary and Secondary', () => {
      expect(kind(sale('Primary'), buyer('Any')).kind).toBe('pass');
      expect(kind(sale('Secondary'), buyer('Any')).kind).toBe('pass');
    });
    it('demand blank is treated as Any (JB-1)', () => {
      expect(kind(sale('Primary'), buyer(null)).kind).toBe('pass');
    });
    it('Primary/Secondary demands need the same market', () => {
      expect(kind(sale('Primary'), buyer('Primary')).kind).toBe('pass');
      expect(kind(sale('Secondary'), buyer('Primary'))).toMatchObject({ kind: 'skip', failed: 'market' });
    });
    it('offer market blank → compatible + flag market_unknown (CR-006)', () => {
      const r = kind(sale(null), buyer('Secondary'));
      expect(r).toMatchObject({ kind: 'pass', flags: ['market_unknown'] });
    });
    it('Lease ignores market', () => {
      expect(kind(offer({ market: 'Primary' }), demand({ market: 'Secondary' })).kind).toBe('pass');
    });
  });

  it('6: same segment and overlapping property types', () => {
    expect(kind(offer({ segment: 'Industrial' }), demand())).toMatchObject({
      kind: 'skip',
      failed: 'segment',
    });
    expect(kind(offer({ segment: null }), demand())).toMatchObject({ kind: 'skip', failed: 'segment' });
    expect(kind(offer({ propertyTypes: ['Shop'] }), demand())).toMatchObject({
      kind: 'skip',
      failed: 'property_type',
    });
    expect(kind(offer({ propertyTypes: ['Shop', 'Office'] }), demand()).kind).toBe('pass');
    expect(kind(offer({ propertyTypes: [] }), demand()).kind).toBe('pass');
    expect(kind(offer(), demand({ propertyTypes: [] })).kind).toBe('pass');
  });

  describe('6: residential BHK within ±1 of the demand (CR-011 item 3)', () => {
    const flat = (bhkMin: number | null, bhkMax: number | null = bhkMin) =>
      offer({ segment: 'Residential', propertyTypes: ['Apartment'], bhkMin, bhkMax });
    const need = (bhkMin: number | null, bhkMax: number | null = bhkMin) =>
      demand({ segment: 'Residential', propertyTypes: ['Apartment'], bhkMin, bhkMax });
    it('4BHK need: 3, 4 and 5 BHK pass; 2 and 6 BHK are skipped (never a candidate, no exclusion row)', () => {
      for (const b of [3, 4, 5]) expect(kind(flat(b), need(4)).kind).toBe('pass');
      for (const b of [2, 6]) {
        const r = kind(flat(b), need(4));
        expect(r).toMatchObject({ kind: 'skip', failed: 'property_type' });
        expect(r.checks.at(-1)?.detail).toBe(`${b} BHK vs 4 BHK (±1 allowed)`);
      }
    });
    it('a demand for a BHK range (2–3, i.e. "2 or 3 BHK") allows 1 to 4 BHK', () => {
      for (const b of [1, 2, 3, 4]) expect(kind(flat(b), need(2, 3)).kind).toBe('pass');
      expect(kind(flat(5), need(2, 3))).toMatchObject({ kind: 'skip', failed: 'property_type' });
      expect(kind(flat(4), need(2, 3)).checks.find((c) => c.filter === 'property_type')?.passed).toBe(true);
    });
    it('an offer with a BHK range (project configurations 5–6) passes when any part is within ±1', () => {
      expect(kind(flat(5, 6), need(4)).kind).toBe('pass');
      expect(kind(flat(6, 7), need(4))).toMatchObject({ kind: 'skip', failed: 'property_type' });
    });
    it('half BHKs and 1 RK (0.5): 1 RK suits a 1 BHK need, not a 2 BHK need; 3.5 BHK suits a 4 BHK need', () => {
      expect(kind(flat(0.5), need(1)).kind).toBe('pass');
      expect(kind(flat(0.5), need(2))).toMatchObject({ kind: 'skip', failed: 'property_type' });
      expect(kind(flat(3.5), need(4)).kind).toBe('pass');
      expect(kind(flat(2.5), need(4))).toMatchObject({ kind: 'skip', failed: 'property_type' });
    });
    it('a range with one end blank is that single value', () => {
      expect(kind(flat(null, 2), need(4))).toMatchObject({ kind: 'skip', failed: 'property_type' });
      expect(kind(flat(3), need(4, null)).kind).toBe('pass');
    });
    it('unknown BHK on either side is never filtered (the bhk factor is then not applicable)', () => {
      expect(kind(flat(null), need(4)).kind).toBe('pass');
      expect(kind(flat(2), need(null)).kind).toBe('pass');
      expect(bhkGap({ bhkMin: null, bhkMax: null }, { bhkMin: 4, bhkMax: 4 })).toBeNull();
    });
    it('non-residential segments ignore BHK', () => {
      expect(kind(offer({ bhkMin: 2, bhkMax: 2 }), demand({ bhkMin: 4, bhkMax: 4 })).kind).toBe('pass');
    });
    it('bhkGap: 0 on overlap, else the distance between the ranges', () => {
      expect(bhkGap({ bhkMin: 3, bhkMax: 5 }, { bhkMin: 4, bhkMax: 4 })).toBe(0);
      expect(bhkGap({ bhkMin: 2, bhkMax: 2 }, { bhkMin: 4, bhkMax: 5 })).toBe(2);
      expect(bhkGap({ bhkMin: 6, bhkMax: 6 }, { bhkMin: 4, bhkMax: 5 })).toBe(1);
    });
  });

  it('7: deal tags the client stated must match; a blank offer value is compatible', () => {
    const preleasedBuyer = demand({
      dealTypes: ['Sale'],
      statedTags: { tenancy_status: 'Tenanted' },
      budgetInrMax: 2e8,
    });
    const sale = (tenancyStatus: string | null) =>
      offer({ dealType: 'Sale', tenancyStatus, salePriceInrMin: 1.1e8, rentMonthlyInrMin: null });
    expect(kind(sale('Tenanted'), preleasedBuyer).kind).toBe('pass');
    expect(kind(sale('Vacant'), preleasedBuyer)).toMatchObject({ kind: 'skip', failed: 'stated_tags' });
    expect(kind(sale(null), preleasedBuyer).kind).toBe('pass');
    // camelCase keys and case-folding (R-11)
    const auction = demand({ dealTypes: ['Sale'], statedTags: { saleMode: 'auction' } });
    expect(kind(offer({ dealType: 'Sale', saleMode: 'Auction' }), auction).kind).toBe('pass');
    expect(kind(offer({ dealType: 'Sale', saleMode: 'Private' }), auction)).toMatchObject({
      failed: 'stated_tags',
    });
    const jodi = demand({ statedTags: { is_jodi: 'Yes' } });
    expect(kind(offer({ isJodi: true }), jodi).kind).toBe('pass');
    expect(kind(offer({ isJodi: false }), jodi)).toMatchObject({ failed: 'stated_tags' });
    // tags that are not deal tags (furnishing) are scored, not filtered
    expect(
      kind(offer({ furnishing: 'Bare Shell' }), demand({ statedTags: { furnishing: 'Furnished' } })).kind,
    ).toBe('pass');
  });

  it('8: micromarket overlap uses the hierarchy (Chakala is inside Andheri East)', () => {
    const d = demand({ micromarkets: ['Andheri East'], localities: [] });
    expect(kind(offer({ locality: 'Chakala' }), d).kind).toBe('pass');
    expect(kind(offer({ micromarket: 'Powai', locality: null }), d)).toMatchObject({
      kind: 'skip',
      failed: 'micromarket',
    });
    // unknown place strings resolve to no node → cannot pass
    expect(kind(offer({ micromarket: 'Atlantis', locality: 'Nowhere' }), d)).toMatchObject({
      failed: 'micromarket',
    });
  });

  describe('9: possession window (date aware, AS-S5)', () => {
    const d = demand({ moveInBy: '2026-12-15' });
    it('available after move_in_by → exclusion available_too_late with dates', () => {
      const r = kind(offer({ possessionStatus: 'Available From', possessionDateRaw: '2027-02-01' }), d);
      expect(r).toMatchObject({ kind: 'exclude', reason: 'available_too_late', availableFrom: '2027-02-01' });
      expect(r.checks.at(-1)?.detail).toBe('Available from 2027-02-01, demand needs by 2026-12-15');
    });
    it('month precision compares the period start, so it never excludes wrongly', () => {
      expect(kind(offer({ possessionStatus: 'Available From', possessionDateRaw: '2026-12' }), d).kind).toBe(
        'pass',
      );
      expect(
        kind(offer({ possessionStatus: 'Available From', possessionDateRaw: '2027-01' }), d),
      ).toMatchObject({ kind: 'exclude' });
      expect(kind(offer({ possessionStatus: 'Under Construction', possessionDateRaw: '2026' }), d).kind).toBe(
        'pass',
      );
    });
    it('Ready or blank dates and demands without move_in_by pass; moveInFrom never excludes (JB-7)', () => {
      expect(kind(offer({ possessionStatus: 'Ready', possessionDateRaw: '2030-01' }), d).kind).toBe('pass');
      expect(kind(offer({ possessionDateRaw: null }), d).kind).toBe('pass');
      expect(
        kind(
          offer({ possessionStatus: 'Available From', possessionDateRaw: '2027-06' }),
          demand({ moveInFrom: '2026-11-01' }),
        ).kind,
      ).toBe('pass');
    });
  });

  it('filters run in order: the first failure decides', () => {
    const r = kind(
      offer({ dealType: 'Sale', segment: 'Industrial', micromarket: 'Powai', locality: null }),
      demand(),
    );
    expect(r).toMatchObject({ kind: 'skip', failed: 'deal_type' });
  });

  it('normalises statedTags keys', () => {
    expect(normaliseTagKey('tenancyStatus')).toBe('tenancy_status');
    expect(normaliseTagKey(' Sale Mode ')).toBe('sale_mode');
    expect(normaliseTagKey('is_jodi')).toBe('is_jodi');
  });
});
