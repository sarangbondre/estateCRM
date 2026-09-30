// Domain: cell parsers, rules classifier, legacy translation, reason codes, identity/hash/batch numbering, and row
// normalisation in strict and mapping modes (LLD §4.4–§4.8, R-11, D-15, D-17, CR-006 Z-6).
import { describe, expect, it } from 'vitest';
import * as cell from '../../src/domain/cells.js';
import {
  classifyText,
  extractArea,
  extractBhk,
  extractPrice,
  extractSide,
} from '../../src/domain/classify.js';
import { batchNumbers, contentHash, externalIdentity, uuidV5 } from '../../src/domain/identity.js';
import { maskPrivateTerms } from '../../src/domain/private-terms.js';
import { extractorReasons, primaryReason } from '../../src/domain/reasons.js';
import { finaliseReasons, normaliseMapping, normaliseStrict, rejected } from '../../src/domain/rows.js';
import type { TargetField } from '../../src/domain/schema.js';
import { BUNDLED_LEGACY_TERMS, LegacyTable } from '../../src/domain/translate.js';

const table = new LegacyTable(BUNDLED_LEGACY_TERMS);
const getter = (values: Partial<Record<TargetField, string | null>>) => (f: TargetField) => values[f] ?? null;
const opts = { importCrmNotes: false, duplicate: false };

const STRICT_OK: Partial<Record<TargetField, string>> = {
  record_id: 'a1b2c3d4e5f6',
  record_scope: 'property',
  deal_type: 'Sale|lease',
  segment: 'Residential',
  property_type: 'Apartment',
  side: 'Supply',
  needs_review: 'FALSE',
  bhk_min: '2',
  bhk_max: '3',
  phones: '+91 90000 11111|022-2000 0789',
  source_date: '2026-07-06 00:00:00',
  possession_date: '2026-05',
  lead_status: 'New',
};

describe('cells', () => {
  it('parses booleans, numbers, dates and possession dates', () => {
    expect(cell.bool('TRUE')).toEqual({ ok: true, value: true });
    expect(cell.bool('maybe').ok).toBe(false);
    expect(cell.int('1,20,00,000')).toEqual({ ok: true, value: 12_000_000 });
    expect(cell.int('2.5').ok).toBe(false);
    expect(cell.num('three').ok).toBe(false);
    expect(cell.date('2026-02-30').ok).toBe(false);
    expect(cell.date('31-13-2026').ok).toBe(false);
    expect(cell.date('46209')).toEqual({ ok: true, value: '2026-07-06' });
    expect(cell.date('06/07/2026', true)).toEqual({ ok: true, value: '2026-07-06' });
    expect(cell.possessionDate('2027')).toEqual({ ok: true, value: '2027' });
    expect(cell.possessionDate('2027-13').ok).toBe(false);
  });

  it('normalises phones to E.164 (+91 default) and rejects junk', () => {
    expect(cell.phone('90000 11111')).toBe('+919000011111');
    expect(cell.phone('0 90000-11111')).toBe('+919000011111');
    expect(cell.phone('+91 90000 11111')).toBe('+919000011111');
    expect(cell.phone('022 2000 0789')).toBe('+912220000789');
    expect(cell.phone('+9100000123456')).toBe('+9100000123456');
    expect(cell.phone('+91 12')).toBeNull();
    expect(cell.phone('ph 0000')).toBeNull();
    expect(cell.phoneList('12345|9000011111')).toEqual({ phones: ['+919000011111'], invalid: ['12345'] });
  });
});

describe('rules classifier', () => {
  it('finds side phrases with evidence, demand first', () => {
    expect(extractSide('2BHK required in Powai on rent')).toEqual({ side: 'Demand', evidence: 'required' });
    expect(extractSide('Office available for lease in BKC')).toEqual({
      side: 'Supply',
      evidence: 'available',
    });
  });

  it('extracts BHK, area (→ sq ft) and prices', () => {
    expect(extractBhk('Spacious 2/3 BHK')).toEqual({ min: 2, max: 3 });
    expect(extractBhk('1 RK in Dadar')).toEqual({ min: 0.5, max: 0.5 });
    expect(extractArea('1,200 sq ft carpet')).toEqual({ min: 1200, max: 1200 });
    expect(extractArea('2 acres')).toEqual({ min: 87_120, max: 87_120 });
    expect(extractPrice('asking 1.8 Cr neg')).toEqual({ kind: 'sale', min: 18_000_000, max: 18_000_000 });
    expect(extractPrice('rent 45k pm')).toEqual({ kind: 'rent', min: 45_000, max: 45_000 });
    expect(extractPrice('Rs 72,00,000')).toEqual({ kind: 'sale', min: 7_200_000, max: 7_200_000 });
  });

  it('classifies a typical ad', () => {
    const c = classifyText('Wanted 2BHK flat on rent in Andheri West, budget 60k pm');
    expect(c).toMatchObject({
      recordScope: 'Property',
      dealTypes: ['Lease'],
      segment: 'Residential',
      propertyTypes: ['Apartment'],
      side: 'Demand',
      bhkMin: 2,
      rentMonthlyInrMin: 60_000,
    });
    expect(classifyText('Government tender notice for land').recordScope).toBe('Market Signal');
  });
});

