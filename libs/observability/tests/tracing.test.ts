// Tracing across an HTTP hop and an event hop, the Hono middleware on a real contract service (records), and the
// RED metrics the hooks record. One telemetry setup for the file (the OTel globals are per process).
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { operations } from '@11e/contracts/records';
import { createHttpClient, createService } from '@11e/http';
import { buildEnvelope } from '@11e/outbox';
import type { EventEnvelope } from '@11e/outbox';
import {
  METRICS,
  contextFromTraceparent,
  currentTraceparent,
  eventTrace,
  injectTraceHeaders,
  observe,
  setupTelemetry,
  traceHeaders,
  withEventSpan,
  withSpan,
} from '../src/index.js';
import type { Observability, Telemetry } from '../src/index.js';
import { OFFER, TestMetricReader, memoryStream, recordsSpec } from './helpers.js';

const exporter = new InMemorySpanExporter();
const reader = new TestMetricReader();
let telemetry: Telemetry;

beforeAll(() => {
  telemetry = setupTelemetry({
    serviceName: 'records',
    env: {},
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    metricReaders: [reader],
  });
});
afterAll(async () => {
  await telemetry.shutdown();
});
beforeEach(() => exporter.reset());

const spans = () => exporter.getFinishedSpans();
const byName = (name: string): ReadableSpan => {
  const s = spans().find((x) => x.name === name);
  if (!s)
    throw new Error(
      `no span ${name}; have ${spans()
        .map((x) => x.name)
        .join(', ')}`,
    );
  return s;
};
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;

describe('setupTelemetry', () => {
  it('enables tracing and metrics when processors/readers are given, and is idempotent', () => {
    expect(telemetry.tracing).toBe(true);
    expect(telemetry.metrics).toBe(true);
    expect(setupTelemetry({ serviceName: 'other' })).toBe(telemetry);
  });
});

describe('traceparent propagation', () => {
  it('is absent outside a span', () => {
    expect(currentTraceparent()).toBeUndefined();
    expect(eventTrace()).toEqual({});
    expect(injectTraceHeaders({ a: 'b' })).toEqual({ a: 'b' });
  });

  it('round-trips: inject → header/envelope → extract gives the same span context', async () => {
    await withSpan('producer', (span) => {
      const tp = currentTraceparent();
      const { traceId, spanId } = span.spanContext();
      expect(tp).toBe(`00-${traceId}-${spanId}-01`);
      expect(injectTraceHeaders({ authorization: 'Bearer x' })).toEqual({
        authorization: 'Bearer x',
        traceparent: tp,
      });
      expect(eventTrace()).toEqual({ traceparent: tp });
      const remote = trace.getSpanContext(contextFromTraceparent(tp));
      expect(remote).toMatchObject({ traceId, spanId, isRemote: true });
    });
    expect(trace.getSpanContext(contextFromTraceparent('garbage'))).toBeUndefined();
    expect(trace.getSpanContext(contextFromTraceparent(undefined))).toBeUndefined();
  });

  it('traceHeaders() wraps an auth header provider for createHttpClient', async () => {
    await withSpan('caller', async () => {
      const headers = await traceHeaders(async () => ({ authorization: 'Bearer svc' }))();
      expect(headers['authorization']).toBe('Bearer svc');
      expect(headers['traceparent']).toMatch(TRACEPARENT);
    });
  });
});

