import { describe, expect, it } from 'vitest';
import {
  DEAL_TYPES,
  DISPLAY_LABEL_TABLE,
  MARKETS,
  RECORD_SCOPES,
  SEGMENTS,
  SIDES,
  displayLabel,
  displayLabels,
  validateClassification,
  type DealType,
  type Market,
  type Segment,
  type Side,
} from '../src/index.js';

/**
 * BRD v0.6 §4.2 display label table, transcribed independently of the lib.
 * Key: deal_type + (market for Sale | segment class for Lease).
 */
const BRD_TABLE: Record<string, { supply: string | null; demand: string | null; parties: string }> = {
  'Sale/Secondary': {
    supply: 'Resale, For Sale',
    demand: 'Wants to Buy, Resale',
    parties: 'Seller and Buyer',
  },
  'Sale/Primary': {
    supply: 'New Project, For Sale',
    demand: 'Wants to Buy, New Project',
    parties: 'Developer and Buyer',
  },
  'Sale/Any': { supply: null, demand: 'Wants to Buy', parties: 'Buyer' },
  'Lease/Residential': { supply: 'For Rent', demand: 'Wants to Rent', parties: 'Landlord and Tenant' },
  'Lease/Commercial': { supply: 'For Lease', demand: 'Wants to Lease', parties: 'Landlord and Tenant' },
  'Lease/Industrial': { supply: 'For Lease', demand: 'Wants to Lease', parties: 'Landlord and Tenant' },
  'Lease/Land': { supply: 'For Lease', demand: 'Wants to Lease', parties: 'Landlord and Tenant' },
  JV: { supply: 'For JV', demand: 'Wants JV', parties: 'Landowner or Society and Developer' },
  Pagdi: { supply: 'Pagdi, For Transfer', demand: 'Wants Pagdi', parties: 'Outgoing and Incoming tenant' },
};

/** Assumption rows (README): Sale with a blank market; Lease with a blank segment. */
const ASSUMED: Record<
  string,
  { supply: string; demand: string; supplyParties: string; demandParties: string }
> = {
  'Sale/blank': {
    supply: 'For Sale',
    demand: 'Wants to Buy',
    supplyParties: 'Seller and Buyer',
    demandParties: 'Buyer',
  },
  'Lease/blank': {
    supply: 'For Lease',
    demand: 'Wants to Lease',
    supplyParties: 'Landlord and Tenant',
    demandParties: 'Landlord and Tenant',
  },
};

function expected(
  side: 'Supply' | 'Demand',
  dealType: 'Sale' | 'Lease' | 'JV' | 'Pagdi',
  market: Market | null,
  segment: Segment | null,
): { text: string; parties: string } | null {
  let key: string = dealType;
  if (dealType === 'Sale') key = `Sale/${market ?? 'blank'}`;
  if (dealType === 'Lease') key = `Lease/${segment ?? 'blank'}`;
  const brd = BRD_TABLE[key];
  if (brd !== undefined) {
    const text = side === 'Supply' ? brd.supply : brd.demand;
    return text === null ? null : { text, parties: brd.parties };
  }
  const assumed = ASSUMED[key];
  if (assumed === undefined) throw new Error(`no expectation for ${key}`);
  return side === 'Supply'
    ? { text: assumed.supply, parties: assumed.supplyParties }
    : { text: assumed.demand, parties: assumed.demandParties };
}

const MARKET_OPTIONS: (Market | null)[] = [...MARKETS, null];
const SEGMENT_OPTIONS: (Segment | null)[] = [...SEGMENTS, null];
const SIDE_OPTIONS: (Side | null)[] = [...SIDES, null];

