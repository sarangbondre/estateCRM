// @11e/vocabulary: public API. See README.md.
export * from './release-v0.6.js';
export { matchKey, isBlank, LIST_SEPARATOR } from './normalise.js';
export {
  canonicalValue,
  isValidValue,
  isMultiField,
  parseValue,
  parseList,
  parseField,
  segmentOfPropertyType,
  routeFor,
  validateClassification,
  type VocabularyIssueCode,
  type VocabularyIssue,
  type FieldResult,
  type MultiField,
  type SingleField,
  type RawClassification,
  type Classification,
  type ReviewDetail,
  type ClassificationResult,
} from './validate.js';
export {
  displayLabel,
  displayLabels,
  SALE_MARKET_UNKNOWN_ROW,
  type DisplayLabel,
  type LabelInput,
  type LabelClassification,
  type LabelRowKey,
} from './labels.js';
export {
  LEGACY_TERMS,
  LEGACY_FIELD_NAMES,
  LEGACY_ROLE_NAMES,
  legacyKey,
  translateLegacyTerm,
  translateLegacyFieldName,
  type LegacyTerm,
  type TranslationResult,
} from './legacy.js';
export {
  releaseContent,
  type ReleaseFieldDocument,
  type VocabularyReleaseContent,
} from './release-document.js';
