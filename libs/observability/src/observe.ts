// One call wires logs, traces and RED metrics for a service (composition root only).
import type { MiddlewareHandler } from 'hono';
import type { RequestEndInfo, ServiceContext, ServiceEnv } from '@11e/http';
import type { DrainResult, RelayResult } from '@11e/outbox';
import type { RedactMessage } from './fields.js';
import { createLogger } from './logger.js';
import type { LogFields, LogLevel, Logger } from './logger.js';
import { createRedMetrics } from './metrics.js';
import type { CallInfo, RedMetrics } from './metrics.js';
import { tracingMiddleware } from './tracing.js';
import type { RequestSummary } from './tracing.js';
import type { Meter } from '@opentelemetry/api';
import type { DestinationStream } from 'pino';

export interface ObserveOptions {
  level?: LogLevel;
  destination?: DestinationStream;
  redactMessage?: RedactMessage;
  /** Default: the global meter provider (set by `setupTelemetry`). */
  meter?: Meter;
}

/** `drainEvents`/`drainWork` `onError` info. */
export interface DrainErrorInfo {
  queue: string;
  msgId: string;
  attempt: number;
  eventType?: string;
}

export interface Observability {
  logger: Logger;
  metrics: RedMetrics;
  /** `svc.app.use('*', obs.middleware)` before registering operations: server span + one log line per request. */
  middleware: MiddlewareHandler<ServiceEnv>;
  /** `createService({ onRequestEnd })`: RED metrics per route. */
  onRequestEnd: (info: RequestEndInfo) => void;
  /** `createService({ onError })`: logs the unexpected error (name, code, stack; never the message). */
  onError: (err: unknown, c: ServiceContext) => void;
  /** `createHttpClient({ onCall })`: RED metrics per downstream; failed attempts are logged at warn. */
  onCall: (info: CallInfo) => void;
  drainHooks: {
    /** `drainEvents(ctx, { ..., onError: obs.drainHooks.onError })`. */
    onError: (err: unknown, info: DrainErrorInfo) => void;
    /** Call with the `DrainResult` after each run: consumer metrics + a summary line. */
    onResult: (queue: string, result: DrainResult) => void;
  };
  /** Call with the `RelayResult` after each relay run (and the oldest-row age in seconds, when known). */
  onRelay: (result: RelayResult, lagSeconds?: number) => void;
  /** A logger bound to the request: correlationId, route, operationId, tenantId, userId. */
  loggerFor: (c: ServiceContext) => Logger;
}

function requestBindings(c: ServiceContext): LogFields {
  const operation = c.get('operation');
  const principal = c.get('principal') as { tenantId?: unknown; userId?: unknown } | null | undefined;
  return {
    correlationId: c.get('correlationId'),
    route: operation?.path ?? c.req.routePath,
    operationId: operation?.operationId,
    tenantId: principal?.tenantId,
    userId: principal?.userId,
  };
}

export function observe(service: string, options: ObserveOptions = {}): Observability {
  const logger = createLogger({
    service,
    ...(options.level ? { level: options.level } : {}),
    ...(options.destination ? { destination: options.destination } : {}),
    ...(options.redactMessage ? { redactMessage: options.redactMessage } : {}),
  });
  const red = createRedMetrics(options.meter ? { meter: options.meter } : {});

  const logRequest = (s: RequestSummary) => {
    const fields = { ...s }; // `error` is not allow-listed: dropped by the logger
    if (s.status >= 500) logger.error(fields, 'request');
    else logger.info(fields, 'request');
  };

  return {
    logger,
    metrics: red,
    middleware: tracingMiddleware(logRequest),
    onRequestEnd: (info) => red.recordRequest(info),
    onError: (err, c) => logger.child(requestBindings(c)).error({ err }, 'unhandled error'),
    onCall: (info) => {
      red.recordCall(info);
      if (info.status === 'error' || info.status >= 500) {
        logger.warn(
          {
            downstream: info.name,
            method: info.method,
            ...(info.status === 'error' ? { outcome: 'error' } : { status: info.status }),
            durationMs: info.durationMs,
            attempt: info.attempt,
          },
          'downstream call failed',
        );
      }
    },
    drainHooks: {
      onError: (err, info) => logger.warn({ ...info, err }, 'message failed'),
      onResult: (queue, result) => {
        red.recordDrain(queue, result);
        const busy = result.processed + result.duplicates + result.failed + result.deadLettered > 0;
        const fields = { queue, ...result, remaining: result.remaining ?? undefined };
        if (result.deadLettered > 0) logger.warn(fields, 'drain run');
        else if (busy) logger.info(fields, 'drain run');
        else logger.debug(fields, 'drain run');
      },
    },
    onRelay: (result, lagArg) => {
      const lagSeconds = lagArg ?? result.oldestPendingAgeSec ?? undefined;
      red.recordRelay(result, lagSeconds);
      const fields = {
        ...result,
        ...(lagSeconds !== undefined ? { lagSeconds: Math.round(lagSeconds) } : {}),
      };
      if (result.unroutable > 0) logger.warn(fields, 'relay run');
      else if (result.processed > 0) logger.info(fields, 'relay run');
      else logger.debug(fields, 'relay run');
    },
    loggerFor: (c) => logger.child(requestBindings(c)),
  };
}
