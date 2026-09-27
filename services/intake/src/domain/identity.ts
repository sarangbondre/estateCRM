// External references, content hashes (idempotent upsert, LLD §4.5), deterministic ids (UUIDv5) and batch numbering
// (§4.6).
import { createHash } from 'node:crypto';

/** JSON with keys sorted at every level; undefined dropped; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(canon(value));
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Fields excluded from the content hash (CRM working columns, CR-006 Z-8). */
const HASH_EXCLUDED = new Set(['crmNotes', 'leadStatus', 'followUpDate', 'rowNo', 'sheetName']);

/** sha256 of the canonical normalised row (§4.5). Deterministic anonymised values keep it stable across uploads. */
export function contentHash(fields: Readonly<Record<string, unknown>>): string {
  const kept = Object.fromEntries(Object.entries(fields).filter(([k]) => !HASH_EXCLUDED.has(k)));
  return sha256Hex(canonicalJson(kept));
}

export interface ExternalIdentity {
  externalSource: 'extractor' | 'upload';
  externalRef: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/**
 * §4.5: record_id → (extractor, record_id); else external_id → (upload, `<templateId | sourceType:sourceDetail>:id`);
 * else (upload, `h:` + 24 hex of the content hash) so that an identical row repeats as unchanged.
 */
export function externalIdentity(input: {
  recordId: string | null;
  externalId: string | null;
  templateId: string | null;
  sourceType: string;
  sourceDetail: string | null;
  contentHash: string;
}): ExternalIdentity {
  if (input.recordId) return { externalSource: 'extractor', externalRef: input.recordId };
  if (input.externalId) {
    const scope = input.templateId ?? `${slug(input.sourceType)}:${slug(input.sourceDetail ?? '')}`;
    return { externalSource: 'upload', externalRef: `${scope}:${input.externalId}` };
  }
  return { externalSource: 'upload', externalRef: `h:${input.contentHash.slice(0, 24)}` };
}

/** RFC 4122 v5 (SHA-1, name-based) UUID in the namespace `ns` (a UUID). */
export function uuidV5(ns: string, name: string): string {
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([nsBytes, Buffer.from(name, 'utf8')]))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x50;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Row id: deterministic per (upload, row number), so a retried chunk inserts the same rows (ON CONFLICT DO NOTHING). */
export const rowIdFor = (uploadId: string, rowNo: number) => uuidV5(uploadId, `row:${rowNo}`);
export const reviewItemIdFor = (rowId: string) => uuidV5(rowId, 'review-item');
/** rows.classified.v1 aggregate id (§4.6): UUIDv5(uploadId, batch_no). */
export const batchAggregateId = (uploadId: string, batchNo: number) => uuidV5(uploadId, `batch:${batchNo}`);

export const BATCH_SIZE = 500;

/** §4.6: batchesPerChunk = ceil(chunk_size / 500); group k (1-based) of chunk c → (c − 1) × batchesPerChunk + k. */
export function batchNumbers(chunkSize: number, chunkNo: number, acceptedCount: number): number[] {
  const perChunk = Math.ceil(chunkSize / BATCH_SIZE);
  const groups = Math.ceil(acceptedCount / BATCH_SIZE);
  return Array.from({ length: groups }, (_, k) => (chunkNo - 1) * perChunk + k + 1);
}
