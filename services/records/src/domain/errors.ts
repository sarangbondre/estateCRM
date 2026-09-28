// Business rule violations with their stable error codes (records LLD §6). The HTTP adapter maps them to RFC 7807.
export type RecordsErrorCode =
  | 'validation-failed'
  | 'not-found'
  | 'forbidden'
  | 'conflict'
  | 'duplicate-property-suspected'
  | 'deal-type-exists'
  | 'record-merged'
  | 'invalid-stage-transition'
  | 'verification-needs-real-photos'
  | 'not-demand-owner'
  | 'person-phone-exists'
  | 'project-exists'
  | 'stale-price-sheet'
  | 'photo-limit-reached'
  | 'photo-upload-missing'
  | 'photo-not-on-property'
  | 'unsupported-media-type'
  | 'payload-too-large'
  | 'merge-not-allowed'
  | 'merge-too-large'
  | 'merge-already-undone'
  | 'merge-undo-blocked'
  | 'candidate-closed'
  | 'already-resolved'
  | 'desk-item-not-editable'
  | 'micromarket-alias-taken'
  | 'vocabulary-value-invalid'
  | 'phone-invalid'
  | 'range-inverted'
  | 'reveal-not-applicable'
  | 'version-mismatch'
  | 'rate-limited'
  | 'dependency-unavailable';

const STATUS: Record<RecordsErrorCode, number> = {
  'validation-failed': 400,
  'not-found': 404,
  forbidden: 403,
  conflict: 409,
  'duplicate-property-suspected': 409,
  'deal-type-exists': 409,
  'record-merged': 409,
  'invalid-stage-transition': 409,
  'verification-needs-real-photos': 409,
  'not-demand-owner': 403,
  'person-phone-exists': 409,
  'project-exists': 409,
  'stale-price-sheet': 409,
  'photo-limit-reached': 409,
  'photo-upload-missing': 409,
  'photo-not-on-property': 409,
  'unsupported-media-type': 415,
  'payload-too-large': 413,
  'merge-not-allowed': 409,
  'merge-too-large': 409,
  'merge-already-undone': 409,
  'merge-undo-blocked': 409,
  'candidate-closed': 409,
  'already-resolved': 409,
  'desk-item-not-editable': 409,
  'micromarket-alias-taken': 409,
  'vocabulary-value-invalid': 400,
  'phone-invalid': 400,
  'range-inverted': 400,
  'reveal-not-applicable': 400,
  'version-mismatch': 412,
  'rate-limited': 429,
  'dependency-unavailable': 503,
};

export interface FieldIssue {
  field: string;
  code: string;
  message?: string;
}

export class RecordsError extends Error {
  override readonly name = 'RecordsError';
  readonly code: RecordsErrorCode;
  readonly status: number;
  readonly errors: FieldIssue[] | undefined;
  /** RFC 7807 extension members (e.g. `candidates`, `mergedIntoId`). Never PII. */
  readonly extensions: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    code: RecordsErrorCode,
    detail?: string,
    options: {
      errors?: FieldIssue[];
      extensions?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(detail ?? code);
    this.code = code;
    this.status = STATUS[code];
    this.errors = options.errors;
    this.extensions = options.extensions;
    this.headers = options.headers;
  }

  get detail(): string | undefined {
    return this.message === this.code ? undefined : this.message;
  }
}

export const notFound = (what?: string) => new RecordsError('not-found', what ? `${what} not found` : undefined);
