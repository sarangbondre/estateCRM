// RED metrics (conventions §7, CLAUDE.md §3.7): rate, errors and duration per route, per downstream and per consumer,
// plus queue depth and relay backlog/lag for the alarms. Labels are PII-free: route templates, methods, status codes,
// downstream names, queue names and outcomes. Never raw paths, query strings or IDs.
import { metrics } from '@opentelemetry/api';
import type { Counter, Gauge, Histogram, Meter } from '@opentelemetry/api';
import type { RequestEndInfo } from '@11e/http';
import type { DrainResult, RelayResult } from '@11e/outbox';
import { INSTRUMENTATION_SCOPE } from './scope.js';

/** Metric names (also referenced by the alarm rules). Durations are in milliseconds. */
export const METRICS = Object.freeze({
  httpServerRequests: 'http.server.requests',
  httpServerErrors: 'http.server.errors',
  httpServerDuration: 'http.server.request.duration',
  httpClientRequests: 'http.client.requests',
  httpClientErrors: 'http.client.errors',
  httpClientDuration: 'http.client.request.duration',
  consumerMessages: 'messaging.consumer.messages',
  consumerDrainDuration: 'messaging.consumer.drain.duration',
  queueDepth: 'messaging.queue.depth',
  relayPublished: 'outbox.relay.published',
  relayUnroutable: 'outbox.relay.unroutable',
  relayBacklog: 'outbox.relay.backlog',
  relayLag: 'outbox.relay.lag',
});

/** Bucket boundaries (ms) with edges at the p95 targets: 300 ms, 1 s, 2 s, 3 s, 15 s. */
export const DURATION_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000, 15_000,
  30_000, 60_000,
];

/** The shape of `createHttpClient`'s `onCall` info. */
export interface CallInfo {
  name: string;
  method: string;
  path: string;
  status: number | 'error';
  durationMs: number;
  attempt: number;
}

export type ConsumerOutcome = 'processed' | 'duplicate' | 'failed' | 'dead_lettered';

export interface RedMetrics {
  /** `createService({ onRequestEnd })`. */
  recordRequest(info: Pick<RequestEndInfo, 'method' | 'route' | 'status' | 'durationMs'>): void;
  /** `createHttpClient({ onCall })`. The path is not recorded (it can hold IDs or query values). */
  recordCall(info: CallInfo): void;
  /** After each `drainEvents` / `drainWork` run. Also records the queue's remaining depth. */
  recordDrain(queue: string, result: DrainResult): void;
  /** Queue depth from `queueDepth()` (use it for `<queue>_dlq`: the DLQ alarm watches this). */
  recordQueueDepth(queue: string, depth: number): void;
  /** After each `relayOutbox` run. `lagSeconds` = age of the oldest unpublished outbox row, when known. */
  recordRelay(result: RelayResult, lagSeconds?: number): void;
}

interface Instruments {
  serverRequests: Counter;
  serverErrors: Counter;
  serverDuration: Histogram;
  clientRequests: Counter;
  clientErrors: Counter;
  clientDuration: Histogram;
  consumerMessages: Counter;
  drainDuration: Histogram;
  queueDepth: Gauge;
  relayPublished: Counter;
  relayUnroutable: Counter;
  relayBacklog: Gauge;
  relayLag: Gauge;
}

function instruments(meter: Meter): Instruments {
  const duration = (name: string, description: string) =>
    meter.createHistogram(name, {
      description,
      unit: 'ms',
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_MS] },
    });
  return {
    serverRequests: meter.createCounter(METRICS.httpServerRequests, { description: 'HTTP requests handled' }),
    serverErrors: meter.createCounter(METRICS.httpServerErrors, {
      description: 'HTTP requests answered 5xx',
    }),
    serverDuration: duration(METRICS.httpServerDuration, 'HTTP request duration'),
    clientRequests: meter.createCounter(METRICS.httpClientRequests, {
      description: 'Outbound HTTP attempts',
    }),
    clientErrors: meter.createCounter(METRICS.httpClientErrors, {
      description: 'Outbound HTTP attempts that failed (5xx, timeout, network)',
    }),
    clientDuration: duration(METRICS.httpClientDuration, 'Outbound HTTP attempt duration'),
    consumerMessages: meter.createCounter(METRICS.consumerMessages, {
      description: 'Queue messages by outcome (processed, duplicate, failed, dead_lettered)',
    }),
    drainDuration: duration(METRICS.consumerDrainDuration, 'Queue drain run duration'),
    queueDepth: meter.createGauge(METRICS.queueDepth, { description: 'Messages waiting in a queue' }),
    relayPublished: meter.createCounter(METRICS.relayPublished, { description: 'Outbox rows published' }),
    relayUnroutable: meter.createCounter(METRICS.relayUnroutable, {
      description: 'Outbox rows with no route (contract drift)',
    }),
    relayBacklog: meter.createGauge(METRICS.relayBacklog, { description: 'Unpublished outbox rows' }),
    relayLag: meter.createGauge(METRICS.relayLag, {
      description: 'Age of the oldest unpublished outbox row',
      unit: 's',
    }),
  };
}

const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/**
 * RED metric recorders. Instruments are created on first use from `meter` (default: the global meter provider), so
 * call `setupTelemetry` before the first request.
 */
export function createRedMetrics(options: { meter?: Meter } = {}): RedMetrics {
  let inst: Instruments | undefined;
  const get = () => (inst ??= instruments(options.meter ?? metrics.getMeter(INSTRUMENTATION_SCOPE)));

  return {
    recordRequest(info) {
      const i = get();
      const attrs = {
        'http.route': info.route,
        'http.request.method': info.method,
        'http.response.status_code': info.status,
      };
      i.serverRequests.add(1, attrs);
      if (info.status >= 500) i.serverErrors.add(1, attrs);
      i.serverDuration.record(info.durationMs, {
        'http.route': info.route,
        'http.request.method': info.method,
        'http.response.status_class': statusClass(info.status),
      });
    },
    recordCall(info) {
      const i = get();
      const outcome = info.status === 'error' ? 'error' : statusClass(info.status);
      const attrs = { downstream: info.name, 'http.request.method': info.method, outcome };
      i.clientRequests.add(1, attrs);
      if (info.status === 'error' || info.status >= 500) i.clientErrors.add(1, attrs);
      i.clientDuration.record(info.durationMs, attrs);
    },
    recordDrain(queue, result) {
      const i = get();
      const add = (outcome: ConsumerOutcome, n: number) => {
        if (n > 0) i.consumerMessages.add(n, { queue, outcome });
      };
      add('processed', result.processed);
      add('duplicate', result.duplicates);
      add('failed', result.failed);
      add('dead_lettered', result.deadLettered);
      i.drainDuration.record(result.durationMs, { queue });
      if (result.remaining !== null) i.queueDepth.record(result.remaining, { queue });
    },
    recordQueueDepth(queue, depth) {
      get().queueDepth.record(depth, { queue });
    },
    recordRelay(result, lagSeconds) {
      const i = get();
      if (result.processed > 0) i.relayPublished.add(result.processed);
      if (result.unroutable > 0) i.relayUnroutable.add(result.unroutable);
      i.relayBacklog.record(result.remaining);
      if (lagSeconds !== undefined) i.relayLag.record(lagSeconds);
    },
  };
}
