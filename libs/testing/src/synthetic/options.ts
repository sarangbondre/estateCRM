/** Generator knobs, defaults (from the extractor profile) and validation. */
import { MAX_PEOPLE } from './contacts.js';
import type { ExtractorColumn } from './columns.js';
import { EXTRACTOR_COLUMNS, LEGACY_OMITTED_COLUMNS } from './columns.js';
import { daysBetween, parseIsoDate } from './format.js';

/** Row error codes the generator can inject (intake `RowError.code` values, rejected in strict mode). */
export const INJECTED_ERROR_CODES = [
  'value-not-in-list',
  'scope-deal-type-mismatch',
  'segment-property-type-mismatch',
  'market-on-non-sale',
  'side-scope-mismatch',
  'required-missing',
  'invalid-type',
  'invalid-date',
  'range-inverted',
  'duplicate-external-ref',
] as const;
export type InjectedErrorCode = (typeof INJECTED_ERROR_CODES)[number];

/** Row warning codes (row still loads). */
export const INJECTED_WARNING_CODES = ['invalid-phone'] as const;
export type InjectedWarningCode = (typeof INJECTED_WARNING_CODES)[number];

export interface SyntheticOptions {
  /** Number of data rows. */
  readonly rows: number;
  /** Same seed → byte-identical output. */
  readonly seed: number;
  /** Share of rows with exactly one injected strict-mode error (rejected by intake). Default 0. */
  readonly errorRate: number;
  /** Error codes to inject, chosen uniformly. Default: all. */
  readonly errorCodes: readonly InjectedErrorCode[];
  /** Share of rows with an unparseable phone (warning `invalid-phone`, row loads). Default 0. */
  readonly invalidPhoneRate: number;
  /** Share of rows that re-post an earlier ad under a new record_id. Default 0.13 (profile: possible_repeat_of 13%). */
  readonly repeatRate: number;
  /** Share of those repeats that carry `possible_repeat_of` (the rest are unflagged exact re-posts). Default 1. */
  readonly flaggedRepeatShare: number;
  /** Share of rows that are split children (parent_record_id + split_index). Default 0.34. */
  readonly splitRate: number;
  /** Share of located rows outside the MMR. Default 0.125 (profile: 228 / 1,821). */
  readonly outsideMmrRate: number;
  /** Share of ads from the WhatsApp extractor. Default 0 (the profiled file is newspaper only). */
  readonly whatsappRate: number;
  /** First source date (ISO). */
  readonly dateFrom: string;
  /** Last source date (ISO, inclusive). */
  readonly dateTo: string;
  /** Contacts in the anonymised form intake writes when its pilot anonymise switch is on. */
  readonly anonymised: boolean;
  /** Size of the synthetic people pool. Default rows / 5 (capacity plan: 5M records, 1M people). */
  readonly people: number;
  /**
   * Rows per output file. Split ads never straddle files, and `duplicate-external-ref` errors
   * only point at record_ids of the same file. Default: all rows in one file.
   */
  readonly rowsPerFile: number;
  /**
   * Columns left out of the header. The file then reads as mapping mode, except when only `building_name` and
   * `floor` are left out (the legacy 89-column header, still strict, CR-012). Default none.
   */
  readonly omitColumns: readonly ExtractorColumn[];
  /** Emit the legacy 89-column header of older extractor versions (adds building_name, floor to omitColumns). */
  readonly legacyHeader: boolean;
}

export const DEFAULT_DATE_FROM = '2026-05-01';
export const DEFAULT_DATE_TO = '2026-09-24';

export function resolveOptions(
  input: Partial<SyntheticOptions> & { readonly rows: number },
): SyntheticOptions {
  const rows = input.rows;
  const options: SyntheticOptions = {
    rows,
    seed: input.seed ?? 1,
    errorRate: input.errorRate ?? 0,
    errorCodes: input.errorCodes ?? INJECTED_ERROR_CODES,
    invalidPhoneRate: input.invalidPhoneRate ?? 0,
    repeatRate: input.repeatRate ?? 0.13,
    flaggedRepeatShare: input.flaggedRepeatShare ?? 1,
    splitRate: input.splitRate ?? 0.34,
    outsideMmrRate: input.outsideMmrRate ?? 0.125,
    whatsappRate: input.whatsappRate ?? 0,
    dateFrom: input.dateFrom ?? DEFAULT_DATE_FROM,
    dateTo: input.dateTo ?? DEFAULT_DATE_TO,
    anonymised: input.anonymised ?? false,
    people: input.people ?? Math.min(MAX_PEOPLE, Math.max(50, Math.ceil(rows / 5))),
    rowsPerFile: input.rowsPerFile ?? Math.max(1, rows),
    omitColumns: [
      ...new Set([...(input.omitColumns ?? []), ...(input.legacyHeader ? LEGACY_OMITTED_COLUMNS : [])]),
    ],
    legacyHeader: input.legacyHeader ?? false,
  };
  validateOptions(options);
  return options;
}

function assertRate(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError(`${name} must be in [0, 1], got ${value}`);
}

function validateOptions(o: SyntheticOptions): void {
  if (!Number.isInteger(o.rows) || o.rows < 0)
    throw new RangeError(`rows must be a non-negative integer, got ${o.rows}`);
  if (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff) {
    throw new RangeError(`seed must be an integer in [0, 2^32), got ${o.seed}`);
  }
  assertRate('errorRate', o.errorRate);
  assertRate('invalidPhoneRate', o.invalidPhoneRate);
  assertRate('repeatRate', o.repeatRate);
  assertRate('flaggedRepeatShare', o.flaggedRepeatShare);
  assertRate('splitRate', o.splitRate);
  assertRate('outsideMmrRate', o.outsideMmrRate);
  assertRate('whatsappRate', o.whatsappRate);
  if (o.splitRate > 0.9) throw new RangeError('splitRate must be ≤ 0.9');
  if (o.errorRate + o.invalidPhoneRate > 1) throw new RangeError('errorRate + invalidPhoneRate must be ≤ 1');
  if (o.errorRate > 0 && o.errorCodes.length === 0) throw new RangeError('errorCodes is empty');
  for (const code of o.errorCodes) {
    if (!(INJECTED_ERROR_CODES as readonly string[]).includes(code))
      throw new RangeError(`unknown error code ${code}`);
  }
  parseIsoDate(o.dateFrom);
  parseIsoDate(o.dateTo);
  if (daysBetween(o.dateFrom, o.dateTo) < 0) throw new RangeError('dateFrom must not be after dateTo');
  if (!Number.isInteger(o.people) || o.people < 1 || o.people > MAX_PEOPLE) {
    throw new RangeError(`people must be an integer in [1, ${MAX_PEOPLE}], got ${o.people}`);
  }
  if (!Number.isInteger(o.rowsPerFile) || o.rowsPerFile < 1) throw new RangeError('rowsPerFile must be ≥ 1');
  for (const column of o.omitColumns) {
    if (!(EXTRACTOR_COLUMNS as readonly string[]).includes(column))
      throw new RangeError(`unknown column ${column}`);
  }
}
