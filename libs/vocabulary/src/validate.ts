/**
 * Runtime validators (strict mode, R-11). Expected bad input never throws: every function returns
 * a result object with the canonical value(s) or the list of issues.
 */
import { buildLookup, isBlank, LIST_SEPARATOR, matchKey } from './normalise.js';
import {
  FIELDS,
  PROPERTY_TYPES_BY_SEGMENT,
  RECORD_SCOPE_RULES,
  SEGMENTS,
  type DealType,
  type FieldValue,
  type LandUse,
  type Market,
  type PropertyType,
  type RecordScope,
  type RouteTo,
  type Segment,
  type Side,
  type VocabularyField,
} from './release-v0.6.js';

/** Error codes, identical to the intake `RowError.code` values of the contract (intake.yaml). */
export type VocabularyIssueCode =
  | 'value-not-in-list'
  | 'scope-deal-type-mismatch'
  | 'segment-property-type-mismatch'
  | 'market-on-non-sale'
  | 'side-scope-mismatch';

export interface VocabularyIssue {
  readonly code: VocabularyIssueCode;
  readonly field: VocabularyField;
  /** The offending value as given (a single item for pipe lists). */
  readonly value: string;
  readonly message: string;
}

export type FieldResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly VocabularyIssue[] };

export type MultiField = {
  [F in VocabularyField]: (typeof FIELDS)[F]['multi'] extends true ? F : never;
}[VocabularyField];
export type SingleField = Exclude<VocabularyField, MultiField>;

const LOOKUPS: { readonly [F in VocabularyField]: ReadonlyMap<string, FieldValue<F>> } = Object.fromEntries(
  Object.entries(FIELDS).map(([field, def]) => [field, buildLookup(def.values)]),
) as { readonly [F in VocabularyField]: ReadonlyMap<string, FieldValue<F>> };

const SEGMENT_OF_PROPERTY_TYPE: ReadonlyMap<PropertyType, Segment> = new Map(
  SEGMENTS.flatMap((segment) =>
    PROPERTY_TYPES_BY_SEGMENT[segment].map((type): [PropertyType, Segment] => [type, segment]),
  ),
);

export function isMultiField(field: VocabularyField): field is MultiField {
  return FIELDS[field].multi;
}

function notInList(field: VocabularyField, value: string): VocabularyIssue {
  return {
    code: 'value-not-in-list',
    field,
    value,
    message: `${field}: "${value}" is not in the controlled list`,
  };
}

/** R-11 match of one item; undefined when not in the list. */
export function canonicalValue<F extends VocabularyField>(field: F, raw: string): FieldValue<F> | undefined {
  return LOOKUPS[field].get(matchKey(raw));
}

/** True when `raw` matches a value of `field` after R-11 normalisation. */
export function isValidValue(field: VocabularyField, raw: string): boolean {
  return canonicalValue(field, raw) !== undefined;
}

/** Single-valued field. Blank → `null` (blank means unknown). */
export function parseValue<F extends SingleField>(
  field: F,
  raw: string | null | undefined,
): FieldResult<FieldValue<F> | null> {
  if (raw === null || raw === undefined || isBlank(raw)) return { ok: true, value: null };
  const value = canonicalValue(field, raw);
  return value === undefined ? { ok: false, issues: [notInList(field, raw.trim())] } : { ok: true, value };
}

/**
 * Pipe-list field (deal_type, property_type). Blank → `[]`. Each item is matched with R-11;
 * duplicates are removed keeping first-seen order; an empty item ("Sale|") is not in the list.
 */
export function parseList<F extends MultiField>(
  field: F,
  raw: string | null | undefined,
): FieldResult<readonly FieldValue<F>[]> {
  if (raw === null || raw === undefined || isBlank(raw)) return { ok: true, value: [] };
  const values: FieldValue<F>[] = [];
  const issues: VocabularyIssue[] = [];
  for (const item of raw.split(LIST_SEPARATOR)) {
    const value = canonicalValue(field, item);
    if (value === undefined) issues.push(notInList(field, item.trim()));
    else if (!values.includes(value)) values.push(value);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: values };
}

/** Any controlled field: a list for pipe-list fields, a single value (or null) otherwise. */
export function parseField(
  field: VocabularyField,
  raw: string | null | undefined,
): FieldResult<string | readonly string[] | null> {
  return isMultiField(field) ? parseList(field, raw) : parseValue(field, raw);
}

/** The segment a property_type belongs to (property types are unique across segments). */
export function segmentOfPropertyType(propertyType: PropertyType): Segment {
  return SEGMENT_OF_PROPERTY_TYPE.get(propertyType) as Segment;
}

/** Destination of a record (BRD §4.2 "Routed to", as a `route_to` value). Null when unknown. */
export function routeFor(recordScope: RecordScope, side: Side | null): RouteTo | null {
  if (recordScope !== 'Property') return RECORD_SCOPE_RULES[recordScope].routedTo as RouteTo;
  if (side === 'Supply') return 'Supply Team';
  if (side === 'Demand') return 'Demand Team';
  return null;
}

// --- Classification (record_scope → deal_type → market → segment → property_type → side) ---------

