// Without an exporter the SDK stays off (no spans, no metrics) but trace context still passes through a service, and
// an OTLP endpoint in the environment switches exporting on.
import { trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import type { operations } from '@11e/contracts/records';
import { createHttpClient, createService } from '@11e/http';
import { eventTrace, observe, setupTelemetry, traceHeaders } from '../src/index.js';
import { OFFER, memoryStream, recordsSpec } from './helpers.js';

const INCOMING = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('setupTelemetry without exporters', () => {
  it('creates no spans but forwards the incoming traceparent to outbound calls and events', async () => {
    const telemetry = setupTelemetry({ serviceName: 'records', env: {} });
    expect(telemetry).toMatchObject({ tracing: false, metrics: false });

    const log = memoryStream();
    const obs = observe('records', { destination: log.destination });
    const svc = createService<operations>({
      service: 'records',
      spec: recordsSpec,
      ready: async () => ({ ok: true }),
      onRequestEnd: obs.onRequestEnd,
    });
    svc.app.use('*', obs.middleware);
    const sent: (string | null)[] = [];
    const client = createHttpClient({
      name: 'intake',
      baseUrl: 'http://intake.test',
      headers: traceHeaders(),
      fetch: async (_u, init) => {
        sent.push(new Headers(init?.headers).get('traceparent'));
        return Response.json({});
      },
    });
    let event: { traceparent?: string } = {};
    svc.op('getOffer', async (c) => {
      expect(trace.getActiveSpan()?.isRecording()).toBe(false);
      await client.request('/v1/uploads/UPL-1');
      event = eventTrace();
      return c.json(OFFER, 200);
    });

    const res = await svc.app.request('/v1/offers/OFF-1', { headers: { traceparent: INCOMING } });
    expect(res.status).toBe(200);
    expect(sent).toEqual([INCOMING]);
    expect(event).toEqual({ traceparent: INCOMING });
    // The request line is still written, with the incoming trace ID.
    expect(log.lines()[0]).toMatchObject({
      msg: 'request',
      status: 200,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
    await telemetry.shutdown();
  });

  it('turns exporting on when an OTLP endpoint is configured, and off with OTEL_SDK_DISABLED', async () => {
    const on = setupTelemetry({
      serviceName: 'records',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' },
    });
    expect(on).toMatchObject({ tracing: true, metrics: true });
    await on.shutdown();
    const off = setupTelemetry({
      serviceName: 'records',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', OTEL_SDK_DISABLED: 'true' },
    });
    expect(off).toMatchObject({ tracing: false, metrics: false });
    await off.shutdown();
  });
});
