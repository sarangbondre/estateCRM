// Row normalisation (LLD §4.4 strict validation, §4.7 mapping translation + rules): one sheet row → the IntakeRow
// fields, row errors / warnings, review reasons, and whether the model should look at the leftovers.
import {
  RECORD_SCOPE_RULES,
  isValidValue,
  parseValue,
  routeFor,
  segmentOfPropertyType,
  validateClassification,
} from '@11e/vocabulary';
import type { PropertyType, RecordScope, Side, VocabularyField } from '@11e/vocabulary';
import * as cell from './cells.js';
import { classifyText } from './classify.js';
import { FIELD_SPECS, RANGE_PAIRS } from './fields.js';
import { extractorReasons, intakeReason } from './reasons.js';
import type { Reason } from './reasons.js';
import { PII_FIELDS } from './schema.js';
import type { TargetField } from './schema.js';
import type { LegacyTable } from './translate.js';

export type RowErrorCode =
  | 'value-not-in-list'
  | 'invalid-type'
  | 'invalid-date'
  | 'required-missing'
  | 'range-inverted'
  | 'invalid-phone'
  | 'scope-deal-type-mismatch'
  | 'segment-property-type-mismatch'
  | 'market-on-non-sale'
  | 'side-scope-mismatch'
  | 'duplicate-external-ref'
  | 'migration-entry-invalid'
  | 'parse-error';

export interface RowIssue {
  field: string;
  code: RowErrorCode;
  severity: 'error' | 'warning';
  /** Offending value; null for PII fields (never stored). */
  value: string | null;
  message: string;
}

export interface Classification {
  recordScope: RecordScope | null;
  dealTypes: string[];
  market: string | null;
  segment: string | null;
  propertyTypes: string[];
  landUse: string | null;
  side: Side | null;
}

export interface NormalisedRow {
  /** IntakeRow data fields (camelCase), classification included. */
  fields: Record<string, unknown>;
  recordId: string | null;
  externalId: string | null;
  parentRef: string | null;
  issues: RowIssue[];
  reasons: Reason[];
  extractorNeedsReview: boolean;
  reviewReasonText: string | null;
  /** Text the classifier (rules, then model) reads: raw_text / free_text. PII. */
  classifierText: string | null;
  /** Mapping mode: scope, deal type or side still blank and there is text → model (§4.7 step 6). */
  needsModel: boolean;
}

export interface NormaliseOptions {
  importCrmNotes: boolean;
  /** Same external ref seen earlier in the file (flagged at split). */
  duplicate: boolean;
  /** Locality alias → canonical micromarket-hierarchy name (records reference data); undefined = keep as written. */
  locality?: (name: string) => string | undefined;
}

export const rejected = (row: NormalisedRow) => row.issues.some((i) => i.severity === 'error');

const HEX12 = /^[0-9a-f]{12}$/i;
const NO_SIDE: readonly string[] = ['Market Participant', 'Market Signal'];
const CLASSIFICATION_TARGETS = [
  'record_scope',
  'deal_type',
  'market',
  'segment',
  'property_type',
  'land_use',
  'side',
] as const;

const issue = (
  field: string,
  code: RowErrorCode,
  severity: 'error' | 'warning',
  raw: string | null | undefined,
  message: string,
): RowIssue => ({
  field,
  code,
  severity,
  value: PII_FIELDS.has(field) || raw === null || raw === undefined ? null : raw.slice(0, 200),
  message,
});

