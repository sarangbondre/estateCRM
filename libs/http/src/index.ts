// @11e/http: service app factory, contract validation, RFC 7807 errors, idempotency, pagination, outbound client (F-10).
export { correlationId, createService } from './app.js';
export type {
  OperationHandler,
  OperationInput,
  ReadyCheck,
  RequestEndInfo,
  Service,
  ServiceContext,
  ServiceEnv,
  ServiceOptions,
  ServiceVariables,
} from './app.js';
export { Contract } from './contract.js';
export type { OpenApiDoc, Operation } from './contract.js';
export {
  ERROR_TYPE_BASE,
  HttpError,
  badRequest,
  conflict,
  dependencyUnavailable,
  forbidden,
  notFound,
  problemResponse,
  toProblem,
  unauthenticated,
  versionMismatch,
} from './errors.js';
export type { FieldError, Problem } from './errors.js';
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  idempotent,
  ifMatchVersion,
  pageLimit,
  toPage,
} from './request-helpers.js';
export type { IdempotencyIdentity } from './request-helpers.js';
export { CircuitBreaker, CircuitOpenError, DownstreamError, createHttpClient } from './client.js';
export type { BreakerOptions, ClientOptions, ClientResponse, HttpClient, RequestOptions } from './client.js';
export { registerPlatformEndpoints } from './platform.js';
export type {
  JobLeasesTable,
  JobResult,
  PlatformEndpointsOptions,
  PlatformResponseStyle,
} from './platform.js';
