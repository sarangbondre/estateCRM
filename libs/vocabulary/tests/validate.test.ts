import { describe, expect, it } from 'vitest';
import {
  FIELDS,
  PROPERTY_TYPES_BY_SEGMENT,
  RECORD_SCOPES,
  RECORD_SCOPE_RULES,
  SEGMENTS,
  VOCABULARY_FIELDS,
  canonicalValue,
  isBlank,
  isMultiField,
  isValidValue,
  matchKey,
  parseField,
  parseList,
  parseValue,
  routeFor,
  segmentOfPropertyType,
  validateClassification,
  type RawClassification,
} from '../src/index.js';

function variants(value: string): string[] {
  return [
    value,
    value.toLowerCase(),
    value.toUpperCase(),
    `  ${value}  `,
    `\t${value.replace(/ /gu, '   ')}\n`,
  ];
}

describe('R-11 normalisation', () => {
  it('trims, collapses whitespace and case-folds', () => {
    expect(matchKey('  Semi   Furnished \t')).toBe('semi furnished');
    expect(matchKey('MARKET PARTICIPANT')).toBe('market participant');
  });

  it('isBlank', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('  \t')).toBe(true);
    expect(isBlank('x')).toBe(false);
  });

  it('every value of every field matches in case and whitespace variants, stored canonically', () => {
    for (const field of VOCABULARY_FIELDS) {
      for (const value of FIELDS[field].values) {
        for (const raw of variants(value)) {
          expect(canonicalValue(field, raw)).toBe(value);
          expect(isValidValue(field, raw)).toBe(true);
          const parsed = parseField(field, raw);
          expect(parsed).toEqual({ ok: true, value: isMultiField(field) ? [value] : value });
        }
      }
    }
  });

  it('match keys are unique within each field', () => {
    for (const field of VOCABULARY_FIELDS) {
      const keys = FIELDS[field].values.map(matchKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('only deal_type and property_type are pipe lists', () => {
    expect(VOCABULARY_FIELDS.filter(isMultiField)).toEqual(['deal_type', 'property_type']);
  });
});

describe('parseValue', () => {
  it('blank → null', () => {
    expect(parseValue('market', null)).toEqual({ ok: true, value: null });
    expect(parseValue('market', undefined)).toEqual({ ok: true, value: null });
    expect(parseValue('market', '   ')).toEqual({ ok: true, value: null });
  });

  it('placeholders are not values (blank means unknown)', () => {
    for (const placeholder of ['Unknown', 'NA', 'Other', 'Various', '-']) {
      const result = parseValue('segment', placeholder);
      expect(result.ok).toBe(false);
    }
  });

  it('NA is a real land_use value and Other a real sector value', () => {
    expect(parseValue('land_use', 'na')).toEqual({ ok: true, value: 'NA' });
    expect(parseValue('sector', 'other')).toEqual({ ok: true, value: 'Other' });
  });

  it('value-not-in-list names the field and the trimmed value', () => {
    expect(parseValue('furnishing', ' Semi-Furnished ')).toEqual({
      ok: false,
      issues: [
        {
          code: 'value-not-in-list',
          field: 'furnishing',
          value: 'Semi-Furnished',
          message: 'furnishing: "Semi-Furnished" is not in the controlled list',
        },
      ],
    });
  });

  it('legacy terms are not accepted in strict mode', () => {
    expect(parseValue('side', 'Buyer').ok).toBe(false);
    expect(parseList('deal_type', 'Resale').ok).toBe(false);
    expect(parseValue('party_type', 'Builder').ok).toBe(false);
  });
});

describe('parseList', () => {
  it('blank → []', () => {
    expect(parseList('deal_type', '')).toEqual({ ok: true, value: [] });
    expect(parseList('deal_type', null)).toEqual({ ok: true, value: [] });
    expect(parseList('deal_type', undefined)).toEqual({ ok: true, value: [] });
  });

  it('splits on pipes, normalises each item, dedupes in order', () => {
    expect(parseList('deal_type', ' lease | SALE |lease')).toEqual({ ok: true, value: ['Lease', 'Sale'] });
    expect(parseList('property_type', 'office|showroom')).toEqual({
      ok: true,
      value: ['Office', 'Showroom'],
    });
  });

  it('reports every bad item, including empty items', () => {
    const result = parseList('deal_type', 'Sale|Rent||Buy');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.value)).toEqual(['Rent', '', 'Buy']);
  });

  it('parseField dispatches to single-value parsing for other fields', () => {
    expect(parseField('side', 'demand')).toEqual({ ok: true, value: 'Demand' });
    expect(parseField('deal_type', 'jv|pagdi')).toEqual({ ok: true, value: ['JV', 'Pagdi'] });
  });
});

