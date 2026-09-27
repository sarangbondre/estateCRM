# @11e/observability

Logs, traces and RED metrics for every service (F-12): pino JSON logs with a **PII allow-list**, OpenTelemetry
tracing across HTTP and events (`traceparent` in the event envelope), RED metrics per route, downstream and consumer,
and the alarm rules as data. Conventions §7, CLAUDE.md §3.7/§3.8, implementation rules §2.4.

Infrastructure only, never domain models (CLAUDE.md §3.9).

## Wiring a service (composition root)

```ts
import spec from '@11e/contracts/openapi/records.json' with { type: 'json' };
import { createHttpClient, createService } from '@11e/http';
import { drainEvents, writeEvent } from '@11e/outbox';
import { eventTrace, observe, setupTelemetry, traceHeaders, withEventSpan } from '@11e/observability';

const telemetry = setupTelemetry({ serviceName: 'records' }); // first, before anything records metrics
const obs = observe('records');

const svc = createService<operations>({
  service: 'records',
  spec,
  ready,
  onRequestEnd: obs.onRequestEnd, // RED metrics per route
  onError: obs.onError, // unexpected errors: name, code, stack (never the message)
});
svc.app.use('*', obs.middleware); // BEFORE svc.op(...): server span + one log line per request

const intake = createHttpClient({
  name: 'intake',
  baseUrl,
  headers: traceHeaders(serviceToken), // adds traceparent to the auth headers
  onCall: obs.onCall, // RED metrics per downstream
});

// In a handler
svc.op('createOffer', async (c, { body }) => {
  obs.loggerFor(c).info({ code: 'offer-created' }, 'offer created'); // correlationId, route, tenantId, userId bound
  await writeEvent(trx, { ...event, ...eventTrace() }); // the event carries the request's trace
});

// Drains
const result = await drainEvents(ctx, {
  queue: 'q_records',
  consumer: 'records',
  onError: obs.drainHooks.onError,
  handlers: {
    'offer.created.v1': (e, ctx) => withEventSpan(e, () => apply(e, ctx), { queue: 'q_records' }),
  },
});
obs.drainHooks.onResult('q_records', result);
obs.metrics.recordQueueDepth('q_records_dlq', await queueDepth(db, schema, 'q_records_dlq')); // DLQ alarm
obs.onRelay(await relayOutbox(ctx, { routes }), oldestUnpublishedAgeSeconds);

await telemetry.flush(); // serverless: before the function returns (e.g. waitUntil(telemetry.flush()))
```

## API

| Export                                                                                    | What it does                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `observe(service, { level?, destination?, redactMessage?, meter? })`                      | Everything above in one call: `{ logger, metrics, middleware, onRequestEnd, onError, onCall, drainHooks, onRelay, loggerFor }`.                                          |
| `createLogger({ service, level?, destination?, redactMessage? })`                         | The JSON logger. `logger.info(fields?, msg?)` / `logger.error(err, msg?)`, `logger.child(bindings)`.                                                                     |
| `setupTelemetry({ serviceName, serviceVersion?, env?, spanProcessors?, metricReaders? })` | Registers the W3C propagator and async context always; tracer and meter providers only when an exporter is configured. Returns `{ tracing, metrics, flush, shutdown }`.  |
| `tracingMiddleware(onEnd?)`                                                               | The Hono middleware inside `observe().middleware`: SERVER span per request, child of the incoming `traceparent`, named `METHOD /route/{template}`.                       |
| `traceHeaders(inner?)`, `injectTraceHeaders(headers?)`                                    | Outbound `traceparent`/`tracestate` from the active span. `traceHeaders` is a `headers()` provider for `createHttpClient`.                                               |
| `eventTrace()`, `currentTraceparent()`                                                    | `{ traceparent }` of the active span for `writeEvent`, or `{}` when there is no trace.                                                                                   |
| `withEventSpan(envelope, fn, { queue? })`                                                 | Runs a consumer handler in a CONSUMER span that is a child of the producer's span (from `envelope.traceparent`), so one trace spans request → outbox → queue → consumer. |
| `withSpan(name, fn, attributes?)`, `contextFromTraceparent(tp)`                           | Internal spans for jobs; the remote context of a `traceparent`.                                                                                                          |
| `createRedMetrics({ meter? })`                                                            | `recordRequest(RequestEndInfo)`, `recordCall(onCall info)`, `recordDrain(queue, DrainResult)`, `recordQueueDepth(queue, n)`, `recordRelay(RelayResult, lagSeconds?)`.    |
| `ALARM_RULES`, `p95TargetMs(service, route)`, `METRICS`                                   | Alarm definitions for F-15 to install, the p95 target per route, and the metric names.                                                                                   |
| `sanitizeFields`, `sanitizeError`, `scrubText`, `ALLOWED_LOG_FIELDS`                      | The allow-list machinery (exported for tests and for the per-service PII test).                                                                                          |

## No PII in logs (the allow-list)

Logs may be stored outside India (Vercel), so **only these fields reach the output**. Anything else is **dropped**
(not redacted in place): unknown keys, nested objects, arrays, and allowed keys whose value doesn't fit the field's
shape (e.g. a phone number in `code`, an object in `tenantId`). Child-logger bindings and the trace mixin go through
the same filter.

