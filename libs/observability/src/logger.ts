// JSON logger (pino) with the PII allow-list (conventions §7). Logs can be stored outside India (Vercel), so nothing
// but allow-listed, well-shaped fields reaches the output: every call, every child binding and every mixin value goes
// through `sanitizeFields`, and the message is scrubbed of phone numbers and e-mail addresses.
import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';
import type { DestinationStream, Level, Logger as PinoLogger } from 'pino';
import { sanitizeFields } from './fields.js';
import type { RedactMessage } from './fields.js';
import { scrubText } from './pii.js';

export type LogLevel = Level;
/** Structured log fields. Only allow-listed keys survive (see ALLOWED_LOG_FIELDS). */
export type LogFields = Readonly<Record<string, unknown>>;

type LogFn = {
  (msg: string): void;
  (fields: LogFields | Error, msg?: string): void;
};

export interface Logger {
  readonly trace: LogFn;
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
  readonly fatal: LogFn;
  /** A logger with these fields bound to every line (e.g. correlationId, tenantId, userId, route). */
  child(bindings: LogFields): Logger;
  isLevelEnabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  service: string;
  /** Default: env LOG_LEVEL, else 'info'. */
  level?: LogLevel;
  /** Default: stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
  /** libs/redaction hook: when given, error messages are kept after redaction (and scrubbing). */
  redactMessage?: RedactMessage;
}

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function levelFromEnv(): LogLevel {
  const v = process.env['LOG_LEVEL'];
  return (LEVELS as readonly string[]).includes(v ?? '') ? (v as LogLevel) : 'info';
}

/** Adds the active trace and span IDs so log lines join up with traces. */
function traceFields(): Record<string, string> {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && isSpanContextValid(ctx) ? { traceId: ctx.traceId, spanId: ctx.spanId } : {};
}

function wrap(p: PinoLogger, redactMessage: RedactMessage | undefined): Logger {
  const logFn =
    (level: LogLevel): LogFn =>
    (first: LogFields | Error | string, msg?: string): void => {
      if (!p.isLevelEnabled(level)) return;
      let fields: LogFields = {};
      let message = msg;
      if (typeof first === 'string') message = first;
      else if (first instanceof Error) fields = { err: first };
      else if (typeof first === 'object' && first !== null) fields = first;
      const safe = sanitizeFields(fields, redactMessage);
      // Always pass a message: with none, pino would fall back to the error's own message (possible PII).
      p[level](safe, typeof message === 'string' ? scrubText(message) : '');
    };
  return {
    trace: logFn('trace'),
    debug: logFn('debug'),
    info: logFn('info'),
    warn: logFn('warn'),
    error: logFn('error'),
    fatal: logFn('fatal'),
    child: (bindings) => wrap(p.child(sanitizeFields(bindings, redactMessage)), redactMessage),
    isLevelEnabled: (level) => p.isLevelEnabled(level),
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const { redactMessage } = options;
  const p = pino(
    {
      level: options.level ?? levelFromEnv(),
      base: sanitizeFields({ service: options.service }),
      messageKey: 'msg',
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      mixin: traceFields,
      formatters: {
        level: (label) => ({ level: label }),
        // Defence in depth: the wrapper already sanitised; this also covers the mixin output.
        log: (obj) => sanitizeFields(obj, redactMessage),
        bindings: (b) => sanitizeFields(b, redactMessage),
      },
      // The default err serializer would put the message back; errors are already SafeError objects.
      serializers: { err: (e: unknown) => e },
    },
    options.destination ?? pino.destination({ dest: 1, sync: false }),
  );
  return wrap(p, redactMessage);
}
