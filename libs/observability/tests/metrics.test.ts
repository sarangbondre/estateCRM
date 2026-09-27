// RED metric recordings (in-memory reader, explicit meter: no globals), the drain/relay/client hooks, and the alarm
// rules exported for F-15.
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import type { Histogram } from '@opentelemetry/sdk-metrics';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DrainResult } from '@11e/outbox';
import {
  ALARM_RULES,
  DEFAULT_P95_TARGET_MS,
  METRICS,
  createRedMetrics,
  observe,
  p95TargetMs,
} from '../src/index.js';
import type { RedMetrics } from '../src/index.js';
import { TestMetricReader, memoryStream } from './helpers.js';

let reader: TestMetricReader;
let red: RedMetrics;
let provider: MeterProvider;

beforeEach(() => {
  reader = new TestMetricReader();
  provider = new MeterProvider({ readers: [reader] });
  red = createRedMetrics({ meter: provider.getMeter('test') });
});

const sum = async (name: string, attrs: Record<string, unknown> = {}) =>
  (await reader.points(name, attrs)).reduce((n, p) => n + (p.value as number), 0);

const drain = (r: Partial<DrainResult>): DrainResult => ({
  processed: 0,
  duplicates: 0,
  failed: 0,
  deadLettered: 0,
  remaining: 0,
  durationMs: 10,
  ...r,
});

describe('per route', () => {
  it('counts requests and 5xx errors and records duration with the route template', async () => {
    red.recordRequest({ method: 'GET', route: '/v1/offers/{idOrCode}', status: 200, durationMs: 40 });
    red.recordRequest({ method: 'GET', route: '/v1/offers/{idOrCode}', status: 404, durationMs: 5 });
    red.recordRequest({ method: 'GET', route: '/v1/offers/{idOrCode}', status: 503, durationMs: 2100 });
    red.recordRequest({ method: 'POST', route: '/v1/offers', status: 201, durationMs: 90 });

    expect(await sum(METRICS.httpServerRequests, { 'http.route': '/v1/offers/{idOrCode}' })).toBe(3);
    expect(await sum(METRICS.httpServerErrors, { 'http.route': '/v1/offers/{idOrCode}' })).toBe(1);
    expect(await sum(METRICS.httpServerErrors, { 'http.route': '/v1/offers' })).toBe(0);

    const hist = await reader.points(METRICS.httpServerDuration, {
      'http.route': '/v1/offers/{idOrCode}',
      'http.response.status_class': '2xx',
    });
    const value = hist[0]?.value as Histogram;
    expect(value.count).toBe(1);
    expect(value.sum).toBe(40);
    expect(value.buckets.boundaries).toContain(300);
    const m = await reader.metric(METRICS.httpServerDuration);
    expect(m?.descriptor.unit).toBe('ms');
  });
});

describe('per downstream', () => {
  it('counts attempts and failures (5xx and network errors) without the path', async () => {
    red.recordCall({
      name: 'intake',
      method: 'GET',
      path: '/v1/uploads/UPL-1?phone=9876543210',
      status: 200,
      durationMs: 30,
      attempt: 1,
    });
    red.recordCall({
      name: 'intake',
      method: 'GET',
      path: '/v1/uploads/UPL-1',
      status: 502,
      durationMs: 30,
      attempt: 1,
    });
    red.recordCall({
      name: 'intake',
      method: 'GET',
      path: '/v1/uploads/UPL-1',
      status: 'error',
      durationMs: 2000,
      attempt: 2,
    });

    expect(await sum(METRICS.httpClientRequests, { downstream: 'intake' })).toBe(3);
    expect(await sum(METRICS.httpClientErrors, { downstream: 'intake' })).toBe(2);
    expect(await sum(METRICS.httpClientErrors, { outcome: 'error' })).toBe(1);
    const all = await reader.points(METRICS.httpClientRequests);
    expect(JSON.stringify(all.map((p) => p.attributes))).not.toContain('/v1/uploads');
  });
});

describe('per consumer', () => {
  it('counts messages by outcome, records drain duration and queue depth', async () => {
    red.recordDrain(
      'q_records',
      drain({ processed: 7, duplicates: 1, failed: 2, deadLettered: 1, remaining: 40, durationMs: 800 }),
    );
    red.recordDrain('q_records', drain({ processed: 3, remaining: 12 }));
    red.recordDrain('q_records', drain({ remaining: null }));
    red.recordQueueDepth('q_records_dlq', 1);

    expect(await sum(METRICS.consumerMessages, { queue: 'q_records', outcome: 'processed' })).toBe(10);
    expect(await sum(METRICS.consumerMessages, { queue: 'q_records', outcome: 'duplicate' })).toBe(1);
    expect(await sum(METRICS.consumerMessages, { queue: 'q_records', outcome: 'failed' })).toBe(2);
    expect(await sum(METRICS.consumerMessages, { queue: 'q_records', outcome: 'dead_lettered' })).toBe(1);
    expect(
      ((await reader.points(METRICS.consumerDrainDuration, { queue: 'q_records' }))[0]?.value as Histogram)
        .count,
    ).toBe(3);
    // Gauge keeps the last value; `remaining: null` does not overwrite it.
    expect((await reader.points(METRICS.queueDepth, { queue: 'q_records' }))[0]?.value).toBe(12);
    expect((await reader.points(METRICS.queueDepth, { queue: 'q_records_dlq' }))[0]?.value).toBe(1);
  });

  it('records relay throughput, unroutable rows, backlog and lag', async () => {
    red.recordRelay({ processed: 120, unroutable: 2, remaining: 30, durationMs: 50 }, 42);
    expect(await sum(METRICS.relayPublished)).toBe(120);
    expect(await sum(METRICS.relayUnroutable)).toBe(2);
    expect((await reader.points(METRICS.relayBacklog))[0]?.value).toBe(30);
    expect((await reader.points(METRICS.relayLag))[0]?.value).toBe(42);
  });
});

