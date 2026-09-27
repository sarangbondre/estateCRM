// OpenTelemetry tracing (conventions §7): one setup call per service, a server span per request, and W3C trace
// context carried on outbound HTTP (`traceparent` header) and on events (the envelope's optional `traceparent`).
// Span attributes are PII-free by construction: route templates (never raw paths or query strings), methods, status
// codes, event types, queue names and error class names (never error messages).
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  diag,
  metrics,
  propagation,
  trace,
} from '@opentelemetry/api';
import type { Attributes, Context, Span, TextMapGetter } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { IMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { MiddlewareHandler } from 'hono';
import type { ServiceEnv } from '@11e/http';
import { INSTRUMENTATION_SCOPE } from './scope.js';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  /** Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Extra span processors (tests: SimpleSpanProcessor + InMemorySpanExporter). Enables tracing. */
  spanProcessors?: SpanProcessor[];
  /** Extra metric readers (tests: an in-memory reader). Enables metrics. */
  metricReaders?: IMetricReader[];
}

export interface Telemetry {
  readonly tracing: boolean;
  readonly metrics: boolean;
  /** Export buffered spans and metrics now. Call before a serverless function returns (e.g. via waitUntil). */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

let installed: Telemetry | undefined;

const nonEmpty = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Registers the W3C propagator and an async-local context manager (always), plus a tracer provider and a meter
 * provider when an exporter is configured. With no OTLP endpoint (and no processors/readers passed in) it creates no
 * spans or metrics — the API stays a no-op — but still forwards incoming `traceparent` headers.
 *
 * Env: OTEL_SDK_DISABLED, OTEL_EXPORTER_OTLP_ENDPOINT (or _TRACES_/_METRICS_ variants), OTEL_EXPORTER_OTLP_HEADERS,
 * OTEL_TRACES_SAMPLER_ARG (root sampling ratio, default 1), OTEL_METRIC_EXPORT_INTERVAL (ms, default 60000).
 * Call once, at the composition root, before the first request. Later calls return the first handle.
 */
export function setupTelemetry(options: TelemetryOptions): Telemetry {
  if (installed) return installed;
  const env = options.env ?? process.env;
  const disabled = env['OTEL_SDK_DISABLED']?.toLowerCase() === 'true';

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const resource = resourceFromAttributes({
    'service.name': options.serviceName,
    ...(options.serviceVersion ? { 'service.version': options.serviceVersion } : {}),
  });

  const spanProcessors = [...(options.spanProcessors ?? [])];
  const metricReaders = [...(options.metricReaders ?? [])];
  if (!disabled) {
    if (nonEmpty(env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) || nonEmpty(env['OTEL_EXPORTER_OTLP_ENDPOINT']))
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
    if (
      nonEmpty(env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']) ||
      nonEmpty(env['OTEL_EXPORTER_OTLP_ENDPOINT'])
    ) {
      const interval = Number(env['OTEL_METRIC_EXPORT_INTERVAL'] ?? 60_000);
      metricReaders.push(
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: Number.isFinite(interval) && interval > 0 ? interval : 60_000,
        }),
      );
    }
  }

  let tracer: NodeTracerProvider | undefined;
  if (!disabled && spanProcessors.length) {
    const ratio = Number(env['OTEL_TRACES_SAMPLER_ARG'] ?? 1);
    tracer = new NodeTracerProvider({
      resource,
      spanProcessors,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1),
      }),
    });
    trace.setGlobalTracerProvider(tracer);
  }

  let meter: MeterProvider | undefined;
  if (!disabled && metricReaders.length) {
    meter = new MeterProvider({ resource, readers: metricReaders });
    metrics.setGlobalMeterProvider(meter);
  }

  const handle: Telemetry = {
    tracing: tracer !== undefined,
    metrics: meter !== undefined,
    flush: async () => {
      await Promise.all([tracer?.forceFlush(), meter?.forceFlush()]);
    },
    shutdown: async () => {
      await Promise.all([tracer?.shutdown(), meter?.shutdown()]);
      trace.disable();
      metrics.disable();
      propagation.disable();
      context.disable();
      diag.disable();
      installed = undefined;
    },
  };
  installed = handle;
  return handle;
}

// ---------------------------------------------------------------------------------------------------------------------
// Propagation

const headersGetter: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

/** Trace-context headers (`traceparent`, `tracestate`) for the active span, merged into `headers`. */
export function injectTraceHeaders(headers: Record<string, string> = {}, ctx: Context = context.active()) {
  const out = { ...headers };
  propagation.inject(ctx, out);
  return out;
}

/**
 * A `headers()` provider for `createHttpClient` that adds the active trace context. Wrap the auth provider with it:
 * `createHttpClient({ name, baseUrl, headers: traceHeaders(serviceToken) })`.
 */
export function traceHeaders(
  inner?: () => Promise<Record<string, string>> | Record<string, string>,
): () => Promise<Record<string, string>> {
  return async () => injectTraceHeaders(inner ? await inner() : {});
}

