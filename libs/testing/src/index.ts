// @11e/testing: public API. See README.md.
export {
  EXTRACTOR_COLUMNS,
  DATE_COLUMNS,
  PII_COLUMNS,
  blankRow,
  type ExtractorColumn,
  type ExtractorRow,
  type CellValue,
} from './synthetic/columns.js';
export {
  INJECTED_ERROR_CODES,
  INJECTED_WARNING_CODES,
  DEFAULT_DATE_FROM,
  DEFAULT_DATE_TO,
  resolveOptions,
  type InjectedErrorCode,
  type InjectedWarningCode,
  type SyntheticOptions,
} from './synthetic/options.js';
export {
  SyntheticGenerator,
  generate,
  expectedNeedsReview,
  type RowKind,
  type RowMeta,
  type SyntheticRecord,
} from './synthetic/generator.js';
export type { InjectedIssue } from './synthetic/errors.js';
export {
  SYNTHETIC_PHONE_CAPACITY,
  MAX_PEOPLE,
  SYNTHETIC_EMAIL_DOMAINS,
  syntheticPhone,
  anonymisedPhone,
  syntheticPerson,
  isSyntheticPhone,
  isSyntheticEmail,
  findPhoneLikeNumbers,
  type SyntheticPerson,
} from './synthetic/contacts.js';
export {
  ManifestBuilder,
  BLANK,
  type SyntheticManifest,
  type ManifestFile,
  type ClassificationCounts,
} from './synthetic/manifest.js';
export {
  OUTPUT_FORMATS,
  NdjsonSink,
  CsvSink,
  XlsxSink,
  createSink,
  csvField,
  filePath,
  writeDataset,
  type OutputFormat,
  type RowSink,
  type WriteDatasetOptions,
  type WriteDatasetResult,
} from './synthetic/writers.js';
export { Rng } from './synthetic/rng.js';