describe('observe() hooks', () => {
  it('drain hooks log failures without PII and record consumer metrics', async () => {
    const log = memoryStream();
    const obs = observe('journeys', {
      destination: log.destination,
      meter: provider.getMeter('obs'),
      level: 'debug',
    });
    obs.drainHooks.onError(new Error('no demand for priya@example.com / +91 98765 43210'), {
      queue: 'q_journeys',
      msgId: '41',
      attempt: 3,
      eventType: 'offer.created.v1',
    });
    obs.drainHooks.onResult('q_journeys', drain({ processed: 5, deadLettered: 1, remaining: 2 }));
    obs.drainHooks.onResult('q_journeys', drain({ remaining: null }));
    obs.onRelay({ processed: 3, unroutable: 0, remaining: 0, durationMs: 9 }, 12.4);
    obs.onCall({
      name: 'records',
      method: 'GET',
      path: '/v1/offers?phone=9876543210',
      status: 'error',
      durationMs: 2001,
      attempt: 2,
    });

    const [failed, run, idle, relay, call] = log.lines();
    expect(failed).toMatchObject({
      level: 'warn',
      msg: 'message failed',
      queue: 'q_journeys',
      msgId: '41',
      attempt: 3,
      eventType: 'offer.created.v1',
      err: { name: 'Error' },
    });
    expect(run).toMatchObject({
      level: 'warn',
      msg: 'drain run',
      queue: 'q_journeys',
      processed: 5,
      deadLettered: 1,
      remaining: 2,
    });
    expect(idle).toMatchObject({ level: 'debug', msg: 'drain run' });
    expect(idle).not.toHaveProperty('remaining');
    expect(relay).toMatchObject({ level: 'info', msg: 'relay run', processed: 3, lagSeconds: 12 });
    expect(call).toMatchObject({
      level: 'warn',
      msg: 'downstream call failed',
      downstream: 'records',
      outcome: 'error',
      attempt: 2,
    });
    expect(log.raw()).not.toMatch(/priya|example|98765|9876543210|phone/);

    expect(await sum(METRICS.consumerMessages, { queue: 'q_journeys', outcome: 'processed' })).toBe(5);
    expect(await sum(METRICS.relayPublished)).toBe(3);
    expect(await sum(METRICS.httpClientErrors, { downstream: 'records' })).toBe(1);
  });
});

describe('alarm rules', () => {
  it('cover conventions §7: 5xx > 2% / 5 min, p95 over target / 10 min, DLQ depth > 0, relay lag > 5 min', () => {
    const byId = Object.fromEntries(ALARM_RULES.map((r) => [r.id, r]));
    expect(byId['http-5xx-rate']).toMatchObject({ threshold: 0.02, windowMinutes: 5, comparison: '>' });
    expect(byId['http-p95-latency']).toMatchObject({ threshold: 'p95-target', windowMinutes: 10 });
    expect(byId['dlq-depth']).toMatchObject({ threshold: 0, filter: { queue: '*_dlq' } });
    expect(byId['relay-lag']).toMatchObject({ threshold: 300 });
  });

  it('only reference metrics this lib emits', () => {
    const names = new Set<string>(Object.values(METRICS));
    for (const r of ALARM_RULES) {
      const e = r.expression;
      const used = e.kind === 'ratio' ? [e.numerator, e.denominator] : [e.metric];
      for (const m of used) expect(names.has(m), `${r.id} → ${m}`).toBe(true);
    }
  });

  it('p95 targets: 300 ms default, declared exceptions, no SLO for internal and health routes', () => {
    expect(p95TargetMs('records', '/v1/offers')).toBe(DEFAULT_P95_TARGET_MS);
    expect(p95TargetMs('journeys', '/v1/queues/me')).toBe(1_000);
    expect(p95TargetMs('insight', '/v1/dashboards/demand')).toBe(2_000);
    expect(p95TargetMs('insight', '/internal/v1/drain/{queue}')).toBeUndefined();
    expect(p95TargetMs('listings', '/health/ready')).toBeUndefined();
  });
});