/** Parses every non-special, non-classification field (shared by both modes). */
function parseCommon(
  get: (f: TargetField) => string | null,
  strict: boolean,
  issues: RowIssue[],
  translate?: LegacyTable,
  derived?: Record<string, string>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const sev = strict ? 'error' : 'warning';
  const badPhones: string[] = [];
  for (const [name, spec] of Object.entries(FIELD_SPECS) as [
    TargetField,
    (typeof FIELD_SPECS)[TargetField],
  ][]) {
    const key = spec.key;
    if (!key || spec.kind === 'special' || spec.kind === 'ignored') continue;
    const raw = get(name);
    switch (spec.kind) {
      case 'text':
        fields[key] = cell.text(raw);
        break;
      case 'bool':
      case 'int':
      case 'number':
      case 'date':
      case 'datetime':
      case 'possession': {
        const p =
          spec.kind === 'bool'
            ? cell.bool(raw, !strict)
            : spec.kind === 'int'
              ? cell.int(raw)
              : spec.kind === 'number'
                ? cell.num(raw)
                : spec.kind === 'date'
                  ? cell.date(raw, !strict)
                  : spec.kind === 'datetime'
                    ? cell.dateTime(raw)
                    : cell.possessionDate(raw);
        if (p.ok) fields[key] = p.value;
        else if (!strict && cell.isPlaceholder(raw ?? '')) fields[key] = null;
        else {
          const dateLike = spec.kind === 'date' || spec.kind === 'datetime' || spec.kind === 'possession';
          issues.push(
            issue(
              name,
              dateLike ? 'invalid-date' : 'invalid-type',
              sev,
              raw,
              `${name}: "${raw ?? ''}" is not a valid ${dateLike ? 'date' : spec.kind}`,
            ),
          );
          fields[key] = null;
        }
        break;
      }
      case 'controlled': {
        const vocab = spec.vocab as VocabularyField;
        if (strict) {
          const p = parseValue(vocab as Parameters<typeof parseValue>[0], raw);
          if (p.ok) fields[key] = p.value;
          else {
            fields[key] = null;
            for (const i of p.issues) issues.push(issue(name, 'value-not-in-list', 'error', raw, i.message));
          }
        } else {
          const t = translate?.translate(vocab, cell.text(raw));
          if (!t || !t.ok) {
            fields[key] = null;
            issues.push(
              issue(
                name,
                'value-not-in-list',
                'warning',
                raw,
                `${name}: "${raw ?? ''}" could not be translated`,
              ),
            );
          } else {
            fields[key] = t.maps[vocab] ?? null;
            for (const [k, v] of Object.entries(t.maps))
              if (k !== vocab && derived && derived[k] === undefined) derived[k] = v;
          }
        }
        break;
      }
      case 'phones': {
        const { phones, invalid } = cell.phoneList(raw);
        fields[key] = phones;
        if (invalid.length) {
          issues.push(
            issue(
              name,
              'invalid-phone',
              'warning',
              null,
              `${invalid.length} phone value(s) could not be read; moved to other_contact`,
            ),
          );
          badPhones.push(...invalid);
        }
        break;
      }
      case 'phone': {
        const t = cell.text(raw);
        const p = t ? cell.phone(t) : null;
        fields[key] = p;
        if (t && !p)
          issues.push(
            issue(name, 'invalid-phone', 'warning', null, `${name} could not be read as a phone number`),
          );
        break;
      }
      case 'emails':
        fields[key] = cell.emailList(raw);
        break;
      case 'urls':
        fields[key] = cell.urlList(raw);
        break;
    }
  }
  if (badPhones.length) {
    fields['otherContact'] = [fields['otherContact'] as string | null, ...badPhones]
      .filter(Boolean)
      .join(' | ');
  }
  return fields;
}

function applyDerived(fields: Record<string, unknown>, derived: Record<string, string>): void {
  const numeric = new Set(['bhk_min', 'bhk_max']);
  for (const [target, value] of Object.entries(derived)) {
    const spec = FIELD_SPECS[target as TargetField];
    const key = spec?.key;
    if (!key || CLASSIFICATION_TARGETS.includes(target as never)) continue;
    if (fields[key] === null || fields[key] === undefined)
      fields[key] = numeric.has(target) ? Number(value) : value;
  }
}

function checkRanges(fields: Record<string, unknown>, issues: RowIssue[], strict: boolean): void {
  for (const [minName, , minKey, maxKey] of RANGE_PAIRS) {
    const a = fields[minKey];
    const b = fields[maxKey];
    if (typeof a === 'number' && typeof b === 'number' && a > b) {
      if (strict)
        issues.push(
          issue(minName, 'range-inverted', 'error', `${a} > ${b}`, `${minName} is greater than its max`),
        );
      else [fields[minKey], fields[maxKey]] = [b, a];
    }
  }
}

