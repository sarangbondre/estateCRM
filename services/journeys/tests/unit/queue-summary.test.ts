// Queue summary lines (QueueItem.summary): readable places only. Micromarkets reach journeys as ids, so the offer's
// locality is shown and an id never is.
import { describe, expect, it } from 'vitest';
import { demandSummary, offerSummary } from '../../src/domain/queue.js';

const ID = '01a0fd6a-616c-776a-8328-6efea449a900';

describe('queue summaries', () => {
  it('offer: locality instead of a micromarket id', () => {
    const base = {
      dealType: 'Sale',
      propertyTypes: ['Apartment'],
      areaSqftMin: 5500,
      salePriceInrMin: 900_000_000,
      rentMonthlyInrMin: null,
    };
    expect(offerSummary({ ...base, micromarket: ID, locality: 'Wadala East' })).toBe(
      'Sale · Apartment · Wadala East · 5500 sq ft · ₹90 Cr',
    );
    expect(offerSummary({ ...base, micromarket: ID, locality: null })).toBe(
      'Sale · Apartment · 5500 sq ft · ₹90 Cr',
    );
    expect(offerSummary({ ...base, micromarket: 'Powai', locality: null })).toContain('Powai');
  });
  it('demand: micromarket ids are left out', () => {
    expect(
      demandSummary({
        dealTypes: ['Lease'],
        propertyTypes: ['Office'],
        micromarkets: [ID, 'Andheri East'],
        budgetInrMax: null,
        rentMonthlyInrMax: null,
      }),
    ).toBe('Lease · Office · Andheri East');
  });
});
