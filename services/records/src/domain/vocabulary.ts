// Validation of controlled fields against the ACTIVE vocabulary release (records LLD §4.13, conventions §8, R-11):
// values match after trimming and case-folding and are stored in the release's canonical spelling.
import { matchKey } from '@11e/vocabulary';
import { RecordsError } from './errors.js';
import type { FieldIssue } from './errors.js';

export interface ReleaseFields {
  readonly [field: string]: { readonly values: readonly string[]; readonly multi?: boolean };
}

/** A value from a request body at `path` (JSON pointer-ish, e.g. `offer.dealType`) for vocabulary `field`. */
export interface ControlledValue {
  path: string;
  field: string;
  value: string | readonly string[] | null | undefined;
}

export class VocabularyIndex {
  readonly #byField = new Map<string, Map<string, string>>();
  readonly version: string;

  constructor(version: string, fields: ReleaseFields) {
    this.version = version;
    for (const [field, def] of Object.entries(fields)) {
      this.#byField.set(field, new Map(def.values.map((v) => [matchKey(v), v])));
    }
  }

  has(field: string): boolean {
    return this.#byField.has(field);
  }

  canonical(field: string, raw: string): string | null {
    return this.#byField.get(field)?.get(matchKey(raw)) ?? null;
  }

  /**
   * Canonicalises every value; throws 400 vocabulary-value-invalid listing each bad field.
   * Returns the canonical values keyed by path.
   */
  validate(values: readonly ControlledValue[]): Map<string, string | string[] | null> {
    const issues: FieldIssue[] = [];
    const out = new Map<string, string | string[] | null>();
    for (const v of values) {
      if (v.value === undefined) continue;
      if (v.value === null) {
        out.set(v.path, null);
        continue;
      }
      if (!this.has(v.field)) {
        out.set(v.path, Array.isArray(v.value) ? [...v.value] : (v.value as string));
        continue;
      }
      if (Array.isArray(v.value)) {
        const list: string[] = [];
        v.value.forEach((item: string, i: number) => {
          const c = this.canonical(v.field, item);
          if (c === null) issues.push(issue(`${v.path}/${i}`, v.field, item));
          else if (!list.includes(c)) list.push(c);
        });
        out.set(v.path, list);
      } else {
        const raw = v.value as string;
        const c = this.canonical(v.field, raw);
        if (c === null) issues.push(issue(v.path, v.field, raw));
        else out.set(v.path, c);
      }
    }
    if (issues.length) throw new RecordsError('vocabulary-value-invalid', undefined, { errors: issues });
    return out;
  }
}

function issue(path: string, field: string, value: string): FieldIssue {
  // The value itself is not echoed (it may be free text typed by a user).
  void value;
  return { field: path, code: 'value-not-in-list', message: `not a value of ${field} in the active vocabulary` };
}

/** min ≤ max for every pair given; throws 400 range-inverted. */
export function assertRanges(pairs: readonly [string, number | null | undefined, number | null | undefined][]): void {
  const errors: FieldIssue[] = [];
  for (const [field, min, max] of pairs) {
    if (min !== null && min !== undefined && max !== null && max !== undefined && min > max) {
      errors.push({ field, code: 'range-inverted', message: `${field}Min is greater than ${field}Max` });
    }
  }
  if (errors.length) throw new RecordsError('range-inverted', undefined, { errors });
}
