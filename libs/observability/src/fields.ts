// The log-field allow-list (conventions §7, implementation rules §2.4). Anything not listed here is DROPPED, never
// redacted in place: a new field needs a code review of this file. Each field also has a value shape, and a value that
// doesn't fit its shape is dropped too (e.g. a phone number typed into `code`, or an object where an ID should be).
import { scrubText } from './pii.js';

/**
 * - `id`: an identifier (UUID, correlation ID, trace/span ID, pgmq message ID). `[A-Za-z0-9_-]`, ≤ 128 chars.
 * - `token`: a machine name (route template, operationId, event type, queue, error code). No spaces or '@', ≤ 160 chars.
 * - `seq`: a queue sequence number: up to 9 digits (10+ digits could be a phone number).
 * - `int`: a non-negative integer below 1,000,000 (larger numbers could be phone numbers).
 */
export type FieldKind = 'id' | 'seq' | 'token' | 'int';

export const ALLOWED_LOG_FIELDS: Readonly<Record<string, FieldKind>> = Object.freeze({
  // conventions §7 (`ts` and `level` are written by the logger itself)
  service: 'token',
  correlationId: 'id',
  tenantId: 'id',
  userId: 'id',
  route: 'token',
  status: 'int',
  durationMs: 'int',
  eventType: 'token',
  // reviewed additions (F-12)
  method: 'token',
  operationId: 'token',
  eventId: 'id',
  traceId: 'id',
  spanId: 'id',
  queue: 'token',
  msgId: 'seq',
  attempt: 'int',
  count: 'int',
  code: 'token',
  errorName: 'token',
  downstream: 'token',
  outcome: 'token',
  processed: 'int',
  duplicates: 'int',
  failed: 'int',
  deadLettered: 'int',
  remaining: 'int',
  unroutable: 'int',
  lagSeconds: 'int',
});

/** Keys with special handling: `err` is reduced by `sanitizeError`; `msg` is scrubbed by the logger. */
export const ERROR_FIELD = 'err';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^(?:[0-9a-f]{16}){1,2}$/;
const SEQ = /^\d{1,9}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_.:/{}*-]{1,160}$/;
const MAX_INT = 1_000_000;
const MAX_FRAMES = 20;

function validId(v: string): boolean {
  // UUIDs can hold long digit runs in their hex groups, so accept them by shape before the digit-run check.
  // Same for W3C trace (32 hex) and span (16 hex) IDs.
  return UUID.test(v) || HEX_ID.test(v) || (ID.test(v) && scrubText(v) === v);
}

/** The value if it fits the field's shape, otherwise undefined (dropped). */
export function sanitizeValue(kind: FieldKind, value: unknown): string | number | undefined {
  switch (kind) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_INT
        ? value
        : undefined;
    case 'id':
      return typeof value === 'string' && validId(value) ? value : undefined;
    case 'seq': {
      const v = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
      return typeof v === 'string' && SEQ.test(v) ? v : undefined;
    }
    case 'token':
      return typeof value === 'string' && TOKEN.test(value) && scrubText(value) === value ? value : undefined;
  }
}

// Frames keep the last directory + file:line:col. Full paths add nothing and can hold '@' (pnpm store) or user names.
const FRAME_PATH = /(?:file:\/\/)?(?:[^\s()]*\/)?([^\s()/]+\/[^\s()/]+:\d+:\d+)/g;
const shortenPaths = (frame: string) => frame.replace(FRAME_PATH, '$1');

/** Optional message redactor (libs/redaction, once available). Its output is still scrubbed. */
export type RedactMessage = (text: string) => string;

export interface SafeError {
  name: string;
  code?: string | number;
  message?: string;
  stack?: string;
}

/**
 * Reduces an error to name + stable code + stack frames. The message (and the first stack line, which repeats it) is
 * dropped because messages can contain PII — unless a `redactMessage` hook is given, in which case the redacted,
 * scrubbed message is kept.
 */
export function sanitizeError(err: unknown, redactMessage?: RedactMessage): SafeError {
  if (typeof err !== 'object' || err === null) return { name: 'NonError' };
  const e = err as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const name = sanitizeValue('token', e.name);
  const out: SafeError = { name: typeof name === 'string' ? name : 'Error' };
  const code = typeof e.code === 'number' ? sanitizeValue('int', e.code) : sanitizeValue('token', e.code);
  if (code !== undefined) out.code = code;
  if (redactMessage && typeof e.message === 'string') out.message = scrubText(redactMessage(e.message));
  if (typeof e.stack === 'string') {
    const frames = e.stack
      .split('\n')
      .filter((l) => /^\s*at /.test(l))
      .slice(0, MAX_FRAMES)
      .map((l) => scrubText(shortenPaths(l.trim())));
    if (frames.length) out.stack = frames.join('\n');
  }
  return out;
}

/**
 * Keeps only allow-listed fields with well-shaped values. Nested objects and arrays are dropped (no allow-listed
 * field is structured), except `err`, which becomes a `SafeError`.
 */
export function sanitizeFields(
  fields: Readonly<Record<string, unknown>>,
  redactMessage?: RedactMessage,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === ERROR_FIELD) {
      if (value !== undefined && value !== null) out[key] = sanitizeError(value, redactMessage);
      continue;
    }
    const kind = Object.hasOwn(ALLOWED_LOG_FIELDS, key) ? ALLOWED_LOG_FIELDS[key] : undefined;
    if (!kind) continue;
    const safe = sanitizeValue(kind, value);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}