/** The active span's W3C `traceparent`, for `writeEvent({ ..., traceparent })`. Undefined when not tracing. */
export function currentTraceparent(ctx: Context = context.active()): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier['traceparent'];
}

/** `{ traceparent }` when there is an active trace, else `{}` — spread into `writeEvent` input. */
export function eventTrace(ctx: Context = context.active()): { traceparent?: string } {
  const traceparent = currentTraceparent(ctx);
  return traceparent ? { traceparent } : {};
}

/** The remote context carried by a `traceparent` (from an event envelope or a header value). */
export function contextFromTraceparent(
  traceparent: string | undefined,
  base: Context = ROOT_CONTEXT,
): Context {
  return traceparent ? propagation.extract(base, { traceparent }) : base;
}

// ---------------------------------------------------------------------------------------------------------------------
// Spans

const tracer = () => trace.getTracer(INSTRUMENTATION_SCOPE);

function errorName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(err.name) ? err.name : 'Error';
}

/** Marks a span failed with the error class only. Messages may contain PII, so `recordException` is never used. */
function failSpan(span: Span, err: unknown): void {
  span.setAttribute('error.type', errorName(err));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

async function runInSpan<T>(span: Span, ctx: Context, fn: (span: Span) => Promise<T> | T): Promise<T> {
  try {
    return await context.with(trace.setSpan(ctx, span), () => fn(span));
  } catch (err) {
    failSpan(span, err);
    throw err;
  } finally {
    span.end();
  }
}

/** Runs `fn` in an internal child span of the active one (jobs, batches). */
export function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: Attributes = {},
): Promise<T> {
  return runInSpan(tracer().startSpan(name, { attributes }), context.active(), fn);
}

/** The event fields `withEventSpan` reads (any contract envelope fits). */
export interface TracedEvent {
  eventType: string;
  eventId: string;
  traceparent?: string | undefined;
}

/**
 * Runs an event handler in a CONSUMER span whose parent is the producer's span (from the envelope's `traceparent`),
 * so one trace runs from the HTTP request through the outbox, relay and queue to every consumer. Without a
 * `traceparent` the span starts a new trace.
 */
export function withEventSpan<T>(
  event: TracedEvent,
  fn: (span: Span) => Promise<T> | T,
  options: { queue?: string } = {},
): Promise<T> {
  const parent = contextFromTraceparent(event.traceparent);
  const span = tracer().startSpan(
    `${event.eventType} process`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'pgmq',
        'messaging.operation.type': 'process',
        'messaging.message.id': event.eventId,
        'event.type': event.eventType,
        ...(options.queue ? { 'messaging.destination.name': options.queue } : {}),
      },
    },
    parent,
  );
  return runInSpan(span, parent, fn);
}

/** A principal as set by libs/auth (duck-typed so this lib doesn't depend on it). */
function principalIds(principal: unknown): { tenantId?: string; userId?: string } {
  if (typeof principal !== 'object' || principal === null) return {};
  const p = principal as { tenantId?: unknown; userId?: unknown };
  return {
    ...(typeof p.tenantId === 'string' ? { tenantId: p.tenantId } : {}),
    ...(typeof p.userId === 'string' ? { userId: p.userId } : {}),
  };
}

export interface RequestSummary {
  method: string;
  route: string;
  operationId: string | undefined;
  status: number;
  durationMs: number;
  correlationId: string | undefined;
  tenantId?: string;
  userId?: string;
  error?: unknown;
}

/**
 * Hono middleware: a SERVER span per request, child of the incoming `traceparent`, active while the handler runs (so
 * outbound calls and `writeEvent` pick it up). Register it on the service app before the routes:
 * `svc.app.use('*', tracingMiddleware())`. `onEnd` receives a PII-free summary (used by `observe()` for the log line).
 */
export function tracingMiddleware(onEnd?: (summary: RequestSummary) => void): MiddlewareHandler<ServiceEnv> {
  return async (c, next) => {
    const started = performance.now();
    const method = c.req.method;
    const parent = propagation.extract(ROOT_CONTEXT, c.req.raw.headers, headersGetter);
    const span = tracer().startSpan(
      method,
      { kind: SpanKind.SERVER, attributes: { 'http.request.method': method } },
      parent,
    );
    try {
      await context.with(trace.setSpan(parent, span), next);
    } finally {
      const operation = c.get('operation');
      const route = operation?.path ?? c.req.routePath;
      const status = c.res.status;
      span.updateName(`${method} ${route}`);
      span.setAttribute('http.route', route);
      span.setAttribute('http.response.status_code', status);
      if (operation?.operationId) span.setAttribute('operation.id', operation.operationId);
      if (status >= 500) failSpan(span, c.error);
      span.end();
      // Inside the span's context, so the request log line carries its trace and span IDs.
      const summary: RequestSummary = {
        method,
        route,
        operationId: operation?.operationId,
        status,
        durationMs: Math.round(performance.now() - started),
        correlationId: c.get('correlationId'),
        ...principalIds(c.get('principal')),
        ...(c.error ? { error: c.error } : {}),
      };
      if (onEnd) context.with(trace.setSpan(parent, span), () => onEnd(summary));
    }
  };
}
