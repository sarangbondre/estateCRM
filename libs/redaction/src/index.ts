// @11e/redaction: public API. See README.md.
export { containsContact, detect, redact, restore } from './redact.js';
export { hasResidualRisk } from './residual.js';
export { PII_KINDS } from './types.js';
export type { Detection, PiiKind, PlaceholderStyle, RedactOptions, RedactionResult } from './types.js';
