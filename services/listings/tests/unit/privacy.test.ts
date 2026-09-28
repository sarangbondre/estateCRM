// Blocking privacy scan (LLD §4.4, R-8, R-20). All phone numbers and e-mails are synthetic (libs/testing scheme).
import { describe, expect, it } from 'vitest';
import { hmacTermHasher } from '../../src/adapters/records-client.js';
import {
  allowListOf,
  candidateGrams,
  normaliseForDigits,
  outcomeOf,
  scanText,
  termFindings,
} from '../../src/domain/privacy.js';
import type { TermKind } from '../../src/domain/privacy.js';
import { headline } from '../../src/domain/labels.js';
import { generatedDescription } from '../../src/domain/projection.js';
import { offer } from './fixtures.js';

const kinds = (text: string, allowIds: string[] = []) => [
  ...new Set(
    scanText({ text, allowIds: new Set(allowIds) })
      .filter((f) => f.severity === 'block')
      .map((f) => f.kind),
  ),
];

describe('blocking patterns', () => {
  it.each([
    'Call 9000012345 for a visit',
    'Call +91 90000 12345',
    'ph: 090000-12345',
    'call nine zero zero zero zero one two three four five',
    'nau zero zero zero zero ek do teen char paanch',
    'call 9 double zero zero 0 12345',
    '9OOOO 12345 anytime',
    'Landline 022-2000 0789',
  ])('phone: %s', (text) => {
    expect(kinds(text)).toContain('phone');
  });

  it.each(['mail owner@example.com', 'owner at example dot com', 'owner[at]example[dot]in'])(
    'email: %s',
    (text) => {
      expect(kinds(text)).toContain('email');
    },
  );

  it.each(['see www.example.com', 'https://example.in/listing', 'wa.me/919000012345', 'bit.ly/abc123'])(
    'url: %s',
    (t) => {
      expect(kinds(t)).toContain('url');
    },
  );

  it.each(['DM @flatowner_mumbai', 'insta: flatowner.mumbai', 'whatsapp me homeseller99'])(
    'handle: %s',
    (t) => {
      expect(kinds(t)).toContain('social_handle');
    },
  );

  it.each([
    'Flat No. 1203 available',
    'A-1203 sea facing',
    'B wing, high floor',
    'Shop 5 on ground',
    'Office #804',
  ])('wing/unit: %s', (t) => {
    expect(kinds(t)).toContain('wing_unit');
  });

  it.each(['on the 12th floor', 'floor no. 14 of 20'])('exact floor: %s', (t) => {
    expect(kinds(t)).toContain('exact_floor');
  });

  it.each(['Plot No. 45 near the station', 'Survey no 112', '14 Hill Road bungalow', 'CTS 334'])(
    'street: %s',
    (t) => {
      expect(kinds(t)).toContain('street_address');
    },
  );

  it('returns offsets into the original text, never the matched value', () => {
    const text = 'Sea facing flat. Call nine zero zero zero zero one two three four five today';
    const f = scanText({ text }).find((x) => x.kind === 'phone');
    expect(f).toBeDefined();
    expect(text.slice(f?.start, f?.end)).toMatch(/^nine .* five$/);
    expect(Object.keys(f ?? {})).not.toContain('value');
  });
});

describe('what passes', () => {
  it.each([
    'Rent ₹45,000 per month, deposit negotiable',
    'Price Rs 12500000/- all inclusive',
    'Area 2000-2500 sq ft carpet',
    'Possession 2027-06-01, construction 2025-2027',
    'Mid floor band, 2 BHK apartment near the station',
    '1,203 sq ft in Andheri West with gym and pool',
  ])('%s', (text) => {
    expect(kinds(text)).toEqual([]);
  });

  it('allows the agent and project RERA numbers only when they are the configured ids', () => {
    expect(kinds('MahaRERA A51900012345, project P51800012345', ['A51900012345', 'P51800012345'])).toEqual(
      [],
    );
    expect(kinds('reg P59000012345')).toContain('phone');
  });

  it('generated descriptions and headlines pass by construction', () => {
    const samples = [
      offer(),
      offer({
        dealType: 'Sale',
        market: 'Secondary',
        salePriceInrMin: 1_25_00_000,
        salePriceInrMax: 1_40_00_000,
        rentMonthlyInrMin: null,
        rentMonthlyInrMax: null,
      }),
      offer({
        propertyTypes: ['Office'],
        segment: 'Commercial',
        bhkMin: null,
        bhkMax: null,
        areaSqftMin: 1200,
        areaSqftMax: 1500,
        locality: 'SV Road',
      }),
      offer({
        propertyTypes: ['Plot'],
        segment: 'Land',
        landAreaSqft: 43560,
        bhkMin: null,
        bhkMax: null,
        dealType: 'JV',
      }),
      offer({
        bhkMin: 0.5,
        bhkMax: 0.5,
        propertyTypes: ['Studio'],
        possessionDate: '2027-06',
        possessionStatus: 'Under Construction',
      }),
    ];
    for (const o of samples) {
      expect(kinds(generatedDescription(o))).toEqual([]);
      expect(kinds(headline({ ...o, label: 'For Rent' }))).toEqual([]);
    }
  });
});

describe('private terms (R-20)', () => {
  const hasher = hmacTermHasher('unit-test-salt');
  const matched = (entries: [string, TermKind][]) => new Map(entries.map(([t, k]) => [hasher.hash(t), k]));
  const run = (text: string, terms: [string, TermKind][], allow: (string | null)[] = []) =>
    termFindings(candidateGrams(text), matched(terms), hasher.hash, allowListOf(allow)).map((f) => f.kind);

  it('blocks multi-word building names in spaced or joined form', () => {
    expect(run('Lovely flat in Sea Breeze Tower, Bandra', [['sea breeze', 'building']])).toEqual([
      'building_name',
    ]);
    expect(run('Lovely flat in SeaBreeze', [['seabreeze', 'building']])).toEqual(['building_name']);
  });

  it('single tokens count only with ≥ 6 characters and when not on the allow-list', () => {
    expect(run('near the sea', [['sea', 'building']])).toEqual([]);
    expect(run('breeze heights view', [['breeze', 'building']])).toEqual(['building_name']);
    expect(run('flat in Powai', [['powai', 'building']], ['Powai'])).toEqual([]);
  });

  it('wing/unit terms match numbered tokens', () => {
    expect(run('unit b 1203 is ready', [['b 1203', 'unit']])).toEqual(['wing_unit']);
    expect(run('only 1203 left', [['1203', 'unit']])).toEqual(['wing_unit']);
    expect(run('wing a', [['a', 'wing']])).toEqual([]);
  });
});

describe('normalisation and outcome', () => {
  it('maps number words with offsets', () => {
    const n = normaliseForDigits('double nine');
    expect(n.text).toBe('99');
    expect(n.map[0]).toEqual([0, 11]);
  });

  it('photo text is a warning only (R-8)', () => {
    const findings = scanText({ text: 'Nice flat', photoTextIds: ['00000000-0000-4000-8000-000000000001'] });
    expect(findings).toEqual([
      {
        kind: 'photo_text',
        severity: 'warn',
        field: 'photo',
        photoId: '00000000-0000-4000-8000-000000000001',
      },
    ]);
    expect(outcomeOf(findings)).toBe('warning');
    expect(outcomeOf([])).toBe('pass');
  });
});