describe('helpers', () => {
  it('segmentOfPropertyType covers every property type', () => {
    for (const segment of SEGMENTS) {
      for (const type of PROPERTY_TYPES_BY_SEGMENT[segment])
        expect(segmentOfPropertyType(type)).toBe(segment);
    }
  });

  it('routeFor follows the record_scope table', () => {
    expect(routeFor('Property', 'Supply')).toBe('Supply Team');
    expect(routeFor('Property', 'Demand')).toBe('Demand Team');
    expect(routeFor('Property', null)).toBeNull();
    expect(routeFor('Property', 'None')).toBeNull();
    expect(routeFor('Business', 'Supply')).toBe('Business Desk');
    expect(routeFor('Capital', null)).toBe('Capital Desk');
    expect(routeFor('Equipment', 'Demand')).toBe('Archive');
    expect(routeFor('Market Participant', 'None')).toBe('Network');
    expect(routeFor('Market Signal', 'None')).toBe('Watchlist');
  });
});

function codes(raw: RawClassification): string[] {
  const result = validateClassification(raw);
  return result.ok ? [] : result.issues.map((i) => `${i.code}:${i.field}:${i.value}`);
}

describe('validateClassification', () => {
  it('accepts a complete Property record and returns canonical values', () => {
    const result = validateClassification({
      recordScope: ' property ',
      dealType: 'sale|LEASE',
      market: 'secondary',
      segment: 'residential',
      propertyType: 'apartment | penthouse',
      side: 'supply',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        recordScope: 'Property',
        dealTypes: ['Sale', 'Lease'],
        market: 'Secondary',
        segment: 'Residential',
        propertyTypes: ['Apartment', 'Penthouse'],
        landUse: null,
        side: 'Supply',
      },
      needsReview: false,
      reviewDetails: [],
    });
  });

  it('all blank is valid but needs review for the missing side', () => {
    expect(validateClassification({})).toMatchObject({
      ok: true,
      needsReview: true,
      reviewDetails: ['side_missing'],
    });
  });

  it('collects value-not-in-list issues from every field', () => {
    expect(
      codes({
        recordScope: 'Listing',
        dealType: 'Rent',
        market: 'New',
        segment: 'Retail',
        propertyType: 'Flat',
        landUse: 'Farm',
        side: 'Buyer',
      }),
    ).toEqual([
      'value-not-in-list:record_scope:Listing',
      'value-not-in-list:deal_type:Rent',
      'value-not-in-list:market:New',
      'value-not-in-list:segment:Retail',
      'value-not-in-list:property_type:Flat',
      'value-not-in-list:land_use:Farm',
      'value-not-in-list:side:Buyer',
    ]);
  });

  it.each([
    ['record_scope', { recordScope: 'x' }],
    ['deal_type', { dealType: 'x' }],
    ['market', { market: 'x' }],
    ['segment', { segment: 'x' }],
    ['property_type', { propertyType: 'x' }],
    ['land_use', { landUse: 'x' }],
    ['side', { side: 'x' }],
  ] as const)('a single bad %s is reported alone', (field, raw) => {
    expect(codes(raw)).toEqual([`value-not-in-list:${field}:x`]);
  });

  describe('deal_type allowed per record_scope', () => {
    for (const scope of RECORD_SCOPES) {
      const allowed: readonly string[] = RECORD_SCOPE_RULES[scope].allowedDealTypes;
      for (const dealType of FIELDS.deal_type.values) {
        const side = RECORD_SCOPE_RULES[scope].sides[0];
        it(`${scope} + ${dealType}`, () => {
          const result = codes({ recordScope: scope, dealType, side });
          if (allowed.includes(dealType)) expect(result).toEqual([]);
          else expect(result).toEqual([`scope-deal-type-mismatch:deal_type:${dealType}`]);
        });
      }
    }
  });

  it('side per record_scope', () => {
    for (const scope of RECORD_SCOPES) {
      for (const side of FIELDS.side.values) {
        const allowed: readonly string[] = RECORD_SCOPE_RULES[scope].sides;
        expect(codes({ recordScope: scope, side })).toEqual(
          allowed.includes(side) ? [] : [`side-scope-mismatch:side:${side}`],
        );
      }
    }
  });

  it('blank side needs review except on Market Participant and Market Signal', () => {
    for (const scope of RECORD_SCOPES) {
      const result = validateClassification({ recordScope: scope });
      const noSide = scope === 'Market Participant' || scope === 'Market Signal';
      expect(result).toMatchObject({ ok: true, needsReview: !noSide });
    }
  });

  it('property_type must belong to segment (every segment × every property type)', () => {
    for (const segment of SEGMENTS) {
      for (const other of SEGMENTS) {
        for (const type of PROPERTY_TYPES_BY_SEGMENT[other]) {
          const result = codes({ recordScope: 'Property', segment, propertyType: type, side: 'Supply' });
          expect(result).toEqual(
            segment === other ? [] : [`segment-property-type-mismatch:property_type:${type}`],
          );
        }
      }
    }
  });

  it('reports each mismatching item of a property_type list', () => {
    expect(codes({ segment: 'Commercial', propertyType: 'Office|Plot|Gala', side: 'Supply' })).toEqual([
      'segment-property-type-mismatch:property_type:Plot',
      'segment-property-type-mismatch:property_type:Gala',
    ]);
  });

  it('property_type with a blank segment is accepted (segment not inferred)', () => {
    expect(codes({ recordScope: 'Property', propertyType: 'Office', side: 'Supply' })).toEqual([]);
  });

  it('segment and property_type apply to Property only', () => {
    expect(
      codes({
        recordScope: 'Business',
        dealType: 'Sale',
        segment: 'Commercial',
        propertyType: 'Hotel',
        side: 'Supply',
      }),
    ).toEqual([
      'segment-property-type-mismatch:segment:Commercial',
      'segment-property-type-mismatch:property_type:Hotel',
    ]);
  });

  it('market needs Sale among the deal types', () => {
    expect(codes({ recordScope: 'Property', dealType: 'Lease', market: 'Primary', side: 'Supply' })).toEqual([
      'market-on-non-sale:market:Primary',
    ]);
    expect(codes({ recordScope: 'Property', market: 'Secondary', side: 'Supply' })).toEqual([
      'market-on-non-sale:market:Secondary',
    ]);
    expect(
      codes({ recordScope: 'Property', dealType: 'Sale|Lease', market: 'Primary', side: 'Supply' }),
    ).toEqual([]);
  });

  it('market Any is Demand only', () => {
    expect(codes({ recordScope: 'Property', dealType: 'Sale', market: 'Any', side: 'Supply' })).toEqual([
      'value-not-in-list:market:Any',
    ]);
    expect(codes({ recordScope: 'Property', dealType: 'Sale', market: 'Any', side: 'Demand' })).toEqual([]);
    expect(
      validateClassification({ recordScope: 'Property', dealType: 'Sale', market: 'Any' }),
    ).toMatchObject({
      ok: true,
      needsReview: true,
    });
  });

  it('non-Property deal types with market on Sale (literal BRD: market is Sale only)', () => {
    expect(
      codes({ recordScope: 'Equipment', dealType: 'Sale', market: 'Secondary', side: 'Supply' }),
    ).toEqual([]);
  });

  it('land_use is validated but not restricted to the Land segment', () => {
    expect(codes({ recordScope: 'Property', segment: 'Land', landUse: 'na', side: 'Supply' })).toEqual([]);
    expect(
      codes({ recordScope: 'Property', segment: 'Commercial', landUse: 'Mixed', side: 'Supply' }),
    ).toEqual([]);
  });

  it('cross-field rules run with a blank scope', () => {
    expect(codes({ dealType: 'JV', market: 'Primary', side: 'Supply' })).toEqual([
      'market-on-non-sale:market:Primary',
    ]);
  });
});
