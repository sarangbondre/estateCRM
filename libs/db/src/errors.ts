// Maps Postgres error codes to the few cases callers act on. Everything else is an internal error.
export type DbErrorKind =
  | 'unique-violation'
  | 'foreign-key-violation'
  | 'check-violation'
  | 'serialization-failure'
  | 'deadlock'
  | 'statement-timeout'
  | 'too-many-connections'
  | 'unknown';

const KINDS: Record<string, DbErrorKind> = {
  '23505': 'unique-violation',
  '23503': 'foreign-key-violation',
  '23514': 'check-violation',
  '40001': 'serialization-failure',
  '40P01': 'deadlock',
  '57014': 'statement-timeout',
  '53300': 'too-many-connections',
};

export interface DbErrorInfo {
  kind: DbErrorKind;
  code?: string;
  constraint?: string;
  /** Safe to retry the whole transaction. */
  retryable: boolean;
}

export function classifyDbError(err: unknown): DbErrorInfo {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const kind = (code && KINDS[code]) || 'unknown';
  const info: DbErrorInfo = {
    kind,
    retryable: kind === 'serialization-failure' || kind === 'deadlock' || kind === 'too-many-connections',
  };
  if (code) info.code = code;
  if (typeof e?.constraint === 'string') info.constraint = e.constraint;
  return info;
}
