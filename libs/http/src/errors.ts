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
  /** RFC 7807 extension members (e.g. `candidates`); never PII. Rendered and stored for idempotent replay. */
  readonly extensions: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    options: {
      detail?: string;
      errors?: FieldError[];
      headers?: Record<string, string>;
      extensions?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(options.detail ?? code, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = status;
    this.code = code;
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers;
    this.extensions = options.extensions;
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

/** Standard members always win over extension members of the same name. */
export function toProblem(err: HttpError, correlationId: string): Problem & Record<string, unknown> {
  const p: Problem & Record<string, unknown> = {
    ...(err.extensions ?? {}),
    type: `${ERROR_TYPE_BASE}${err.code}`,
    title: TITLES[err.code] ?? err.code,
    status: err.status,
    code: err.code,
    correlationId,
  };
  if (err.detail) p.detail = err.detail;
  else delete p['detail'];
  if (err.errors?.length) p.errors = err.errors;
  else delete p['errors'];
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