describe('display label table (BRD §4.2)', () => {
  it('holds exactly the seven BRD rows', () => {
    expect(DISPLAY_LABEL_TABLE.map((row) => row.dealType)).toEqual([
      'Sale, Secondary',
      'Sale, Primary',
      'Sale, Any (demand)',
      'Lease, Residential',
      'Lease, Commercial, Industrial, Land',
      'JV',
      'Pagdi',
    ]);
  });

  it('Supply labels start with "For" or carry it after a prefix; Demand labels start with "Wants"', () => {
    for (const row of DISPLAY_LABEL_TABLE) {
      if (row.supplyLabel !== null) expect(row.supplyLabel).toMatch(/(^|, )For /u);
      expect(row.demandLabel).toMatch(/^Wants /u);
    }
  });

  let validCombos = 0;
  for (const side of ['Supply', 'Demand'] as const) {
    for (const dealType of ['Sale', 'Lease', 'JV', 'Pagdi'] as const) {
      for (const market of MARKET_OPTIONS) {
        for (const segment of SEGMENT_OPTIONS) {
          // Only combinations the validator accepts are labelled.
          const valid = validateClassification({
            recordScope: 'Property',
            side,
            dealType,
            market,
            segment,
          });
          if (!valid.ok) continue;
          validCombos += 1;
          it(`${side} ${dealType} market=${market ?? 'blank'} segment=${segment ?? 'blank'}`, () => {
            const label = displayLabel({ recordScope: 'Property', side, dealType, market, segment });
            const want = expected(side, dealType, market, segment);
            if (want === null) {
              expect(label).toBeNull();
            } else {
              expect(label).toMatchObject({ dealType, text: want.text, parties: want.parties });
            }
          });
        }
      }
    }
  }

  it('covers every valid Property combination (sanity count)', () => {
    // Sale: Supply 3 markets (Primary, Secondary, blank) + Demand 4, × 5 segments = 35.
    // Lease, JV, Pagdi: market must be blank, × 5 segments × 2 sides = 30.
    expect(validCombos).toBe(35 + 30);
  });

  it('Supply with market Any is rejected by the validator, and has no label', () => {
    expect(
      validateClassification({ recordScope: 'Property', side: 'Supply', dealType: 'Sale', market: 'Any' }).ok,
    ).toBe(false);
    expect(
      displayLabel({ recordScope: 'Property', side: 'Supply', dealType: 'Sale', market: 'Any' }),
    ).toBeNull();
  });

  it('ignores market on non-Sale deal types and segment on non-Lease deal types', () => {
    expect(
      displayLabel({
        recordScope: 'Property',
        side: 'Supply',
        dealType: 'JV',
        market: 'Primary',
        segment: 'Residential',
      })?.text,
    ).toBe('For JV');
    expect(
      displayLabel({
        recordScope: 'Property',
        side: 'Demand',
        dealType: 'Sale',
        market: 'Primary',
        segment: 'Residential',
      })?.text,
    ).toBe('Wants to Buy, New Project');
  });

  it('treats omitted market and segment as blank', () => {
    expect(displayLabel({ recordScope: 'Property', side: 'Supply', dealType: 'Sale' })?.text).toBe(
      'For Sale',
    );
    expect(displayLabel({ recordScope: 'Property', side: 'Demand', dealType: 'Lease' })?.text).toBe(
      'Wants to Lease',
    );
  });

  it('reports the table row used', () => {
    const rows = [
      displayLabel({ recordScope: 'Property', side: 'Supply', dealType: 'Sale', market: 'Secondary' })?.row,
      displayLabel({ recordScope: 'Property', side: 'Supply', dealType: 'Sale', market: 'Primary' })?.row,
      displayLabel({ recordScope: 'Property', side: 'Demand', dealType: 'Sale', market: 'Any' })?.row,
      displayLabel({ recordScope: 'Property', side: 'Demand', dealType: 'Sale' })?.row,
      displayLabel({ recordScope: 'Property', side: 'Supply', dealType: 'Lease', segment: 'Residential' })
        ?.row,
      displayLabel({ recordScope: 'Property', side: 'Supply', dealType: 'Lease', segment: 'Land' })?.row,
      displayLabel({ recordScope: 'Property', side: 'Supply', dealType: 'JV' })?.row,
      displayLabel({ recordScope: 'Property', side: 'Supply', dealType: 'Pagdi' })?.row,
    ];
    expect(rows).toEqual([
      'sale_secondary',
      'sale_primary',
      'sale_any',
      'sale_market_unknown',
      'lease_residential',
      'lease_other',
      'jv',
      'pagdi',
    ]);
  });
});

describe('records without a label', () => {
  it('non-Property scopes, blank scope, side None or blank, and non-Property deal types give null', () => {
    for (const recordScope of [...RECORD_SCOPES, null]) {
      for (const side of SIDE_OPTIONS) {
        for (const dealType of DEAL_TYPES) {
          const label = displayLabel({ recordScope, side, dealType });
          const labelled =
            recordScope === 'Property' &&
            (side === 'Supply' || side === 'Demand') &&
            (['Sale', 'Lease', 'JV', 'Pagdi'] as DealType[]).includes(dealType);
          expect(label === null).toBe(!labelled);
        }
      }
    }
  });
});

describe('displayLabels (one per deal type)', () => {
  it('Sale|Lease supply on Residential with market Secondary gives two labels in order', () => {
    const labels = displayLabels({
      recordScope: 'Property',
      side: 'Supply',
      dealTypes: ['Sale', 'Lease'],
      market: 'Secondary',
      segment: 'Residential',
    });
    expect(labels.map((l) => l.text)).toEqual(['Resale, For Sale', 'For Rent']);
  });

  it('demand open to Sale and Lease on Commercial', () => {
    const labels = displayLabels({
      recordScope: 'Property',
      side: 'Demand',
      dealTypes: ['Sale', 'Lease'],
      market: 'Any',
      segment: 'Commercial',
    });
    expect(labels.map((l) => l.text)).toEqual(['Wants to Buy', 'Wants to Lease']);
  });

  it('skips deal types without a label and returns [] for none', () => {
    expect(
      displayLabels({
        recordScope: 'Property',
        side: 'Supply',
        dealTypes: ['Sale', 'JV'],
        market: 'Any',
      }).map((l) => l.text),
    ).toEqual(['For JV']);
    expect(displayLabels({ recordScope: 'Business', side: 'Supply', dealTypes: ['Sale'] })).toEqual([]);
    expect(displayLabels({ recordScope: 'Property', side: 'Supply', dealTypes: [] })).toEqual([]);
  });
});