function finishCommon(
  fields: Record<string, unknown>,
  options: NormaliseOptions,
  get: (f: TargetField) => string | null,
) {
  if (options.locality && typeof fields['locality'] === 'string') {
    fields['locality'] = options.locality(fields['locality']) ?? fields['locality'];
  }
  const LAND_SQFT: Record<string, number> = {
    acre: 43_560,
    sqft: 1,
    sqm: 10.7639,
    sqyd: 9,
    gunta: 1_089,
    bigha: 27_000,
  };
  if (
    fields['landAreaSqft'] === null &&
    typeof fields['landAreaValue'] === 'number' &&
    typeof fields['landAreaUnit'] === 'string'
  ) {
    fields['landAreaSqft'] =
      Math.round(fields['landAreaValue'] * (LAND_SQFT[fields['landAreaUnit']] ?? 0)) || null;
  }
  fields['crmNotes'] = options.importCrmNotes ? cell.text(get('crm_notes')) : null;
}

const classificationOf = (f: Record<string, unknown>): Classification => ({
  recordScope: (f['recordScope'] as RecordScope | null) ?? null,
  dealTypes: (f['dealTypes'] as string[] | undefined) ?? [],
  market: (f['market'] as string | null) ?? null,
  segment: (f['segment'] as string | null) ?? null,
  propertyTypes: (f['propertyTypes'] as string[] | undefined) ?? [],
  landUse: (f['landUse'] as string | null) ?? null,
  side: (f['side'] as Side | null) ?? null,
});

function setClassification(f: Record<string, unknown>, c: Classification): void {
  Object.assign(f, c);
}

// ---- strict mode -------------------------------------------------------------------------------------------------

/** LLD §4.4 (R-11): controlled values in the list, cross-field rules, types, ranges; any error rejects the row. */
export function normaliseStrict(
  get: (f: TargetField) => string | null,
  options: NormaliseOptions,
): NormalisedRow {
  const issues: RowIssue[] = [];
  const reasons: Reason[] = [];
  const fields = parseCommon(get, true, issues);
  const recordId = cell.text(get('record_id'));
  if (!recordId) issues.push(issue('record_id', 'required-missing', 'error', null, 'record_id is required'));
  else if (!HEX12.test(recordId))
    issues.push(issue('record_id', 'invalid-type', 'error', recordId, 'record_id must be a 12-hex id'));
  const parentRaw = cell.text(get('parent_record_id'));
  if (options.duplicate && recordId) {
    issues.push(
      issue(
        'record_id',
        'duplicate-external-ref',
        'error',
        recordId,
        'record_id appears earlier in this file',
      ),
    );
  }
  const flag = cell.bool(get('needs_review'));
  if (!flag.ok)
    issues.push(
      issue(
        'needs_review',
        'invalid-type',
        'error',
        get('needs_review'),
        'needs_review must be TRUE or FALSE',
      ),
    );
  const reviewText = cell.text(get('review_reason'));

  const result = validateClassification({
    recordScope: get('record_scope'),
    dealType: get('deal_type'),
    market: get('market'),
    segment: get('segment'),
    propertyType: get('property_type'),
    landUse: get('land_use'),
    side: get('side'),
  });
  if (result.ok) {
    setClassification(fields, {
      recordScope: result.value.recordScope,
      dealTypes: [...result.value.dealTypes],
      market: result.value.market,
      segment: result.value.segment,
      propertyTypes: [...result.value.propertyTypes],
      landUse: result.value.landUse,
      side: result.value.side,
    });
    if (result.reviewDetails.includes('side_missing')) reasons.push(intakeReason('side_missing'));
  } else {
    setClassification(fields, {
      recordScope: null,
      dealTypes: [],
      market: null,
      segment: null,
      propertyTypes: [],
      landUse: null,
      side: null,
    });
    for (const i of result.issues) issues.push(issue(i.field, i.code, 'error', i.value, i.message));
  }
  checkRanges(fields, issues, true);
  finishCommon(fields, options, get);
  fields['reviewReason'] = reviewText;
  const extractorNeedsReview = flag.ok && flag.value === true;
  if (extractorNeedsReview) {
    const fromText = extractorReasons(reviewText);
    reasons.push(
      ...(fromText.length ? fromText : [{ code: 'other' as const, detail: 'extractor_flag' as const }]),
    );
  }
  return {
    fields,
    recordId: recordId?.toLowerCase() ?? null,
    externalId: null,
    parentRef: parentRaw?.toLowerCase() ?? null,
    issues,
    reasons,
    extractorNeedsReview,
    reviewReasonText: reviewText,
    classifierText: cell.text(get('raw_text')),
    needsModel: false,
  };
}

