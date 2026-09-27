import {
  FIELDS,
  VOCABULARY_FIELDS,
  parseField,
  routeFor,
  validateClassification,
  type RecordScope,
  type Side,
} from '@11e/vocabulary';
import { describe, expect, it } from 'vitest';
import {
  EXTRACTOR_COLUMNS,
  INJECTED_ERROR_CODES,
  ManifestBuilder,
  SyntheticGenerator,
  generate,
  resolveOptions,
  type ExtractorRow,
  type SyntheticRecord,
} from '../src/index.js';

const HEX12 = /^[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in ISO form (Date.parse accepts 2026-02-30, so compare back). */
function isCalendarDate(value: string): boolean {
  if (!ISO.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Every vocabulary check intake strict mode runs (intake LLD §4.4). Returns problems found. */
function vocabularyProblems(row: ExtractorRow): string[] {
  const problems: string[] = [];
  for (const field of VOCABULARY_FIELDS) {
    const result = parseField(field, str(row[field]));
    if (!result.ok) problems.push(`${field}: ${JSON.stringify(result.issues)}`);
  }
  const classification = validateClassification({
    recordScope: str(row.record_scope),
    dealType: str(row.deal_type),
    market: str(row.market),
    segment: str(row.segment),
    propertyType: str(row.property_type),
    landUse: str(row.land_use),
    side: str(row.side),
  });
  if (!classification.ok) problems.push(`classification: ${JSON.stringify(classification.issues)}`);
  return problems;
}

function typeProblems(row: ExtractorRow): string[] {
  const problems: string[] = [];
  if (typeof row.record_id !== 'string' || !HEX12.test(row.record_id)) problems.push('record_id');
  for (const column of ['parent_record_id', 'possible_repeat_of'] as const) {
    if (row[column] !== null && !HEX12.test(String(row[column]))) problems.push(column);
  }
  for (const column of ['needs_review', 'price_negotiable', 'is_jodi', 'ocr_used'] as const) {
    if (row[column] !== null && typeof row[column] !== 'boolean') problems.push(column);
  }
  for (const column of [
    'sale_price_inr_min',
    'sale_price_inr_max',
    'sale_rate_inr',
    'rent_monthly_inr_min',
    'rent_monthly_inr_max',
    'deposit_inr',
    'deposit_months',
    'current_rent_inr',
    'times_seen',
    'source_page',
  ] as const) {
    if (row[column] !== null && !Number.isInteger(row[column])) problems.push(column);
  }
  for (const column of [
    'bhk_min',
    'bhk_max',
    'area_sqft_min',
    'area_sqft_max',
    'land_area_value',
    'yield_pct',
  ] as const) {
    if (row[column] !== null && typeof row[column] !== 'number') problems.push(column);
  }
  for (const [min, max] of [
    ['bhk_min', 'bhk_max'],
    ['area_sqft_min', 'area_sqft_max'],
    ['sale_price_inr_min', 'sale_price_inr_max'],
    ['rent_monthly_inr_min', 'rent_monthly_inr_max'],
  ] as const) {
    const a = row[min];
    const b = row[max];
    if (typeof a === 'number' && typeof b === 'number' && a > b) problems.push(`${min}>${max}`);
  }
  for (const column of ['source_date', 'first_seen_date', 'last_seen_date', 'deadline_date'] as const) {
    const value = row[column];
    if (value !== null && (typeof value !== 'string' || !isCalendarDate(value))) {
      problems.push(column);
    }
  }
  if (row.possession_date !== null && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(row.possession_date))) {
    problems.push('possession_date');
  }
  const confidence = row.extraction_confidence;
  if (confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    problems.push('extraction_confidence');
  }
  return problems;
}

const SAMPLE = generate({ rows: 20_000, seed: 7 });
const SAMPLE_ROWS = SAMPLE.map((r) => r.row);

describe('determinism', () => {
  it('same options give identical rows and metadata', () => {
    const a = generate({ rows: 3_000, seed: 42, errorRate: 0.05, invalidPhoneRate: 0.01 });
    const b = generate({ rows: 3_000, seed: 42, errorRate: 0.05, invalidPhoneRate: 0.01 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a different seed gives different rows', () => {
    const a = generate({ rows: 200, seed: 1 });
    const b = generate({ rows: 200, seed: 2 });
    expect(JSON.stringify(a.map((r) => r.row))).not.toBe(JSON.stringify(b.map((r) => r.row)));
  });

  it('error injection does not change the base data stream', () => {
    const clean = generate({ rows: 2_000, seed: 9 });
    const dirty = generate({ rows: 2_000, seed: 9, errorRate: 0.1 });
    // Errors use their own random stream: new-ad rows are identical; only error rows and
    // repeats (whose source may have been an error row) differ.
    dirty.forEach((r, i) => {
      const c = clean[i];
      if (r.meta.error === null && r.meta.kind !== 'repeat' && c?.meta.kind !== 'repeat') {
        expect(r.row).toEqual(c?.row);
      }
    });
  });

  it('yields exactly the requested number of rows, including zero', () => {
    expect(generate({ rows: 0, seed: 1 })).toHaveLength(0);
    expect(generate({ rows: 1, seed: 1 })).toHaveLength(1);
    expect(generate({ rows: 1_234, seed: 3 })).toHaveLength(1_234);
  });
});

describe('every loadable row is valid', () => {
  it('rows hold exactly the 89 columns in schema order', () => {
    for (const row of SAMPLE_ROWS.slice(0, 500)) expect(Object.keys(row)).toEqual([...EXTRACTOR_COLUMNS]);
  });

  it('passes @11e/vocabulary strict validation (fields and cross-field rules)', () => {
    const bad = SAMPLE_ROWS.map((row) => vocabularyProblems(row)).filter((p) => p.length > 0);
    expect(bad).toEqual([]);
  });

  it('covers every controlled field with at least one value', () => {
    const unused = VOCABULARY_FIELDS.filter((field) => !SAMPLE_ROWS.some((row) => row[field] !== null));
    expect(unused).toEqual([]);
    expect(Object.keys(FIELDS).length).toBe(23);
  });

  it('route_to is the scope/side destination', () => {
    for (const row of SAMPLE_ROWS) {
      expect(row.route_to).toBe(routeFor(row.record_scope as RecordScope, (row.side as Side | null) ?? null));
    }
  });

  it('types, ranges and dates are well formed', () => {
    const bad = SAMPLE_ROWS.map((row) => [row.record_id, typeProblems(row)] as const).filter(
      ([, p]) => p.length > 0,
    );
    expect(bad).toEqual([]);
    for (const row of SAMPLE_ROWS) {
      const first = String(row.first_seen_date);
      const last = String(row.last_seen_date);
      expect(first >= '2026-05-01' && last <= '2026-09-24' && first <= last).toBe(true);
      expect(row.source_date).toBe(row.first_seen_date);
    }
  });

  it('record_ids are unique; split children are consecutive and numbered "k of n"', () => {
    const ids = new Set(SAMPLE_ROWS.map((r) => r.record_id));
    expect(ids.size).toBe(SAMPLE_ROWS.length);
    let i = 0;
    while (i < SAMPLE_ROWS.length) {
      const row = SAMPLE_ROWS[i] as ExtractorRow;
      if (row.parent_record_id === null) {
        expect(row.split_index).toBeNull();
        i += 1;
        continue;
      }
      const match = /^1 of (\d+)$/.exec(String(row.split_index));
      expect(match).not.toBeNull();
      const n = Number(match?.[1]);
      for (let k = 1; k <= n; k += 1) {
        const child = SAMPLE_ROWS[i + k - 1] as ExtractorRow;
        expect(child.parent_record_id).toBe(row.parent_record_id);
        expect(child.split_index).toBe(`${k} of ${n}`);
        expect(child.raw_text).toBe(row.raw_text);
        expect(ids.has(String(child.parent_record_id))).toBe(false);
      }
      i += n;
    }
  });

  it('possible_repeat_of points at an earlier record of the dataset', () => {
    const seen = new Set<string>();
    let repeats = 0;
    for (const { row, meta } of SAMPLE) {
      if (row.possible_repeat_of !== null) {
        repeats += 1;
        expect(seen.has(String(row.possible_repeat_of))).toBe(true);
        expect(meta.kind).toBe('repeat');
        expect(meta.repeatOf).toBe(row.possible_repeat_of);
      }
      seen.add(String(row.record_id));
    }
    expect(repeats).toBeGreaterThan(0);
  });

  it('raw_text reflects the structured fields', () => {
    for (const row of SAMPLE_ROWS.slice(0, 3_000)) {
      const text = String(row.raw_text);
      if (
        typeof row.locality === 'string' &&
        row.parent_record_id === null &&
        row.record_scope === 'Property'
      ) {
        expect(text).toContain(row.locality);
      }
      if (row.side === 'Demand' && row.record_scope === 'Property') expect(text).toMatch(/WANT/);
      if (row.sale_mode === 'Auction') expect(text).toContain('AUCTION');
      if (typeof row.company_name === 'string') expect(text).toContain(row.company_name);
    }
  });
});

/**
 * Proportions from docs/inputs/extractor-master-profile.md (2,155 records), transcribed here
 * independently of src/synthetic/profile.ts. Tolerances are in percentage points for 20k rows.
 */
describe('distributions match the extractor profile', () => {
  const n = SAMPLE_ROWS.length;
  const share = (predicate: (row: ExtractorRow) => boolean): number =>
    (100 * SAMPLE_ROWS.filter(predicate).length) / n;
  const cases: [string, (row: ExtractorRow) => boolean, number, number][] = [
    ['record_scope Property', (r) => r.record_scope === 'Property', (100 * 2044) / 2155, 1.5],
    [
      'record_scope Market Participant',
      (r) => r.record_scope === 'Market Participant',
      (100 * 43) / 2155,
      0.8,
    ],
    ['record_scope Business', (r) => r.record_scope === 'Business', (100 * 37) / 2155, 0.8],
    ['side Supply', (r) => r.side === 'Supply', (100 * 2027) / 2155, 2],
    ['side Demand', (r) => r.side === 'Demand', (100 * 55) / 2155, 1],
    ['side None', (r) => r.side === 'None', (100 * 49) / 2155, 0.8],
    ['deal_type Sale', (r) => r.deal_type === 'Sale', (100 * 1415) / 2155, 3],
    ['deal_type Lease', (r) => r.deal_type === 'Lease', (100 * 383) / 2155, 2],
    ['deal_type Sale|Lease', (r) => r.deal_type === 'Sale|Lease', (100 * 165) / 2155, 1.5],
    ['deal_type blank', (r) => r.deal_type === null, 5, 1.5],
    ['market blank', (r) => r.market === null, 69, 3],
    ['market Secondary', (r) => r.market === 'Secondary', (100 * 541) / 2155, 3],
    ['market Primary', (r) => r.market === 'Primary', (100 * 111) / 2155, 1.5],
    ['segment Residential', (r) => r.segment === 'Residential', (100 * 1152) / 2155, 3],
    ['segment Commercial', (r) => r.segment === 'Commercial', (100 * 543) / 2155, 3],
    ['segment Land', (r) => r.segment === 'Land', (100 * 226) / 2155, 2],
    ['segment Industrial', (r) => r.segment === 'Industrial', (100 * 93) / 2155, 1.5],
    ['property_type Apartment', (r) => r.property_type === 'Apartment', (100 * 991) / 2155, 4],
    ['needs_review', (r) => r.needs_review === true, (100 * 766) / 2155, 4],
    ['split children', (r) => r.parent_record_id !== null, 34, 3],
    ['possible_repeat_of', (r) => r.possible_repeat_of !== null, 13, 2],
    ['times_seen 1', (r) => r.times_seen === 1, (100 * 1865) / 2155, 4],
    ['area filled', (r) => r.area_sqft_min !== null, 50, 5],
    ['area_basis filled', (r) => r.area_basis !== null, 19, 3],
    ['bhk filled', (r) => r.bhk_min !== null, 40, 6],
    ['land area filled', (r) => r.land_area_value !== null, 10, 2],
    ['sale price filled', (r) => r.sale_price_inr_min !== null, 29, 4],
    ['rent filled', (r) => r.rent_monthly_inr_min !== null, 5, 2],
    ['sale_mode Auction', (r) => r.sale_mode === 'Auction', 6, 2],
    ['party_type filled', (r) => r.party_type !== null, 37, 4],
    ['phones filled', (r) => r.phones !== null, 93, 2],
    ['contact_name filled', (r) => r.contact_name !== null, 26, 4],
    ['emails filled', (r) => r.emails !== null, 9, 2],
    ['city filled', (r) => r.city !== null, 85, 3],
    ['state filled', (r) => r.state !== null, 90, 3],
    ['locality filled', (r) => r.locality !== null, 79, 3],
    ['possession_status filled', (r) => r.possession_status !== null, 16, 3],
    ['furnishing filled', (r) => r.furnishing !== null, 12, 3],
    ['project_name filled', (r) => r.project_name !== null, 16, 3],
    ['ocr_used', (r) => r.ocr_used === true, (100 * 1868) / 2155, 3],
    ['source_channel Newspaper', (r) => r.source_channel === 'Newspaper', 100, 0],
    ['source_name Times of India', (r) => r.source_name === 'Times of India', (100 * 1323) / 2155, 3],
  ];
  it.each(cases)('%s', (_name, predicate, expected, tolerance) => {
    expect(Math.abs(share(predicate) - expected)).toBeLessThanOrEqual(tolerance);
  });

  it('about 60% of rows with an area have a blank area_basis', () => {
    const withArea = SAMPLE_ROWS.filter((r) => r.area_sqft_min !== null);
    const blank = (100 * withArea.filter((r) => r.area_basis === null).length) / withArea.length;
    expect(Math.abs(blank - 62)).toBeLessThanOrEqual(5);
  });

  it('outside-MMR share among located rows is 228 / 1,821', () => {
    const located = SAMPLE.filter((r) => r.meta.outsideMmr !== null);
    const outside = located.filter((r) => r.meta.outsideMmr === true).length;
    expect(Math.abs((100 * outside) / located.length - (100 * 228) / 1821)).toBeLessThanOrEqual(1.5);
  });

  it('the knobs move the distributions', () => {
    const rows = generate({
      rows: 5_000,
      seed: 5,
      splitRate: 0,
      repeatRate: 0,
      outsideMmrRate: 0,
      whatsappRate: 1,
    });
    expect(rows.every((r) => r.row.parent_record_id === null && r.row.possible_repeat_of === null)).toBe(
      true,
    );
    expect(rows.every((r) => r.meta.outsideMmr !== true)).toBe(true);
    expect(rows.every((r) => r.row.source_channel === 'WhatsApp' && r.row.ocr_used === false)).toBe(true);
    expect(rows.some((r) => r.row.sender_phone !== null)).toBe(true);
    const narrow = generate({ rows: 500, seed: 5, dateFrom: '2026-07-01', dateTo: '2026-07-07' });
    expect(
      narrow.every(
        (r) => String(r.row.source_date) >= '2026-07-01' && String(r.row.last_seen_date) <= '2026-07-07',
      ),
    ).toBe(true);
    const unflagged = generate({ rows: 3_000, seed: 5, repeatRate: 0.2, flaggedRepeatShare: 0 });
    expect(unflagged.filter((r) => r.meta.kind === 'repeat').length).toBeGreaterThan(300);
    expect(unflagged.every((r) => r.row.possible_repeat_of === null)).toBe(true);
  });
});

describe('error injection and the manifest', () => {
  const options = { rows: 10_000, seed: 11, errorRate: 0.05, invalidPhoneRate: 0.01 };
  const records: SyntheticRecord[] = generate(options);

  function manifestOf(list: readonly SyntheticRecord[]) {
    const builder = new ManifestBuilder(resolveOptions(options));
    for (const record of list) builder.add(record);
    return builder.build([]);
  }

  it('each error row carries exactly one intended strict-mode error and all codes occur', () => {
    const errors = records.filter((r) => r.meta.error !== null);
    expect(Math.abs(errors.length / records.length - 0.05)).toBeLessThan(0.01);
    const codes = new Set(errors.map((r) => r.meta.error?.code));
    expect([...codes].sort()).toEqual([...INJECTED_ERROR_CODES].sort());
    for (const { row, meta } of errors) {
      const code = meta.error?.code;
      const vocab = vocabularyProblems(row);
      if (
        code === 'value-not-in-list' ||
        code === 'scope-deal-type-mismatch' ||
        code === 'segment-property-type-mismatch' ||
        code === 'market-on-non-sale' ||
        code === 'side-scope-mismatch'
      ) {
        expect(vocab.length).toBeGreaterThan(0);
        expect(vocab.join(' ')).toContain(code === 'value-not-in-list' ? 'value-not-in-list' : code);
      } else {
        expect(vocab).toEqual([]);
        if (code === 'required-missing') expect(row.record_id).toBeNull();
        if (code === 'range-inverted') expect(typeProblems(row).some((p) => p.includes('>'))).toBe(true);
        if (code === 'invalid-type' || code === 'invalid-date')
          expect(typeProblems(row).length).toBeGreaterThan(0);
      }
    }
  });

  it('duplicate-external-ref reuses a record_id loaded earlier in the same file', () => {
    const loaded = new Set<string>();
    for (const { row, meta } of records) {
      if (meta.error?.code === 'duplicate-external-ref') expect(loaded.has(String(row.record_id))).toBe(true);
      else if (meta.error === null) loaded.add(String(row.record_id));
    }
  });

  it('loadable rows stay valid and unique when errors are injected', () => {
    const loadable = records.filter((r) => r.meta.error === null);
    expect(loadable.flatMap((r) => vocabularyProblems(r.row))).toEqual([]);
    expect(new Set(loadable.map((r) => r.row.record_id)).size).toBe(loadable.length);
  });

  it('manifest counts equal the injected errors, warnings and review rows', () => {
    const manifest = manifestOf(records);
    const errors = records.filter((r) => r.meta.error !== null);
    expect(manifest.totals.rows).toBe(records.length);
    expect(manifest.totals.rejected).toBe(errors.length);
    expect(manifest.totals.loaded).toBe(records.length - errors.length);
    for (const code of INJECTED_ERROR_CODES) {
      expect(manifest.errors[code]).toBe(errors.filter((r) => r.meta.error?.code === code).length);
    }
    const warnings = records.filter((r) => r.meta.warning !== null);
    expect(manifest.warnings['invalid-phone']).toBe(warnings.length);
    expect(warnings.every((r) => r.meta.error === null)).toBe(true);
    const review = records.filter(
      (r) =>
        r.meta.error === null &&
        (r.row.needs_review === true ||
          (r.row.side === null &&
            !['Market Participant', 'Market Signal'].includes(String(r.row.record_scope)))),
    );
    expect(manifest.totals.needsReview).toBe(review.length);
    const scopes = Object.values(manifest.classification.recordScope).reduce((a, b) => a + b, 0);
    expect(scopes).toBe(manifest.totals.loaded);
    expect(manifest.totals.splitChildren).toBe(records.filter((r) => r.row.parent_record_id !== null).length);
    expect(manifest.totals.repeats).toBe(records.filter((r) => r.meta.kind === 'repeat').length);
    expect(manifest.mode).toBe('strict');
    expect(manifest.columns).toHaveLength(89);
  });

  it('restricting error codes injects only those codes', () => {
    const only = generate({
      rows: 2_000,
      seed: 4,
      errorRate: 0.2,
      errorCodes: ['range-inverted', 'invalid-date'],
    });
    const codes = new Set(only.flatMap((r) => (r.meta.error === null ? [] : [r.meta.error.code])));
    expect([...codes].sort()).toEqual(['invalid-date', 'range-inverted']);
  });

  it('rejects invalid options', () => {
    expect(() => new SyntheticGenerator({ rows: -1 })).toThrow(RangeError);
    expect(() => new SyntheticGenerator({ rows: 10, errorRate: 1.5 })).toThrow(RangeError);
    expect(() => new SyntheticGenerator({ rows: 10, dateFrom: '2026-09-01', dateTo: '2026-08-01' })).toThrow(
      RangeError,
    );
    expect(() => new SyntheticGenerator({ rows: 10, people: 3_000_000 })).toThrow(RangeError);
  });
});
