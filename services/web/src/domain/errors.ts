// web's error codes (web LLD §6). Domain and application code throw WebError; the HTTP adapter maps the code to the
// RFC 7807 status (implementation rules §2.3).
export const ERROR_STATUS = {
  'validation-failed': 400,
  unauthenticated: 401,
  'session-expired': 401,
  'service-credential-invalid': 401,
  'not-invited': 403,
  'user-deactivated': 403,
  forbidden: 403,
  'origin-not-allowed': 403,
  'audience-not-allowed': 403,
  'not-found': 404,
  'route-not-found': 404,
  'email-already-invited': 409,
  'user-exists': 409,
  'invitation-already-accepted': 409,
  'last-admin': 409,
  'cannot-change-own-role': 409,
  'idempotency-key-reused': 409,
  'version-mismatch': 412,
  'unsupported-media-type': 415,
  'rate-limited': 429,
  'dependency-unavailable': 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class WebError extends Error {
  override readonly name = 'WebError';
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    /** Seconds, for 429 / 503. */
    readonly retryAfterSec?: number,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}