// ---- mapping mode ------------------------------------------------------------------------------------------------

const isComplete = (c: Classification) =>
  c.recordScope !== null && (NO_SIDE.includes(c.recordScope) || (c.dealTypes.length > 0 && c.side !== null));

/**
 * LLD §4.7: types without rejecting for vocabulary, legacy translation, rules for blank classification fields from the
 * text, cross-field clean-up (offending values blanked + value_not_translatable). Rejects only duplicate refs.
 */
export function normaliseMapping(
  get: (f: TargetField) => string | null,
  translate: LegacyTable,
  options: NormaliseOptions,
): NormalisedRow {
  const issues: RowIssue[] = [];
  const reasons: Reason[] = [];
  const derived: Record<string, string> = {};
  const fields = parseCommon(get, false, issues, translate, derived);
  const own: Record<string, string | null> = {};
  for (const target of CLASSIFICATION_TARGETS) {
    const raw = cell.text(get(target));
    const t = translate.translate(target, raw);
    if (!t.ok) {
      own[target] = null;
      reasons.push(intakeReason('value_not_translatable'));
      if (target === 'deal_type')
        reasons.push({ code: 'deal_type_missing', detail: 'value_not_translatable' });
      if (target === 'property_type')
        reasons.push({ code: 'property_type_missing', detail: 'value_not_translatable' });
      issues.push(
        issue(
          target,
          'value-not-in-list',
          'warning',
          raw,
          `${target}: "${raw ?? ''}" could not be translated`,
        ),
      );
      continue;
    }
    own[target] = t.maps[target] ?? null;
    for (const [k, v] of Object.entries(t.maps)) if (k !== target && derived[k] === undefined) derived[k] = v;
  }
  const pick = (target: (typeof CLASSIFICATION_TARGETS)[number]) => own[target] ?? derived[target] ?? null;
  const list = (v: string | null) => (v ? v.split('|') : []);
  const c: Classification = {
    recordScope: pick('record_scope') as RecordScope | null,
    dealTypes: list(pick('deal_type')),
    market: pick('market'),
    segment: pick('segment'),
    propertyTypes: list(pick('property_type')),
    landUse: pick('land_use'),
    side: pick('side') as Side | null,
  };
  applyDerived(fields, derived);
  // a property type implies scope Property and its segment (property types are unique across segments)
  const firstType = c.propertyTypes[0];
  if (firstType && isValidValue('property_type', firstType)) {
    c.recordScope ??= 'Property';
    c.segment ??= segmentOfPropertyType(firstType as PropertyType);
  }

  // rules classifier for blank classification fields (side last)
  const text = [cell.text(get('raw_text')), cell.text(get('free_text'))].filter(Boolean).join('\n') || null;
  if (text) {
    const r = classifyText(text);
    c.recordScope ??= r.recordScope;
    if (!c.dealTypes.length) c.dealTypes = r.dealTypes;
    if (!c.propertyTypes.length && c.recordScope === 'Property') {
      c.propertyTypes = r.propertyTypes;
      c.segment ??= r.segment;
    }
    for (const k of [
      'bhkMin',
      'bhkMax',
      'areaSqftMin',
      'areaSqftMax',
      'salePriceInrMin',
      'salePriceInrMax',
      'rentMonthlyInrMin',
      'rentMonthlyInrMax',
      'furnishing',
      'tenancyStatus',
      'saleMode',
    ] as const) {
      if ((fields[k] === null || fields[k] === undefined) && r[k] !== null) fields[k] = r[k];
    }
    if (c.side === null && r.side !== null) {
      c.side = r.side;
      if (!fields['sideEvidence']) fields['sideEvidence'] = r.sideEvidence;
    }
  }
  if (c.recordScope && NO_SIDE.includes(c.recordScope)) {
    c.side ??= 'None';
    c.dealTypes = [];
  }
  cleanCrossField(c, reasons, issues);
  setClassification(fields, c);
  if (!fields['rawText'] && text) fields['rawText'] = text;
  checkRanges(fields, issues, false);
  finishCommon(fields, options, get);
  if (fields['routeTo'] === null && c.recordScope) fields['routeTo'] = routeFor(c.recordScope, c.side);
  const reviewText = cell.text(get('review_reason'));
  fields['reviewReason'] = reviewText;
  const flag = cell.bool(get('needs_review'), true);
  const extractorNeedsReview = flag.ok && flag.value === true;
  if (extractorNeedsReview) {
    const fromText = extractorReasons(reviewText);
    reasons.push(
      ...(fromText.length ? fromText : [{ code: 'other' as const, detail: 'extractor_flag' as const }]),
    );
  }
  const recordId = cell.text(get('record_id'));
  const externalId = cell.text(get('external_id'));
  if (options.duplicate) {
    issues.push(
      issue(
        recordId ? 'record_id' : 'external_id',
        'duplicate-external-ref',
        'error',
        recordId ?? externalId,
        'this reference appears earlier in this file',
      ),
    );
  }
  return {
    fields,
    recordId: recordId && HEX12.test(recordId) ? recordId.toLowerCase() : null,
    externalId: recordId && !HEX12.test(recordId) ? recordId : externalId,
    parentRef: cell.text(get('parent_record_id'))?.toLowerCase() ?? null,
    issues,
    reasons,
    extractorNeedsReview,
    reviewReasonText: reviewText,
    classifierText: text,
    needsModel: !isComplete(c) && text !== null,
  };
}