export interface RawClassification {
  readonly recordScope?: string | null | undefined;
  readonly dealType?: string | null | undefined;
  readonly market?: string | null | undefined;
  readonly segment?: string | null | undefined;
  readonly propertyType?: string | null | undefined;
  readonly landUse?: string | null | undefined;
  readonly side?: string | null | undefined;
}

export interface Classification {
  readonly recordScope: RecordScope | null;
  readonly dealTypes: readonly DealType[];
  readonly market: Market | null;
  readonly segment: Segment | null;
  readonly propertyTypes: readonly PropertyType[];
  readonly landUse: LandUse | null;
  readonly side: Side | null;
}

/** Review detail codes this lib can raise (intake `detail_code` values). */
export type ReviewDetail = 'side_missing';

export type ClassificationResult =
  | {
      readonly ok: true;
      readonly value: Classification;
      readonly needsReview: boolean;
      readonly reviewDetails: readonly ReviewDetail[];
    }
  | { readonly ok: false; readonly issues: readonly VocabularyIssue[] };

const NO_SIDE_SCOPES: readonly RecordScope[] = ['Market Participant', 'Market Signal'];

function issue(
  code: VocabularyIssueCode,
  field: VocabularyField,
  value: string,
  message: string,
): VocabularyIssue {
  return { code, field, value, message };
}

function crossFieldIssues(c: Classification): VocabularyIssue[] {
  const issues: VocabularyIssue[] = [];
  const scope = c.recordScope;

  if (scope !== null) {
    const allowed: readonly DealType[] = RECORD_SCOPE_RULES[scope].allowedDealTypes;
    for (const dealType of c.dealTypes) {
      if (!allowed.includes(dealType)) {
        issues.push(
          issue(
            'scope-deal-type-mismatch',
            'deal_type',
            dealType,
            `deal_type "${dealType}" is not allowed for record_scope "${scope}"`,
          ),
        );
      }
    }
    if (scope !== 'Property') {
      if (c.segment !== null) {
        issues.push(
          issue(
            'segment-property-type-mismatch',
            'segment',
            c.segment,
            `segment applies to Property only, not "${scope}"`,
          ),
        );
      }
      for (const propertyType of c.propertyTypes) {
        issues.push(
          issue(
            'segment-property-type-mismatch',
            'property_type',
            propertyType,
            `property_type applies to Property only, not "${scope}"`,
          ),
        );
      }
    }
    if (c.side !== null && !(RECORD_SCOPE_RULES[scope].sides as readonly Side[]).includes(c.side)) {
      issues.push(
        issue(
          'side-scope-mismatch',
          'side',
          c.side,
          `side "${c.side}" is not allowed for record_scope "${scope}"`,
        ),
      );
    }
  }

  if (c.segment !== null && (scope === null || scope === 'Property')) {
    const allowed: readonly PropertyType[] = PROPERTY_TYPES_BY_SEGMENT[c.segment];
    for (const propertyType of c.propertyTypes) {
      if (!allowed.includes(propertyType)) {
        issues.push(
          issue(
            'segment-property-type-mismatch',
            'property_type',
            propertyType,
            `property_type "${propertyType}" does not belong to segment "${c.segment}"`,
          ),
        );
      }
    }
  }

  if (c.market !== null) {
    if (!c.dealTypes.includes('Sale')) {
      issues.push(
        issue('market-on-non-sale', 'market', c.market, 'market applies only when deal_type includes Sale'),
      );
    } else if (c.market === 'Any' && c.side === 'Supply') {
      issues.push(issue('value-not-in-list', 'market', c.market, 'market "Any" is for Demand records only'));
    }
  }

  return issues;
}

/**
 * Validates the classification fields of one record (BRD §4.2, intake LLD §4.4): each value with
 * R-11, then the cross-field rules. Returns canonical values, or every issue found.
 * A blank side on any scope other than Market Participant / Market Signal loads the record with
 * needsReview = true (detail `side_missing`).
 */
export function validateClassification(raw: RawClassification): ClassificationResult {
  const recordScope = parseValue('record_scope', raw.recordScope);
  const dealTypes = parseList('deal_type', raw.dealType);
  const market = parseValue('market', raw.market);
  const segment = parseValue('segment', raw.segment);
  const propertyTypes = parseList('property_type', raw.propertyType);
  const landUse = parseValue('land_use', raw.landUse);
  const side = parseValue('side', raw.side);

  if (
    !recordScope.ok ||
    !dealTypes.ok ||
    !market.ok ||
    !segment.ok ||
    !propertyTypes.ok ||
    !landUse.ok ||
    !side.ok
  ) {
    const results = [recordScope, dealTypes, market, segment, propertyTypes, landUse, side];
    return { ok: false, issues: results.flatMap((result) => (result.ok ? [] : result.issues)) };
  }

  const value: Classification = {
    recordScope: recordScope.value,
    dealTypes: dealTypes.value,
    market: market.value,
    segment: segment.value,
    propertyTypes: propertyTypes.value,
    landUse: landUse.value,
    side: side.value,
  };
  const issues = crossFieldIssues(value);
  if (issues.length > 0) return { ok: false, issues };

  const sideMissing =
    value.side === null && (value.recordScope === null || !NO_SIDE_SCOPES.includes(value.recordScope));
  const reviewDetails: ReviewDetail[] = sideMissing ? ['side_missing'] : [];
  return { ok: true, value, needsReview: reviewDetails.length > 0, reviewDetails };
}
