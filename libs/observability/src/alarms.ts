// Alarm rules as data (conventions §7, capacity plan §2/§5, LLD NFR sections). F-15 installs them in the monitoring
// backend; this lib only defines them next to the metrics they watch, so names can't drift.
import { METRICS } from './metrics.js';

export type Comparison = '>' | '>=';

export interface AlarmRule {
  id: string;
  description: string;
  /** How the value is computed from the metric(s). */
  expression:
    | { kind: 'ratio'; numerator: string; denominator: string }
    | { kind: 'p95'; metric: string }
    | { kind: 'max'; metric: string }
    | { kind: 'sum'; metric: string };
  /** Label filters (a value ending in `*` is a prefix/suffix wildcard pattern). */
  filter?: Readonly<Record<string, string>>;
  /** Evaluate per value of these labels (plus service.name, always). */
  groupBy: readonly string[];
  comparison: Comparison;
  /** A number, or `'p95-target'` = the route's target from `p95TargetMs`. */
  threshold: number | 'p95-target';
  windowMinutes: number;
  severity: 'page' | 'ticket';
  source: string;
}

/** Default p95 target (NFR-2) and the declared exceptions per service and route template. */
export const DEFAULT_P95_TARGET_MS = 300;
export const P95_TARGET_OVERRIDES_MS: Readonly<Record<string, Readonly<Record<string, number>>>> =
  Object.freeze({
    journeys: {
      '/v1/queues/me': 1_000, // NFR-8 My queue ≤ 1 s
      '/v1/queues/me/sections/{section}': 1_000,
    },
    insight: {
      '/v1/dashboards/demand': 2_000, // insight LLD §4.8, dashboards ≤ 2 s
      '/v1/dashboards/supply': 2_000,
      '/v1/dashboards/scopes': 2_000,
      '/v1/dashboards/quality': 2_000,
      '/v1/chat/conversations/{conversationId}/messages': 15_000, // NFR-7 full answer ≤ 15 s (streamed)
    },
  });

/** Routes with no latency SLO: internal relay/drain/job endpoints (60 s budgets) and health checks. */
export const P95_EXCLUDED_ROUTE_PREFIXES: readonly string[] = ['/internal/', '/health/'];

/** The p95 target for a route, or undefined when the route has no latency SLO. */
export function p95TargetMs(service: string, route: string): number | undefined {
  if (P95_EXCLUDED_ROUTE_PREFIXES.some((p) => route.startsWith(p))) return undefined;
  return P95_TARGET_OVERRIDES_MS[service]?.[route] ?? DEFAULT_P95_TARGET_MS;
}

export const ALARM_RULES: readonly AlarmRule[] = Object.freeze([
  {
    id: 'http-5xx-rate',
    description: '5xx responses above 2% of requests over 5 minutes',
    expression: {
      kind: 'ratio',
      numerator: METRICS.httpServerErrors,
      denominator: METRICS.httpServerRequests,
    },
    groupBy: [],
    comparison: '>',
    threshold: 0.02,
    windowMinutes: 5,
    severity: 'page',
    source: 'conventions §7',
  },
  {
    id: 'http-p95-latency',
    description: 'p95 request duration above the route target over 10 minutes',
    expression: { kind: 'p95', metric: METRICS.httpServerDuration },
    groupBy: ['http.route'],
    comparison: '>',
    threshold: 'p95-target',
    windowMinutes: 10,
    severity: 'page',
    source: 'conventions §7, NFR-2/7/8, capacity plan §2',
  },
  {
    id: 'dlq-depth',
    description: 'A dead-letter queue holds messages',
    expression: { kind: 'max', metric: METRICS.queueDepth },
    filter: { queue: '*_dlq' },
    groupBy: ['queue'],
    comparison: '>',
    threshold: 0,
    windowMinutes: 1,
    severity: 'page',
    source: 'conventions §7, CLAUDE.md §3.4',
  },
  {
    id: 'relay-lag',
    description: 'Oldest unpublished outbox row older than 5 minutes',
    expression: { kind: 'max', metric: METRICS.relayLag },
    groupBy: [],
    comparison: '>',
    threshold: 300,
    windowMinutes: 5,
    severity: 'page',
    source: 'conventions §7, capacity plan §5',
  },
  {
    id: 'relay-unroutable',
    description: 'Outbox rows with no route (contract drift)',
    expression: { kind: 'sum', metric: METRICS.relayUnroutable },
    groupBy: [],
    comparison: '>',
    threshold: 0,
    windowMinutes: 5,
    severity: 'ticket',
    source: 'libs/outbox relayOutbox',
  },
] satisfies AlarmRule[]);
