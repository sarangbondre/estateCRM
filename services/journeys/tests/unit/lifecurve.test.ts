// Life curve domain rules (BRD §4.5, D-12, R-12; LLD §4.1).
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, daysBetween, istDate, normalisePeriodStart } from '../../src/domain/dates.js';
import {
  DEFAULT_THRESHOLDS,
  demandCategory,
  evaluateCurve,
  offerCategory,
  stageActions,
  stageForDay,
  thresholdErrors,
  thresholdsFor,
  upcomingClockStart,
} from '../../src/domain/lifecurve.js';

describe('dates (IST)', () => {
  it('uses the IST calendar date', () => {
    expect(istDate(new Date('2026-09-30T18:29:59Z'))).toBe('2026-09-30');
    expect(istDate(new Date('2026-09-30T18:30:00Z'))).toBe('2026-10-01');
  });
  it('adds days and months, clamping the day', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-15', 10)).toBe('2027-01-15');
  });
  it('normalises month/year precision to the first day (JA-8)', () => {
    expect(normalisePeriodStart('2027')).toBe('2027-01-01');
    expect(normalisePeriodStart('2027-02')).toBe('2027-02-01');
    expect(normalisePeriodStart('2027-02-14')).toBe('2027-02-14');
    expect(normalisePeriodStart('soon')).toBeNull();
  });
});

describe('category keys (LLD §4.1.1)', () => {
  it.each([
    [{ segment: 'Industrial', dealType: 'Lease', market: null }, 'industrial'],
    [{ segment: 'Land', dealType: 'Sale', market: null }, 'land_jv'],
    [{ segment: 'Residential', dealType: 'JV', market: null }, 'land_jv'],
    [{ segment: 'Residential', dealType: 'Pagdi', market: null }, 'sale_secondary'],
    [{ segment: 'Residential', dealType: 'Lease', market: null }, 'lease_residential'],
    [{ segment: null, dealType: 'Lease', market: null }, 'lease_residential'],
    [{ segment: 'Commercial', dealType: 'Lease', market: null }, 'lease_commercial'],
    [{ segment: 'Residential', dealType: 'Sale', market: 'Primary' }, 'sale_primary'],
    [{ segment: 'Residential', dealType: 'Sale', market: 'Secondary' }, 'sale_secondary'],
    [{ segment: 'Commercial', dealType: 'Sale', market: null }, 'sale_secondary'],
  ])('offer %o → %s', (input, key) => expect(offerCategory(input)).toBe(key));

  it('JA-2: Industrial wins over JV and Pagdi', () => {
    expect(offerCategory({ segment: 'Industrial', dealType: 'JV', market: null })).toBe('industrial');
    expect(offerCategory({ segment: 'Industrial', dealType: 'Pagdi', market: null })).toBe('industrial');
  });

  it('R-12: a multi-deal-type demand takes the shortest thresholds', () => {
    expect(demandCategory({ segment: 'Residential', dealTypes: ['Sale', 'Lease'], market: 'Secondary' }, DEFAULT_THRESHOLDS)).toBe(
      'lease_residential',
    );
    expect(demandCategory({ segment: 'Commercial', dealTypes: ['Sale', 'Lease'], market: 'Primary' }, DEFAULT_THRESHOLDS)).toBe(
      'lease_commercial',
    );
    expect(demandCategory({ segment: 'Residential', dealTypes: ['Sale'], market: 'Any' }, DEFAULT_THRESHOLDS)).toBe('sale_secondary_any');
    expect(demandCategory({ segment: 'Residential', dealTypes: ['Pagdi'], market: null }, DEFAULT_THRESHOLDS)).toBe('sale_secondary_any');
  });

  it('seeded thresholds match the LLD table', () => {
    expect(thresholdsFor('offer.lease_residential', DEFAULT_THRESHOLDS)).toEqual({ freshMaxDays: 14, ageingMaxDays: 30, staleMaxDays: 45 });
    expect(thresholdsFor('demand.lease_residential', DEFAULT_THRESHOLDS)).toEqual({ freshMaxDays: 14, ageingMaxDays: 21, staleMaxDays: 30 });
    expect(thresholdsFor('demand.sale_secondary_any', DEFAULT_THRESHOLDS)).toEqual({ freshMaxDays: 45, ageingMaxDays: 90, staleMaxDays: 150 });
    expect(thresholdsFor('offer.land_jv', DEFAULT_THRESHOLDS).staleMaxDays).toBe(180);
    expect(thresholdErrors(DEFAULT_THRESHOLDS)).toEqual([]);
    expect(
      thresholdErrors({ ...DEFAULT_THRESHOLDS, offer: { ...DEFAULT_THRESHOLDS.offer, industrial: { freshMaxDays: 50, ageingMaxDays: 40, staleMaxDays: 60 } } }),
    ).toEqual(['offer.industrial']);
  });
});