describe('legacy translation (mapping mode)', () => {
  it('translates legacy terms, patterns and pipe lists; flags untranslatable values', () => {
    expect(table.translate('deal_type', 'Resale')).toEqual({
      ok: true,
      maps: { deal_type: 'Sale', market: 'Secondary' },
      translated: true,
    });
    expect(table.translate('deal_type', 'rent out')).toMatchObject({
      ok: true,
      maps: { deal_type: 'Lease' },
    });
    expect(table.translate('deal_type', 'Sale/Lease')).toMatchObject({
      ok: true,
      maps: { deal_type: 'Sale|Lease' },
    });
    expect(table.translate('property_type', '2BHK Flat')).toMatchObject({
      ok: true,
      maps: { property_type: 'Apartment', bhk_min: '2' },
    });
    expect(table.translate('property_type', '1 RK')).toMatchObject({
      ok: true,
      maps: { property_type: 'Studio', bhk_min: '0.5' },
    });
    expect(table.translate('deal_type', 'Unknown')).toEqual({ ok: true, maps: {}, translated: true });
    expect(table.translate('deal_type', 'Barter')).toEqual({
      ok: false,
      field: 'deal_type',
      value: 'Barter',
    });
  });
});

describe('reason codes (US-07a AC5)', () => {
  it('derives codes from the extractor text and picks the primary by priority', () => {
    const r = extractorReasons('side defaulted to Supply; deal type not stated; blurry scan');
    expect(r.map((x) => x.code)).toEqual(['side_defaulted', 'deal_type_missing', 'other']);
    expect(primaryReason(r)?.code).toBe('deal_type_missing');
    expect(primaryReason([...r, { code: 'side_unclear', detail: 'side_missing' }])?.code).toBe(
      'side_unclear',
    );
  });
});

