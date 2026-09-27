// @11e/observability: JSON logs with a PII allow-list, OpenTelemetry tracing across HTTP and events, RED metrics and
// alarm rules (F-12, conventions §7). See README.md.
export { ALLOWED_LOG_FIELDS, sanitizeError, sanitizeFields, sanitizeValue } from './fields.js';
export type { FieldKind, RedactMessage, SafeError } from './fields.js';
export { REDACTED, containsPii, scrubText } from './pii.js';
export { createLogger } from './logger.js';
export type { LogFields, LogLevel, Logger, LoggerOptions } from './logger.js';
export { INSTRUMENTATION_SCOPE } from './scope.js';
export {
  contextFromTraceparent,
  currentTraceparent,
  eventTrace,
  injectTraceHeaders,
  setupTelemetry,
  traceHeaders,
  tracingMiddleware,
  withEventSpan,
  withSpan,
} from './tracing.js';
export type { RequestSummary, Telemetry, TelemetryOptions, TracedEvent } from './tracing.js';
export { DURATION_BUCKETS_MS, METRICS, createRedMetrics } from './metrics.js';
export type { CallInfo, ConsumerOutcome, RedMetrics } from './metrics.js';
export {
  ALARM_RULES,
  DEFAULT_P95_TARGET_MS,
  P95_EXCLUDED_ROUTE_PREFIXES,
  P95_TARGET_OVERRIDES_MS,
  p95TargetMs,
} from './alarms.js';
export type { AlarmRule, Comparison } from './alarms.js';
export { observe } from './observe.js';
export type { DrainErrorInfo, Observability, ObserveOptions } from './observe.js';