describe('one trace across HTTP and event hops (records contract)', () => {
  let obs: Observability;
  let log: ReturnType<typeof memoryStream>;
  const outbound: Record<string, string>[] = [];
  let envelope: EventEnvelope | undefined;

  function service() {
    log = memoryStream();
    obs = observe('records', { destination: log.destination, level: 'debug' });
    const svc = createService<operations>({
      service: 'records',
      spec: recordsSpec,
      ready: async () => ({ ok: true }),
      validateResponses: true,
      onRequestEnd: obs.onRequestEnd,
      onError: obs.onError,
    });
    svc.app.use('*', obs.middleware);
    const intake = createHttpClient({
      name: 'intake',
      baseUrl: 'http://intake.test',
      headers: traceHeaders(() => ({ authorization: 'Bearer svc-token' })),
      onCall: obs.onCall,
      fetch: async (_url, init) => {
        outbound.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return Response.json({ ok: true });
      },
    });
    svc.op('getOffer', async (c) => {
      await intake.request('/v1/uploads/UPL-1');
      envelope = buildEnvelope({
        eventType: 'offer.created.v1',
        tenantId: '0190a5d8-7c3e-7b4a-9d1e-2f3a4b5c6d7e',
        aggregateType: 'offer',
        aggregateId: OFFER.id,
        aggregateVersion: 1,
        data: {} as never,
        correlationId: c.get('correlationId'),
        producer: 'records',
        ...eventTrace(),
      });
      obs.loggerFor(c).info({ phone: '9876543210' }, 'offer read');
      return c.json(OFFER, 200);
    });
    svc.op('listOffers', () => {
      throw new Error('db exploded for ramesh@example.com 9876543210');
    });
    return svc;
  }

  it('client span → server span → outbound call → event → consumer span', async () => {
    const svc = service();
    const res = await withSpan('web bff', () =>
      svc.app.request('/v1/offers/OFF-000001', { headers: injectTraceHeaders() }),
    );
    expect(res.status).toBe(200);

    const client = byName('web bff');
    const server = byName('GET /v1/offers/{idOrCode}');
    const traceId = client.spanContext().traceId;

    // HTTP hop: the server span continues the caller's trace.
    expect(server.kind).toBe(SpanKind.SERVER);
    expect(server.spanContext().traceId).toBe(traceId);
    expect(server.parentSpanContext?.spanId).toBe(client.spanContext().spanId);
    expect(server.attributes).toMatchObject({
      'http.route': '/v1/offers/{idOrCode}',
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'operation.id': 'getOffer',
    });

    // Outbound hop: the next service receives the server span as parent (plus the auth header).
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.['authorization']).toBe('Bearer svc-token');
    expect(outbound[0]?.['traceparent']).toBe(`00-${traceId}-${server.spanContext().spanId}-01`);

    // Event hop: the envelope carries the server span; the consumer span is its child in the same trace.
    expect(envelope?.traceparent).toBe(`00-${traceId}-${server.spanContext().spanId}-01`);
    exporter.reset();
    const inner = await withEventSpan(envelope as EventEnvelope, () => currentTraceparent(), {
      queue: 'q_journeys',
    });
    const consumer = byName('offer.created.v1 process');
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.spanContext().traceId).toBe(traceId);
    expect(consumer.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(consumer.attributes).toMatchObject({
      'messaging.destination.name': 'q_journeys',
      'event.type': 'offer.created.v1',
      'messaging.message.id': envelope?.eventId,
    });
    // Work inside the handler (e.g. its own writeEvent) continues from the consumer span.
    expect(inner).toBe(`00-${traceId}-${consumer.spanContext().spanId}-01`);

    // Log lines: request line with trace IDs, handler line bound to the request; the phone is dropped.
    const lines = log.lines();
    const request = lines.find((l) => l['msg'] === 'request');
    expect(request).toMatchObject({
      level: 'info',
      service: 'records',
      route: '/v1/offers/{idOrCode}',
      operationId: 'getOffer',
      method: 'GET',
      status: 200,
      traceId,
      spanId: server.spanContext().spanId,
    });
    expect(typeof request?.['durationMs']).toBe('number');
    expect(request?.['correlationId']).toBe(res.headers.get('x-correlation-id'));
    const handler = lines.find((l) => l['msg'] === 'offer read');
    expect(handler).toMatchObject({
      route: '/v1/offers/{idOrCode}',
      correlationId: request?.['correlationId'],
      traceId,
    });
    expect(log.raw()).not.toContain('9876543210');
  });

  it('a consumer span without traceparent starts a new trace; handler errors mark it failed and rethrow', async () => {
    const event = { eventType: 'offer.created.v1', eventId: '0190a5d8-7c3e-7b4a-9d1e-000000000001' };
    await expect(
      withEventSpan(event, () => {
        throw new TypeError('bad payload for 9876543210');
      }),
    ).rejects.toThrow(TypeError);
    const [span] = spans();
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['error.type']).toBe('TypeError');
    expect(span?.events).toEqual([]); // no recordException: messages may hold PII
  });

  it('500s: span marked failed without the message, error logged without PII, 5xx counted', async () => {
    const svc = service();
    const res = await svc.app.request('/v1/offers');
    expect(res.status).toBe(500);
    const server = byName('GET /v1/offers');
    expect(server.status.code).toBe(SpanStatusCode.ERROR);
    expect(server.attributes['error.type']).toBe('Error');
    expect(JSON.stringify([server.name, server.attributes, server.events, server.status])).not.toMatch(
      /9876543210|ramesh|exploded/,
    );

    const lines = log.lines();
    expect(lines.find((l) => l['msg'] === 'unhandled error')).toMatchObject({
      level: 'error',
      route: '/v1/offers',
      operationId: 'listOffers',
      err: { name: 'Error' },
    });
    expect(lines.find((l) => l['msg'] === 'request')).toMatchObject({ level: 'error', status: 500 });
    expect(log.raw()).not.toContain('9876543210');
    expect(log.raw()).not.toContain('ramesh');

    const errors = await reader.points(METRICS.httpServerErrors, { 'http.route': '/v1/offers' });
    expect(errors.map((p) => p.value)).toEqual([1]);
    const requests = await reader.points(METRICS.httpServerRequests, {
      'http.route': '/v1/offers/{idOrCode}',
    });
    expect(requests.reduce((n, p) => n + (p.value as number), 0)).toBeGreaterThanOrEqual(1);
    const calls = await reader.points(METRICS.httpClientRequests, { downstream: 'intake', outcome: '2xx' });
    expect(calls.length).toBe(1);
  });

  it('health checks (registered by createService before the middleware) stay out of traces and logs', async () => {
    const svc = service();
    expect((await svc.app.request('/health/live')).status).toBe(200);
    expect(spans()).toEqual([]);
    expect(log.lines()).toEqual([]);
  });
});
