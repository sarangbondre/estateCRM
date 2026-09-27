/**
 * The release content in the contract shape (records.yaml `VocabularyRelease`, minus the fields records
 * adds when it activates a release: checksum, activatedAt, status). records ships it as
 * `services/records/vocabulary/v0.6.json` (records LLD §4.13).
 */
import { SALE_MARKET_UNKNOWN_ROW } from './labels.js';
import { LEGACY_TERMS, type LegacyTerm } from './legacy.js';
import {
  DISPLAY_LABEL_TABLE,
  FIELDS,
  PROPERTY_TYPES_BY_SEGMENT,
  RECORD_SCOPE_RULES,
  RECORD_SCOPES,
  VOCABULARY_RELEASE_ID,
  type RecordScopeRule,
  type VocabularyField,
} from './release-v0.6.js';

export interface ReleaseFieldDocument {
  readonly values: readonly string[];
  readonly multi: boolean;
  readonly bySegment?: Readonly<Record<string, readonly string[]>>;
}

export interface VocabularyReleaseContent {
  readonly version: string;
  readonly fields: Readonly<Record<VocabularyField, ReleaseFieldDocument>>;
  readonly recordScopes: readonly RecordScopeRule[];
  readonly legacyTerms: readonly LegacyTerm[];
  readonly displayLabels: readonly object[];
}

export function releaseContent(): VocabularyReleaseContent {
  const entries = Object.entries(FIELDS).map(([name, def]): [string, ReleaseFieldDocument] => [
    name,
    name === 'property_type'
      ? { values: def.values, multi: def.multi, bySegment: PROPERTY_TYPES_BY_SEGMENT }
      : { values: def.values, multi: def.multi },
  ]);
  const fields = Object.fromEntries(entries) as Record<VocabularyField, ReleaseFieldDocument>;
  return {
    version: VOCABULARY_RELEASE_ID,
    fields,
    recordScopes: RECORD_SCOPES.map((scope) => RECORD_SCOPE_RULES[scope]),
    legacyTerms: LEGACY_TERMS,
    displayLabels: [...DISPLAY_LABEL_TABLE, SALE_MARKET_UNKNOWN_ROW],
  };
}
