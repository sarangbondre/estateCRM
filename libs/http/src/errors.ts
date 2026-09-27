// RFC 7807 problem responses (conventions §4): type https://errors.11estates.in/<code>, stable kebab-case code,
// correlationId on every error, optional field errors for validation.
export interface FieldError {
  field: string;
  code: string;
  message?: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  correlationId: string;
  errors?: FieldError[];
}

const TITLES: Record<string, string> = {
  'validation-failed': 'Validation failed',
  unauthenticated: 'Authentication required',
  forbidden: 'Forbidden',
  'not-found': 'Not found',
  conflict: 'Conflict',
  'idempotency-key-reused': 'Idempotency key reused with a different request',
  'version-mismatch': 'Version mismatch',
  'payload-too-large': 'Payload too large',
  'unsupported-media-type': 'Unsupported media type',
  'rate-limited': 'Too many requests',
  internal: 'Internal error',
  'dependency-unavailable': 'Dependency unavailable',
};

export const ERROR_TYPE_BASE = 'https://errors.11estates.in/';

/** Throw from handlers and middleware; rendered as application/problem+json. */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    status: number,
    code: string,
    options: {
      detail?: string;
      errors?: FieldError[];
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(options.detail ?? code, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = status;
    this.code = code;
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers;
  }
}

export const badRequest = (errors: FieldError[], detail?: string) =>
  new HttpError(400, 'validation-failed', { errors, ...(detail ? { detail } : {}) });
export const unauthenticated = (detail?: string) =>
  new HttpError(401, 'unauthenticated', detail ? { detail } : {});
export const forbidden = (detail?: string) => new HttpError(403, 'forbidden', detail ? { detail } : {});
export const notFound = (detail?: string) => new HttpError(404, 'not-found', detail ? { detail } : {});
export const conflict = (code = 'conflict', detail?: string) =>
  new HttpError(409, code, detail ? { detail } : {});
export const versionMismatch = () => new HttpError(412, 'version-mismatch');
export const dependencyUnavailable = (detail?: string) =>
  new HttpError(503, 'dependency-unavailable', detail ? { detail } : {});

export function toProblem(err: HttpError, correlationId: string): Problem {
  const p: Problem = {
    type: `${ERROR_TYPE_BASE}${err.code}`,
    title: TITLES[err.code] ?? err.code,
    status: err.status,
    code: err.code,
    correlationId,
  };
  if (err.detail) p.detail = err.detail;
  if (err.errors?.length) p.errors = err.errors;
  return p;
}

export function problemResponse(err: HttpError, correlationId: string): Response {
  const headers = new Headers({
    'content-type': 'application/problem+json',
    'x-correlation-id': correlationId,
  });
  for (const [k, v] of Object.entries(err.headers ?? {})) headers.set(k, v);
  return new Response(JSON.stringify(toProblem(err, correlationId)), { status: err.status, headers });
}
