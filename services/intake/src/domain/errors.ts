// Typed business errors (docs/06-implementation-rules.md §2.3): raised by the domain and application layers and mapped
// to RFC 7807 responses in the http adapter only (intake LLD §6).
export type IntakeErrorCode =
  | 'not-found'
  | 'forbidden'
  | 'validation-failed'
  | 'version-mismatch'
  | 'rate-limited'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'anonymise-required'
  | 'upload-not-editable'
  | 'file-missing'
  | 'file-size-mismatch'
  | 'mapping-not-allowed'
  | 'mapping-invalid'
  | 'sheet-not-found'
  | 'upload-not-ready'
  | 'duplicate-upload'
  | 'upload-not-cancellable'
  | 'rejected-file-not-ready'
  | 'vocabulary-unavailable'
  | 'template-name-taken'
  | 'review-item-closed'
  | 'classification-invalid'
  | 'batch-not-found';

export interface FieldIssue {
  field: string;
  code: string;
  message?: string;
}

export class IntakeError extends Error {
  override readonly name = 'IntakeError';
  constructor(
    readonly code: IntakeErrorCode,
    detail?: string,
    readonly errors?: FieldIssue[],
    /** Seconds, for rate-limited. */
    readonly retryAfterSec?: number,
  ) {
    super(detail ?? code);
  }
}

export const notFound = (what = 'resource') => new IntakeError('not-found', `${what} not found`);