describe('identity', () => {
  it('numbers batches deterministically per chunk (§4.6)', () => {
    expect(batchNumbers(500, 3, 420)).toEqual([3]);
    expect(batchNumbers(2000, 2, 1200)).toEqual([5, 6, 7]);
    expect(batchNumbers(500, 1, 0)).toEqual([]);
  });

  it('hashes canonical content ignoring key order and CRM working columns', () => {
    expect(contentHash({ a: 1, b: [1, 2] })).toBe(contentHash({ b: [1, 2], a: 1, crmNotes: 'x' }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('keeps the hash of 89-column rows: blank building/floor and the note flag do not count (CR-012)', () => {
    const old = contentHash({ a: 1 });
    expect(contentHash({ a: 1, buildingName: null, floor: null, hasCrmNotes: true, crmNotes: null })).toBe(old);
    expect(contentHash({ a: 1, buildingName: 'Sea Breeze' })).not.toBe(old);
  });

  it('masks the building name and floor in model text (CR-012)', () => {
    const t = 'Flat in SEA BREEZE  tower on 7th floor, near Sea Breeze Tower gate; 7 lakh; floor no. 7';
    const out = maskPrivateTerms(t, { buildingName: 'Sea Breeze Tower', floor: '7' });
    expect(out).toBe('Flat in [UNIT_1] on [UNIT_2], near [UNIT_1] gate; 7 lakh; [UNIT_2]');
    expect(maskPrivateTerms('G floor shop', { floor: 'G' })).toBe('[UNIT_1] shop');
    expect(maskPrivateTerms('12 of 20, Worli', { floor: '12 of 20' })).toBe('[UNIT_1], Worli');
    expect(maskPrivateTerms('At Om, Thane', { buildingName: 'Om' })).toBe('At Om, Thane'); // too short to mask
  });

  it('normalises building_name, floor and crm_notes (flag only in the IntakeRow fields)', () => {
    const r = normaliseStrict(
      getter({ ...STRICT_OK, building_name: ' Sea Breeze ', floor: '12', crm_notes: 'call after 6' }),
      opts,
    );
    expect(r.fields).toMatchObject({ buildingName: 'Sea Breeze', floor: '12', hasCrmNotes: true, crmNotes: null });
    expect(r.crmNote).toBe('call after 6');
    expect(normaliseStrict(getter(STRICT_OK), opts).fields['hasCrmNotes']).toBe(false);
  });

  it('chooses the external reference (§4.5)', () => {
    const base = {
      templateId: null,
      sourceType: 'Digi',
      sourceDetail: 'Meta Ads',
      contentHash: 'f'.repeat(64),
    };
    expect(externalIdentity({ ...base, recordId: 'a1b2c3d4e5f6', externalId: null })).toEqual({
      externalSource: 'extractor',
      externalRef: 'a1b2c3d4e5f6',
    });
    expect(externalIdentity({ ...base, recordId: null, externalId: 'L-9' }).externalRef).toBe(
      'digi:meta-ads:L-9',
    );
    expect(externalIdentity({ ...base, recordId: null, externalId: null }).externalRef).toBe(
      `h:${'f'.repeat(24)}`,
    );
  });

  it('builds RFC 4122 v5 UUIDs', () => {
    // RFC 4122 DNS namespace example
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });
});

describe('strict rows (§4.4, R-11)', () => {
  it('loads a valid row in canonical spelling with E.164 phones; CRM working columns ignored', () => {
    const row = normaliseStrict(getter(STRICT_OK), opts);
    expect(rejected(row)).toBe(false);
    expect(row.fields).toMatchObject({
      recordScope: 'Property',
      dealTypes: ['Sale', 'Lease'],
      side: 'Supply',
      phones: ['+919000011111', '+912220000789'],
      sourceDate: '2026-07-06',
      possessionDate: '2026-05',
      bhkMin: 2,
    });
    expect(row.fields).not.toHaveProperty('leadStatus');
    expect(row.reasons).toEqual([]);
  });

  it('rejects vocabulary, cross-field, type and range errors with contract codes', () => {
    const codes = (v: Partial<Record<TargetField, string>>) =>
      normaliseStrict(getter({ ...STRICT_OK, ...v }), opts).issues.map((i) => i.code);
    expect(codes({ deal_type: 'Rent Out' })).toEqual(['value-not-in-list']);
    expect(codes({ deal_type: 'Equity' })).toEqual(['scope-deal-type-mismatch']);
    expect(codes({ market: 'Primary', deal_type: 'Lease' })).toEqual(['market-on-non-sale']);
    expect(codes({ side: 'None' })).toEqual(['side-scope-mismatch']);
    expect(codes({ bhk_min: '4' })).toEqual(['range-inverted']);
    expect(codes({ bhk_min: 'three' })).toEqual(['invalid-type']);
    expect(codes({ source_date: '2026-02-30' })).toEqual(['invalid-date']);
    expect(codes({ record_id: '' })).toEqual(['required-missing']);
    expect(codes({ furnishing: 'Semi-Furnished' })).toEqual(['value-not-in-list']);
  });

  it('keeps invalid phones as a warning (value moved to other_contact, never stored in the error)', () => {
    const row = normaliseStrict(getter({ ...STRICT_OK, phones: '12345' }), opts);
    expect(rejected(row)).toBe(false);
    expect(row.issues).toEqual([
      expect.objectContaining({ code: 'invalid-phone', severity: 'warning', value: null }),
    ]);
    expect(row.fields['otherContact']).toBe('12345');
  });

  it('loads a blank side with review side_unclear/side_missing and extractor reasons', () => {
    const row = normaliseStrict(
      getter({ ...STRICT_OK, side: '', needs_review: 'TRUE', review_reason: 'side defaulted to Supply' }),
      opts,
    );
    expect(rejected(row)).toBe(false);
    expect(row.reasons).toEqual([
      { code: 'side_unclear', detail: 'side_missing' },
      { code: 'side_defaulted', detail: 'extractor_flag' },
    ]);
  });

  it('rejects the second occurrence of a record_id', () => {
    const row = normaliseStrict(getter(STRICT_OK), { ...opts, duplicate: true });
    expect(row.issues.map((i) => i.code)).toEqual(['duplicate-external-ref']);
  });
});

describe('mapping rows (§4.7, D-15)', () => {
  it('translates legacy terms and fills blanks from the text; never rejects for vocabulary', () => {
    const row = normaliseMapping(
      getter({
        deal_type: 'Resale',
        property_type: '2BHK Flat',
        raw_text: 'available in Powai, 1.2 Cr',
        phones: '9000011111',
      }),
      table,
      opts,
    );
    finaliseReasons(row, 'mapping');
    expect(rejected(row)).toBe(false);
    expect(row.fields).toMatchObject({
      recordScope: 'Property',
      dealTypes: ['Sale'],
      market: 'Secondary',
      segment: 'Residential',
      propertyTypes: ['Apartment'],
      bhkMin: 2,
      side: 'Supply',
      sideEvidence: 'available',
      salePriceInrMin: 12_000_000,
      routeTo: 'Supply Team',
    });
    expect(row.needsModel).toBe(false);
  });

  it('blanks an untranslatable value with value_not_translatable (+ deal_type_missing) and asks the model', () => {
    const row = normaliseMapping(
      getter({ deal_type: 'Barter', free_text: 'Nice place, call now' }),
      table,
      opts,
    );
    expect(rejected(row)).toBe(false);
    expect(row.fields['dealTypes']).toEqual([]);
    expect(row.reasons.map((r) => r.code)).toEqual(['value_not_translatable', 'deal_type_missing']);
    expect(row.needsModel).toBe(true);
  });
});
