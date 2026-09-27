import { describe, expect, it } from 'vitest';
import {
  FIELDS,
  LEGACY_ROLE_NAMES,
  LEGACY_TERMS,
  VOCABULARY_FIELDS,
  canonicalValue,
  legacyKey,
  parseField,
  translateLegacyFieldName,
  translateLegacyTerm,
  type VocabularyField,
} from '../src/index.js';

describe('legacy term table', () => {
  it('every target value is canonical in the release', () => {
    for (const entry of LEGACY_TERMS) {
      for (const [field, value] of Object.entries(entry.maps)) {
        if (field === 'bhk_min' || field === 'bhk_max') {
          expect(Number(value)).toBe(0.5);
          continue;
        }
        const parsed = parseField(field as VocabularyField, value);
        expect(parsed.ok, `${entry.term} → ${field}=${value}`).toBe(true);
      }
    }
  });

  it('no legacy term is itself a canonical value of its field', () => {
    for (const entry of LEGACY_TERMS) {
      if (entry.field === '*') continue;
      expect(canonicalValue(entry.field, entry.term), entry.term).toBeUndefined();
    }
  });

  it('terms are unique per field context', () => {
    const keys = LEGACY_TERMS.map((entry) => `${entry.field}:${legacyKey(entry.term)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('legacyKey ignores spaces around slashes', () => {
    expect(legacyKey(' Lease / RENT ')).toBe('lease/rent');
  });
});

describe('translateLegacyTerm: BRD §4.2 "absorbs" and §16', () => {
  it.each([
    ['Sell', { deal_type: 'Sale' }],
    ['Outright', { deal_type: 'Sale' }],
    ['Resale', { deal_type: 'Sale', market: 'Secondary' }],
    ['New Project', { deal_type: 'Sale', market: 'Primary' }],
    ['Buy', { deal_type: 'Sale', side: 'Demand' }],
    ['purchase', { deal_type: 'Sale', side: 'Demand' }],
    ['ACQUISITION', { deal_type: 'Sale', side: 'Demand' }],
    ['Rent', { deal_type: 'Lease' }],
    ['Lease/Rent', { deal_type: 'Lease' }],
    ['Lease / Rent', { deal_type: 'Lease' }],
    ['Lease Out', { deal_type: 'Lease' }],
    ['rent out', { deal_type: 'Lease' }],
    ['Leave and License', { deal_type: 'Lease', agreement_form: 'Leave and License' }],
    ['Lease transfer of premises', { deal_type: 'Lease' }],
    ['JD', { deal_type: 'JV' }],
    ['Joint Venture', { deal_type: 'JV' }],
    ['Joint Development', { deal_type: 'JV' }],
    ['Redevelopment', { deal_type: 'JV' }],
    ['Development Rights', { deal_type: 'JV' }],
    ['Pagadi', { deal_type: 'Pagdi' }],
    ['Pagri', { deal_type: 'Pagdi' }],
    ['Tenancy Transfer', { deal_type: 'Pagdi' }],
    ['Sale/Lease', { deal_type: 'Sale|Lease' }],
    ['Sale / Rent', { deal_type: 'Sale|Lease' }],
    ['Pre-leased', { deal_type: 'Sale', tenancy_status: 'Tenanted' }],
    ['Preleased', { deal_type: 'Sale', tenancy_status: 'Tenanted' }],
    ['Auction', { sale_mode: 'Auction' }],
    ['Unknown', {}],
  ])('deal_type "%s"', (raw, maps) => {
    expect(translateLegacyTerm('deal_type', raw)).toEqual({ ok: true, maps, translated: true });
  });

  it('Builder → party_type Developer', () => {
    expect(translateLegacyTerm('party_type', ' builder ')).toEqual({
      ok: true,
      maps: { party_type: 'Developer' },
      translated: true,
    });
  });

  it('1 RK → Studio with bhk 0.5 (PRD D-17)', () => {
    for (const raw of ['1 RK', '1rk']) {
      expect(translateLegacyTerm('property_type', raw)).toEqual({
        ok: true,
        maps: { property_type: 'Studio', bhk_min: '0.5', bhk_max: '0.5' },
        translated: true,
      });
    }
  });

  it('Unknown → blank in any field', () => {
    for (const field of VOCABULARY_FIELDS) {
      expect(translateLegacyTerm(field, 'UNKNOWN')).toEqual({ ok: true, maps: {}, translated: true });
    }
  });

  it('terms apply only in their field context', () => {
    expect(translateLegacyTerm('property_type', 'Resale')).toEqual({
      ok: false,
      field: 'property_type',
      value: 'Resale',
    });
    expect(translateLegacyTerm('deal_type', 'Builder')).toEqual({
      ok: false,
      field: 'deal_type',
      value: 'Builder',
    });
  });
});

describe('translateLegacyTerm: canonical values, blanks and lists', () => {
  it('canonical values pass through untranslated, for every field', () => {
    for (const field of VOCABULARY_FIELDS) {
      for (const value of FIELDS[field].values) {
        expect(translateLegacyTerm(field, value.toUpperCase())).toEqual({
          ok: true,
          maps: { [field]: value },
          translated: false,
        });
      }
    }
  });

  it('blank → empty maps', () => {
    expect(translateLegacyTerm('deal_type', null)).toEqual({ ok: true, maps: {}, translated: false });
    expect(translateLegacyTerm('deal_type', undefined)).toEqual({ ok: true, maps: {}, translated: false });
    expect(translateLegacyTerm('deal_type', '  ')).toEqual({ ok: true, maps: {}, translated: false });
  });

  it('pipe lists translate item by item and merge', () => {
    expect(translateLegacyTerm('deal_type', 'Resale|Rent Out')).toEqual({
      ok: true,
      maps: { deal_type: 'Sale|Lease', market: 'Secondary' },
      translated: true,
    });
    expect(translateLegacyTerm('deal_type', 'Sale|Lease')).toEqual({
      ok: true,
      maps: { deal_type: 'Sale|Lease' },
      translated: false,
    });
    expect(translateLegacyTerm('deal_type', 'Sale/Lease|JD|sale')).toEqual({
      ok: true,
      maps: { deal_type: 'Sale|Lease|JV' },
      translated: true,
    });
    expect(translateLegacyTerm('deal_type', 'Buy|Purchase')).toEqual({
      ok: true,
      maps: { deal_type: 'Sale', side: 'Demand' },
      translated: true,
    });
    expect(translateLegacyTerm('property_type', 'Office|1 RK')).toEqual({
      ok: true,
      maps: { property_type: 'Office|Studio', bhk_min: '0.5', bhk_max: '0.5' },
      translated: true,
    });
    expect(translateLegacyTerm('deal_type', 'Unknown|Rent')).toEqual({
      ok: true,
      maps: { deal_type: 'Lease' },
      translated: true,
    });
  });

  it('conflicting items are untranslatable', () => {
    expect(translateLegacyTerm('deal_type', 'Resale|New project')).toEqual({
      ok: false,
      field: 'deal_type',
      value: 'Resale|New project',
    });
  });

  it('an unknown or empty list item is untranslatable', () => {
    expect(translateLegacyTerm('deal_type', 'Sale|Barter')).toEqual({
      ok: false,
      field: 'deal_type',
      value: 'Barter',
    });
    expect(translateLegacyTerm('deal_type', 'Sale|')).toEqual({ ok: false, field: 'deal_type', value: '' });
  });

  it('unknown single values and pipes in single-valued fields are untranslatable', () => {
    expect(translateLegacyTerm('furnishing', ' Semi-Furnished ')).toEqual({
      ok: false,
      field: 'furnishing',
      value: 'Semi-Furnished',
    });
    expect(translateLegacyTerm('side', 'Supply|Demand')).toEqual({
      ok: false,
      field: 'side',
      value: 'Supply|Demand',
    });
  });
});

describe('legacy field and role names', () => {
  it('maps BRD §16 field names', () => {
    expect(translateLegacyFieldName(' transaction TYPE ')).toEqual(['deal_type']);
    expect(translateLegacyFieldName('Listing category')).toEqual(['segment', 'property_type']);
    expect(translateLegacyFieldName('Asset class')).toEqual(['segment', 'property_type']);
    expect(translateLegacyFieldName('Configuration')).toEqual(['property_type', 'bhk_min', 'bhk_max']);
    expect(translateLegacyFieldName('Broker or owner')).toEqual(['party_type']);
    expect(translateLegacyFieldName('price')).toBeUndefined();
  });

  it('maps lessor and lessee to landlord and tenant', () => {
    expect(LEGACY_ROLE_NAMES).toEqual({ Lessor: 'Landlord', Lessee: 'Tenant' });
  });
});