/** Blanks values that break the cross-field rules (mapping mode never rejects for vocabulary, D-15). */
function cleanCrossField(c: Classification, reasons: Reason[], issues: RowIssue[]): void {
  for (let pass = 0; pass < 4; pass++) {
    const r = validateClassification({
      recordScope: c.recordScope,
      dealType: c.dealTypes.join('|') || null,
      market: c.market,
      segment: c.segment,
      propertyType: c.propertyTypes.join('|') || null,
      landUse: c.landUse,
      side: c.side,
    });
    if (r.ok) return;
    for (const i of r.issues) {
      issues.push(issue(i.field, i.code, 'warning', i.value, `${i.message}; value dropped`));
      if (i.field === 'deal_type') c.dealTypes = c.dealTypes.filter((d) => d !== i.value);
      else if (i.field === 'property_type') c.propertyTypes = c.propertyTypes.filter((p) => p !== i.value);
      else if (i.field === 'segment') c.segment = null;
      else if (i.field === 'market') c.market = null;
      else if (i.field === 'side') c.side = null;
      else if (i.field === 'record_scope') c.recordScope = null;
      else if (i.field === 'land_use') c.landUse = null;
    }
    if (!reasons.some((x) => x.code === 'value_not_translatable'))
      reasons.push(intakeReason('value_not_translatable'));
  }
}

/**
 * After rules (and the model, INT-06): remaining gaps become review reasons. Blank side on a side-bearing scope →
 * side_unclear (side_missing, BRD §4.2); mapping mode also flags a blank scope or deal type.
 */
export function finaliseReasons(row: NormalisedRow, mode: 'strict' | 'mapping'): void {
  if (mode === 'strict') return;
  const c = classificationOf(row.fields);
  const has = (code: string) => row.reasons.some((r) => r.code === code);
  if (c.recordScope === null) row.reasons.push({ code: 'other', detail: 'scope_unclear' });
  else if (!NO_SIDE.includes(c.recordScope)) {
    if (c.side === null && !has('side_unclear')) row.reasons.push(intakeReason('side_missing'));
    if (!c.dealTypes.length && !has('deal_type_missing'))
      row.reasons.push({ code: 'deal_type_missing', detail: 'scope_unclear' });
  }
  if (
    c.recordScope &&
    c.side &&
    !(RECORD_SCOPE_RULES[c.recordScope].sides as readonly string[]).includes(c.side)
  ) {
    row.fields['side'] = null;
  }
}

export { classificationOf };
