/**
 * R-11 matching key (conventions §10): controlled values match after trimming and case-folding.
 * Runs of whitespace inside the value are collapsed to one space (same rule as the intake
 * `legacy_terms.term_norm` column: "lower-case, trimmed, single-spaced").
 */
export function matchKey(raw: string): string {
  return raw.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Blank means unknown (BRD §4.2): null, undefined, empty or whitespace only. */
export function isBlank(raw: string | null | undefined): boolean {
  return raw === null || raw === undefined || raw.trim() === '';
}

/** Pipe-list separator for multi-valued fields (deal_type, property_type). */
export const LIST_SEPARATOR = '|';

/** Builds an R-11 lookup from match key to canonical spelling. */
export function buildLookup<V extends string>(values: readonly V[]): ReadonlyMap<string, V> {
  return new Map(values.map((value) => [matchKey(value), value]));
}