| Field                                                                                                                                    | Shape                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ts`, `level`                                                                                                                            | written by the logger (ISO 8601, level name)                                                                                               |
| `service`, `route`, `method`, `operationId`, `eventType`, `queue`, `code`, `errorName`, `downstream`, `outcome`                          | token: `[A-Za-z0-9_.:/{}*-]`, no spaces or `@`, no 7+ digit run, ≤ 160 chars                                                               |
| `correlationId`, `tenantId`, `userId`, `eventId`, `traceId`, `spanId`                                                                    | id: UUID, 16/32 hex, or `[A-Za-z0-9_-]` with no 7+ digit run                                                                               |
| `msgId`                                                                                                                                  | queue sequence: up to 9 digits                                                                                                             |
| `status`, `durationMs`, `attempt`, `count`, `processed`, `duplicates`, `failed`, `deadLettered`, `remaining`, `unroutable`, `lagSeconds` | integer 0 – 999,999                                                                                                                        |
| `err`                                                                                                                                    | `{ name, code?, stack? }`: the **message is dropped** (and the stack's first line, which repeats it); frames keep `dir/file:line:col` only |
| `msg`                                                                                                                                    | scrubbed: e-mail addresses and 7+ digit runs (every Indian phone format) become `[redacted]`                                               |

Write messages as constant text (`'offer created'`), and put IDs in fields. **Adding a field is a code review of
[`src/fields.ts`](src/fields.ts)**: never a runtime option. The `tests/logger.test.ts` suite proves that phone numbers
(20 Indian formats), e-mail addresses and names never reach the output from any position: arbitrary fields, nested
objects, arrays, allowed fields, child bindings, messages, error messages, codes, names and stacks.

`redactMessage` is the hook for `libs/redaction`: when given, error messages are kept after redaction (and still
scrubbed). Until then they are dropped.

Spans follow the same rule: attributes are route templates, methods, status codes, event types, queue names and error
class names (`error.type`). `recordException` is never used, because exception events carry the message. Metric labels
never include raw paths, query strings or IDs.

## Metrics (RED)

| Metric                                                        | Kind           | Labels                                                            |
| ------------------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `http.server.requests`, `http.server.errors` (5xx)            | counter        | `http.route`, `http.request.method`, `http.response.status_code`  |
| `http.server.request.duration`                                | histogram (ms) | `http.route`, `http.request.method`, `http.response.status_class` |
| `http.client.requests`, `http.client.errors` (5xx or network) | counter        | `downstream`, `http.request.method`, `outcome`                    |
| `http.client.request.duration`                                | histogram (ms) | same                                                              |
| `messaging.consumer.messages`                                 | counter        | `queue`, `outcome` (processed, duplicate, failed, dead_lettered)  |
| `messaging.consumer.drain.duration`                           | histogram (ms) | `queue`                                                           |
| `messaging.queue.depth`                                       | gauge          | `queue` (including `<queue>_dlq`)                                 |
| `outbox.relay.published`, `outbox.relay.unroutable`           | counter        | —                                                                 |
| `outbox.relay.backlog`, `outbox.relay.lag` (s)                | gauge          | —                                                                 |

Histogram buckets have edges at every p95 target (300 ms, 1 s, 2 s, 3 s, 15 s).

## Alarms (`ALARM_RULES`, installed by F-15)

| Rule               | Condition                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http-5xx-rate`    | `http.server.errors / http.server.requests > 2%` over 5 min                                                                                                                                                |
| `http-p95-latency` | p95 `http.server.request.duration` per route > `p95TargetMs(service, route)` over 10 min: 300 ms default; journeys My queue 1 s; insight dashboards 2 s, chat 15 s; `/internal/*` and `/health/*` excluded |
| `dlq-depth`        | `messaging.queue.depth{queue="*_dlq"} > 0`                                                                                                                                                                 |
| `relay-lag`        | `outbox.relay.lag > 300 s` over 5 min                                                                                                                                                                      |
| `relay-unroutable` | `outbox.relay.unroutable > 0` (contract drift, ticket)                                                                                                                                                     |

## Environment

| Variable                                                                                      | Effect                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                                                                                   | `trace` … `fatal` (default `info`)                                                                                                           |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `_METRICS_ENDPOINT`) | Enables OTLP/HTTP export of traces / metrics. Unset: no spans or metrics are created (no-op), but incoming `traceparent` is still forwarded. |
| `OTEL_EXPORTER_OTLP_HEADERS`                                                                  | Exporter auth headers (read by the OTLP exporters)                                                                                           |
| `OTEL_TRACES_SAMPLER_ARG`                                                                     | Root sampling ratio 0–1 (default 1; parent-based)                                                                                            |
| `OTEL_METRIC_EXPORT_INTERVAL`                                                                 | Metric export interval in ms (default 60,000)                                                                                                |
| `OTEL_SDK_DISABLED=true`                                                                      | Turns the SDK off                                                                                                                            |

On Vercel, call `telemetry.flush()` through `waitUntil` so spans and metrics are exported before the function freezes.

## Versions

`pino` 10.3.x, `@opentelemetry/api` 1.9.x, SDK packages 2.11.x (`sdk-trace-node`, `sdk-metrics`, `resources`, `core`,
`context-async-hooks`) with the 0.222.x OTLP/HTTP exporters. `@vercel/otel` is not used: it only wraps the same SDK and
would pull in the logs SDK and instrumentation peers; a plain OTLP endpoint works on Vercel and anywhere else.

## Tests

`pnpm --filter @11e/observability test`: the PII suite, child bindings, `traceparent` round trips, one trace across an
HTTP hop and an event hop (in-memory span exporter, `createService` with the records contract), RED metrics (in-memory
reader) and the no-exporter pass-through.
