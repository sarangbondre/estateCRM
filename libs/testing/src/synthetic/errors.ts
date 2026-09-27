/**
 * Error injection for rejection-path tests. Each injected row carries exactly one strict-mode row
 * error (intake LLD §4.4, `RowError.code`). Vocabulary errors are checked with `@11e/vocabulary`
 * after the mutation, so the manifest never counts an error intake would not raise.
 */
import {
  PROPERTY_TYPES_BY_SEGMENT,
  SEGMENTS,
  parseValue,
  validateClassification,
  type Segment,
  type VocabularyIssueCode,
} from '@11e/vocabulary';
import type { ExtractorColumn, ExtractorRow } from './columns.js';
import type { InjectedErrorCode } from './options.js';
import type { Rng } from './rng.js';

export interface InjectedIssue<C extends string> {
  readonly code: C;
  readonly column: ExtractorColumn;
}

type Mutation = (row: ExtractorRow, rng: Rng, fileIds: readonly string[]) => ExtractorColumn | null;

const CLASSIFICATION_COLUMNS: readonly ExtractorColumn[] = [
  'record_scope',
  'deal_type',
  'market',
  'segment',
  'property_type',
  'land_use',
  'side',
];

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function classificationIssues(row: ExtractorRow): readonly VocabularyIssueCode[] {
  const result = validateClassification({
    recordScope: str(row.record_scope),
    dealType: str(row.deal_type),
    market: str(row.market),
    segment: str(row.segment),
    propertyType: str(row.property_type),
    landUse: str(row.land_use),
    side: str(row.side),
  });
  return result.ok ? [] : result.issues.map((i) => i.code);
}

/** Makes the row a plain Property / Supply / Residential Apartment Sale so a mutation hits one rule. */
function resetToProperty(row: ExtractorRow): void {
  row.record_scope = 'Property';
  row.deal_type = 'Sale';
  row.market = null;
  row.segment = 'Residential';
  row.property_type = 'Apartment';
  row.land_use = null;
  row.side = 'Supply';
}

const VALUE_NOT_IN_LIST: readonly (readonly [ExtractorColumn, string])[] = [
  ['segment', 'Residental'],
  ['deal_type', 'Sale|Rent'],
  ['record_scope', 'Properties'],
  ['side', 'Seller'],
  ['furnishing', 'Semi-Furnished'],
  ['party_type', 'Builder'],
  ['area_basis', 'Super Builtup'],
  ['source_channel', 'Email'],
  ['possession_status', 'Ready to move'],
];

const MUTATIONS: { readonly [C in InjectedErrorCode]: Mutation } = {
  'value-not-in-list': (row, rng) => {
    const [column, value] = rng.pick(VALUE_NOT_IN_LIST);
    row[column] = value;
    return column;
  },
  'scope-deal-type-mismatch': (row) => {
    resetToProperty(row);
    row.deal_type = 'Equity';
    return 'deal_type';
  },
  'segment-property-type-mismatch': (row, rng) => {
    resetToProperty(row);
    const segment = rng.pick(SEGMENTS);
    const other = rng.pick(SEGMENTS.filter((s) => s !== segment)) as Segment;
    row.segment = segment;
    row.property_type = rng.pick(PROPERTY_TYPES_BY_SEGMENT[other]);
    return 'property_type';
  },
  'market-on-non-sale': (row, rng) => {
    resetToProperty(row);
    row.deal_type = rng.pick(['Lease', 'JV']);
    row.market = rng.pick(['Primary', 'Secondary']);
    return 'market';
  },
  'side-scope-mismatch': (row) => {
    const scope = row.record_scope;
    if (scope === 'Market Participant' || scope === 'Market Signal') row.side = 'Supply';
    else {
      resetToProperty(row);
      row.side = 'None';
    }
    return 'side';
  },
  'required-missing': (row) => {
    row.record_id = null;
    return 'record_id';
  },
  'invalid-type': (row, rng) => {
    const choice = rng.int(0, 3);
    if (choice === 0) {
      row.record_id = `REC-${rng.int(10_000_000, 99_999_999)}`;
      return 'record_id';
    }
    if (choice === 1) {
      row.bhk_min = 'three';
      return 'bhk_min';
    }
    if (choice === 2) {
      row.times_seen = 'twice';
      return 'times_seen';
    }
    row.needs_review = 'maybe';
    return 'needs_review';
  },
  'invalid-date': (row, rng) => {
    const choice = rng.int(0, 2);
    if (choice === 0) {
      row.source_date = '2026-02-30';
      return 'source_date';
    }
    if (choice === 1) {
      row.first_seen_date = '31-13-2026';
      return 'first_seen_date';
    }
    row.last_seen_date = 'next Monday';
    return 'last_seen_date';
  },
  'range-inverted': (row, rng) => {
    const pairs = [
      ['area_sqft_min', 'area_sqft_max'],
      ['sale_price_inr_min', 'sale_price_inr_max'],
      ['rent_monthly_inr_min', 'rent_monthly_inr_max'],
      ['bhk_min', 'bhk_max'],
    ] as const;
    const usable = pairs.filter(([a, b]) => typeof row[a] === 'number' && typeof row[b] === 'number');
    const pair = usable.length > 0 ? rng.pick(usable) : null;
    if (pair === null) {
      row.area_sqft_min = 1500;
      row.area_sqft_max = 900;
      return 'area_sqft_min';
    }
    const [a, b] = pair;
    const max = row[b] as number;
    row[a] = max * 2 + 10;
    return a;
  },
  'duplicate-external-ref': (row, rng, fileIds) => {
    if (fileIds.length === 0) return null;
    row.record_id = rng.pick(fileIds);
    return 'record_id';
  },
};

const VOCABULARY_CODES: ReadonlySet<InjectedErrorCode> = new Set<InjectedErrorCode>([
  'value-not-in-list',
  'scope-deal-type-mismatch',
  'segment-property-type-mismatch',
  'market-on-non-sale',
  'side-scope-mismatch',
]);

/** Checks that the mutated row raises exactly the intended vocabulary error. */
function verify(row: ExtractorRow, code: InjectedErrorCode, column: ExtractorColumn): boolean {
  if (!VOCABULARY_CODES.has(code)) return true;
  if (CLASSIFICATION_COLUMNS.includes(column) || code !== 'value-not-in-list') {
    const issues = classificationIssues(row);
    return issues.length > 0 && issues.every((i) => i === code);
  }
  const result = parseValue(column as Parameters<typeof parseValue>[0], str(row[column]));
  return !result.ok && classificationIssues(row).length === 0;
}

/**
 * Applies one error to `row` (in place) and returns it. `duplicate-external-ref` needs an earlier
 * record_id of the same file; without one, another code from `codes` is used.
 */
export function injectError(
  row: ExtractorRow,
  rng: Rng,
  codes: readonly InjectedErrorCode[],
  fileIds: readonly string[],
): InjectedIssue<InjectedErrorCode> {
  let code = rng.pick(codes);
  if (code === 'duplicate-external-ref' && fileIds.length === 0) {
    const others = codes.filter((c) => c !== 'duplicate-external-ref');
    code = others.length > 0 ? rng.pick(others) : 'required-missing';
  }
  const column = MUTATIONS[code](row, rng, fileIds);
  if (column === null || !verify(row, code, column)) {
    throw new Error(`generator bug: injected ${code} on ${String(column)} is not detected as such`);
  }
  return { code, column };
}
