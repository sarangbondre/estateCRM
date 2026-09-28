// Domain unit tests: rollup tuples, IST periods, possession dates, stable ids, event → column mapping.
import { describe, expect, it } from 'vitest';
import { istDay, periodStart, resolvePeriod } from '../../src/domain/dates.js';
import { stableUuid } from '../../src/domain/ids.js';
import { blankDemand, blankOffer } from '../../src/domain/readmodel/defaults.js';
import { demandFacts, offerFacts } from '../../src/domain/readmodel/mapping.js';
import { demandDims, offerDims, rollupMoves } from '../../src/domain/readmodel/rollupKeys.js';
import { demandCreated, offerCreated } from '../fixtures.js';

describe('rollup tuples', () => {
  it('does not count stubs, voided or merged offers', () => {
    const o = { ...blankOffer('a'), code: 'INV-1', deal_type: 'Lease' };
    expect(offerDims(blankOffer('a'))).toBeNull();
    expect(offerDims(o)).not.toBeNull();
    expect(offerDims({ ...o, void_reason: 'side_changed' })).toBeNull();
    expect(offerDims({ ...o, merged_into_id: 'b' })).toBeNull();
  });

  it('moves −1/+1 only when the tuple changes', () => {
    const o = { ...blankOffer('a'), code: 'INV-1', deal_type: 'Lease', life_stage: 'Fresh' };
    expect(rollupMoves(offerDims(o), offerDims({ ...o, photo_count: 3 }))).toEqual([]);
    const moves = rollupMoves(offerDims(o), offerDims({ ...o, life_stage: 'Stale' }));
    expect(moves.map((m) => [m.delta, m.dims.life_stage])).toEqual([
      [-1, 'Fresh'],
      [1, 'Stale'],
    ]);
    expect(rollupMoves(null, offerDims(o))).toHaveLength(1);
  });

  it('uses the first stated micromarket of a demand', () => {
    const d = { ...blankDemand('d'), code: 'DEM-1', micromarkets: ['Powai', 'Chandivali'] };
    expect(demandDims(d)?.micromarket).toBe('Powai');
  });
});

describe('IST dates and periods', () => {
  const now = new Date('2026-10-07T20:00:00.000Z'); // 8 Oct 01:30 IST (a Thursday)
  it('uses the IST day', () => {
    expect(istDay(now)).toBe('2026-10-08');
  });
  it('resolves presets in IST', () => {
    expect(resolvePeriod('today', now)).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    expect(resolvePeriod('this_week', now)).toEqual({ from: '2026-10-05', to: '2026-10-08' });
    expect(resolvePeriod('this_month', now)).toEqual({ from: '2026-10-01', to: '2026-10-08' });
    expect(resolvePeriod('this_quarter', now)).toEqual({ from: '2026-10-01', to: '2026-10-08' });
    expect(resolvePeriod('last_month', now)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolvePeriod('next_60_days', now)).toEqual({ from: '2026-10-08', to: '2026-12-07' });
    expect(resolvePeriod('custom', now)).toBeNull();
    expect(resolvePeriod('custom', now, { from: '2026-01-01' })).toEqual({ from: '2026-01-01', to: '2026-10-08' });
  });
  it('reads stated possession periods', () => {
    expect(periodStart('2027')).toBe('2027-01-01');
    expect(periodStart('2027-02')).toBe('2027-02-01');
    expect(periodStart('2027-02-15')).toBe('2027-02-15');
    expect(periodStart('ready')).toBeNull();
  });
});

describe('mapping', () => {
  it('copies classification and prices, never contact data', () => {
    const o = offerCreated({ contactPersonIds: ['11111111-1111-4111-8111-111111111111'] });
    const patch = offerFacts(o);
    expect(patch).toMatchObject({ code: o.code, deal_type: 'Lease', property_type_primary: 'Apartment', rent_monthly_inr_max: 65_000 });
    expect(patch.contact_person_ids).toEqual(['11111111-1111-4111-8111-111111111111']);
    const d = demandFacts(demandCreated({ dealTypes: ['Sale', 'Lease'] }));
    expect(d.deal_type_primary).toBe('Sale');
  });
  it('derives stable ids', () => {
    expect(stableUuid('a|b')).toBe(stableUuid('a|b'));
    expect(stableUuid('a|b')).not.toBe(stableUuid('a|c'));
    expect(stableUuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
