// Immutable audit log (US-35, web LLD §3 audit_log, §4.6): entry validation, PII scrubbing of `details` (defence in
// depth: producers must not send PII) and the per-tenant SHA-256 hash chain for tamper evidence. Pure.
import { WebError } from './errors';

export const PRODUCERS = [
  'web',
  'intake',
  'records',
  'journeys',
  'crm-engine',
  'listings',
  'insight',
] as const;
export type Producer = (typeof PRODUCERS)[number];
export type Via = 'ui' | 'chat' | 'system';

export interface AuditEntryInput {
  tenantId: string;
  eventId: string | null;
  occurredAt: Date;
  producer: Producer;
  action: string;
  actorUserId: string;
  subjectType: string;
  subjectId: string;
  via: Via;
  details: Record<string, string>;
  correlationId: string | null;
}

export interface AuditEntry extends AuditEntryInput {
  id: string;
  recordedAt: Date;
  prevHash: Uint8Array;
  entryHash: Uint8Array;
}

export const GENESIS_HASH: Uint8Array = new Uint8Array(32);
export const RETENTION_MONTHS = 24;

/**
 * Validates `details` (a flat string map) and removes values that look like contact PII. Returns the cleaned map and
 * whether something was removed (the caller raises an alarm). Non-string values are rejected (→ DLQ for events).
 */
export function scrubDetails(
  details: Record<string, unknown> | undefined,
  looksLikePii: (value: string) => boolean,
): { details: Record<string, string>; scrubbed: boolean } {
  const out: Record<string, string> = {};
  let scrubbed = false;
  for (const [k, v] of Object.entries(details ?? {})) {
    if (typeof v !== 'string') throw new WebError('validation-failed', `audit details.${k} must be a string`);
    if (looksLikePii(v) || looksLikePii(k)) {
      scrubbed = true;
      continue;
    }
    out[k] = v.slice(0, 500);
  }
  if (scrubbed) out['scrubbed'] = 'true';
  return { details: out, scrubbed };
}

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** The bytes the chain hashes for an entry (everything except the hashes themselves). */
export function chainPayload(e: Omit<AuditEntry, 'prevHash' | 'entryHash'>): string {
  return canonicalJson({
    id: e.id,
    tenantId: e.tenantId,
    eventId: e.eventId,
    occurredAt: e.occurredAt.toISOString(),
    recordedAt: e.recordedAt.toISOString(),
    producer: e.producer,
    action: e.action,
    actorUserId: e.actorUserId,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    via: e.via,
    details: e.details,
    correlationId: e.correlationId,
  });
}

/** entry_hash = sha256(prev_hash ‖ canonical_json(entry)). `sha256` is injected (pure domain). */
export function linkEntry(
  e: Omit<AuditEntry, 'prevHash' | 'entryHash'>,
  prevHash: Uint8Array,
  sha256: (data: Uint8Array) => Uint8Array,
): AuditEntry {
  const payload = new TextEncoder().encode(chainPayload(e));
  const buf = new Uint8Array(prevHash.length + payload.length);
  buf.set(prevHash, 0);
  buf.set(payload, prevHash.length);
  return { ...e, prevHash, entryHash: sha256(buf) };
}

/**
 * Re-verifies a run of entries in chain order (recorded_at, id). Returns the first broken entry id, or null. The first
 * entry's prevHash is trusted (the verify job runs over a 48 h window).
 */
export function verifyChain(entries: AuditEntry[], sha256: (data: Uint8Array) => Uint8Array): string | null {
  let prev: Uint8Array | null = null;
  for (const e of entries) {
    if (prev && !equalBytes(prev, e.prevHash)) return e.id;
    const expected = linkEntry(e, e.prevHash, sha256).entryHash;
    if (!equalBytes(expected, e.entryHash)) return e.id;
    prev = e.entryHash;
  }
  return null;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** `action=` filter: exact, or a prefix ending in ".*" (e.g. "export.*"). */
export function actionFilter(action: string): { exact: string } | { prefix: string } {
  return action.endsWith('.*') ? { prefix: action.slice(0, -1) } : { exact: action };
}