describe('stage evaluation (LLD §4.1.2)', () => {
  const lease = thresholdsFor('offer.lease_commercial', DEFAULT_THRESHOLDS); // 30 / 60 / 90
  const base = { lastConfirmedDate: null, clockFloor: '2026-01-01', clockStartsOn: null, thresholds: lease, paused: false };

  it('day boundaries are the last day of each stage', () => {
    expect(stageForDay(30, lease)).toBe('Fresh');
    expect(stageForDay(31, lease)).toBe('Ageing');
    expect(stageForDay(60, lease)).toBe('Ageing');
    expect(stageForDay(61, lease)).toBe('Stale');
    expect(stageForDay(90, lease)).toBe('Stale');
    expect(stageForDay(91, lease)).toBe('Expired');
  });

  it('AS-S4: day 31 Ageing, day 61 Stale, day 91 Expired; next_change_on is the first day of the next stage', () => {
    expect(evaluateCurve({ ...base, today: '2026-01-31' })).toEqual({ stage: 'Fresh', dayCount: 30, nextChangeOn: '2026-02-01' });
    expect(evaluateCurve({ ...base, today: '2026-02-01' })).toEqual({ stage: 'Ageing', dayCount: 31, nextChangeOn: '2026-03-03' });
    expect(evaluateCurve({ ...base, today: '2026-03-03' }).stage).toBe('Stale');
    expect(evaluateCurve({ ...base, today: '2026-04-02' })).toEqual({ stage: 'Expired', dayCount: 91, nextChangeOn: null });
  });

  it('a confirmation resets the clock; sightings do not (only last_confirmed counts)', () => {
    expect(evaluateCurve({ ...base, lastConfirmedDate: '2026-03-01', today: '2026-03-10' })).toMatchObject({ stage: 'Fresh', dayCount: 9 });
  });

  it('a Dormant demand is Paused and not counted', () => {
    expect(evaluateCurve({ ...base, paused: true, today: '2026-06-01' })).toEqual({ stage: 'Paused', dayCount: 0, nextChangeOn: null });
  });

  it('AS-S5: an Upcoming offer (available 1 Feb) starts its clock 60 days before (2 Dec)', () => {
    const start = upcomingClockStart('2027-02-01', '2026-10-01', 60);
    expect(start).toBe('2026-12-03');
    const before = evaluateCurve({ ...base, clockFloor: '2026-10-01', clockStartsOn: start, today: '2026-11-15' });
    expect(before).toEqual({ stage: 'Fresh', dayCount: 0, nextChangeOn: '2026-12-03' });
    const after = evaluateCurve({ ...base, clockFloor: '2026-10-01', clockStartsOn: start, today: '2027-01-10' });
    expect(after).toMatchObject({ stage: 'Ageing', dayCount: 38 });
    expect(upcomingClockStart('2026-09-01', '2026-10-01', 60)).toBeNull();
  });
});

describe('stage actions (LLD §4.1.4)', () => {
  const ctx = { publicationLevel: 'Anonymous', isProjectConfiguration: false };
  it('offer: Ageing → Should call reconfirm (+ageing boost); project configuration → request_price_sheet (AS-S6)', () => {
    expect(stageActions('offer', 'Ageing', ctx)).toEqual([{ kind: 'queue', section: 'should_call', reason: 'reconfirm', boost: 'ageing' }]);
    expect(stageActions('offer', 'Ageing', { ...ctx, isProjectConfiguration: true })[0]).toMatchObject({ reason: 'request_price_sheet' });
  });
  it('offer: Stale + Public moves up with stale_public; Expired marks availability unknown', () => {
    expect(stageActions('offer', 'Stale', { ...ctx, publicationLevel: 'Public' })[0]).toMatchObject({ reason: 'stale_public', boost: 'stale_public' });
    expect(stageActions('offer', 'Stale', ctx)[0]).toMatchObject({ reason: 'reconfirm', boost: 'none' });
    expect(stageActions('offer', 'Expired', ctx).map((a) => a.kind)).toEqual(['queue', 'availability_unknown']);
    expect(stageActions('offer', 'Fresh', ctx)).toEqual([]);
  });
  it('demand: Ageing/Stale → reconfirm_due; Expired → automatic Dormant', () => {
    expect(stageActions('demand', 'Ageing', ctx)[0]).toMatchObject({ section: 'reconfirm_due' });
    expect(stageActions('demand', 'Stale', ctx)[0]).toMatchObject({ section: 'reconfirm_due' });
    expect(stageActions('demand', 'Expired', ctx)).toEqual([{ kind: 'dormant_exit' }]);
  });
});
