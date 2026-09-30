// Chunk worker (q_intake_chunks, LLD §4.3 steps 1–5): lease → read the chunk file → per row validate (strict) or
// translate + rules (mapping) → leftovers → reason codes, external refs, content hashes, unchanged detection → ONE
// write transaction (raw rows, row errors, review items, fingerprints, rows.classified.v1 per ≤ 500 accepted rows,
// review_item.created.v1, counters, chunk done, finalize when it was the last chunk).
import { redact } from '@11e/redaction';
import {
  batchAggregateId,
  batchNumbers,
  contentHash,
  externalIdentity,
  reviewItemIdFor,
  rowIdFor,
  BATCH_SIZE,
} from '../domain/identity.js';
import { primaryReason, uniqueCodes } from '../domain/reasons.js';
import {
  classificationOf,
  finaliseReasons,
  normaliseMapping,
  normaliseStrict,
  rejected,
} from '../domain/rows.js';
import type { NormalisedRow } from '../domain/rows.js';
import { MULTI_TARGETS, normaliseHeader } from '../domain/schema.js';
import type { TargetField } from '../domain/schema.js';
import { BUNDLED_LEGACY_TERMS, LegacyTable } from '../domain/translate.js';
import type { Upload } from '../domain/upload.js';
import type { EventDataMap } from '@11e/contracts/events';
import type { App } from './context.js';
import { classifyLeftovers } from './leftovers.js';
import type { ChunkRecord, RawRowRecord, ReviewItemRecord, RowErrorRecord } from './ports.js';
import { decodeChunk, partitionMonth } from './split.js';
import type { ChunkLine, ChunkMessage } from './split.js';

export const MAX_CHUNK_ATTEMPTS = 5;
const BUSY_RETRY_SEC = 5;

const legacyCache = new Map<string, LegacyTable>();

async function legacyTable(app: App, tenantId: string, version: string): Promise<LegacyTable> {
  const key = `${tenantId}:${version}`;
  let t = legacyCache.get(key);
  if (!t) {
    const rows = await app.uow.repos.vocabulary.legacyTerms(tenantId, version);
    t = new LegacyTable(rows.length ? rows : BUNDLED_LEGACY_TERMS);
    legacyCache.set(key, t);
  }
  return t;
}

/** Header cells → unique keys for raw_rows.original (a repeated header gets " (2)", " (3)" …). */
function originalKeys(header: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
}

type Getter = (f: TargetField) => string | null;

/** Accessor over one row's cells: by normalised header (strict) or through the column map + constants (mapping). */
function getterFactory(upload: Upload): (cells: readonly (string | null)[]) => Getter {
  const header = upload.header ?? [];
  if (upload.mode === 'strict') {
    const idx = new Map(header.map((h, i) => [normaliseHeader(h), i]));
    return (cells) => (f) => {
      const i = idx.get(f);
      return i === undefined ? null : (cells[i] ?? null);
    };
  }
  const map = upload.columnMap ?? {};
  const byTarget = new Map<string, number[]>();
  header.forEach((h, i) => {
    const t = map[h];
    if (t) byTarget.set(t, [...(byTarget.get(t) ?? []), i]);
  });
  const k = (upload.constants ?? {}) as Record<string, unknown>;
  const constants: Partial<Record<TargetField, string>> = {};
  if (typeof k['recordScope'] === 'string') constants.record_scope = k['recordScope'];
  if (typeof k['sourceName'] === 'string') constants.source_name = k['sourceName'];
  if (typeof k['sourceChannel'] === 'string') constants.source_channel = k['sourceChannel'];
  return (cells) => (f) => {
    const cols = byTarget.get(f);
    if (cols?.length) {
      const values = cols
        .map((i) => cells[i])
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      if (values.length)
        return MULTI_TARGETS.has(f) ? values.join(f === 'free_text' ? '\n' : '|') : (values[0] as string);
    }
    return constants[f] ?? null;
  };
}

interface Processed {
  line: ChunkLine;
  row: NormalisedRow;
  rowId: string;
  original: Record<string, string | null>;
  hash: string;
  source: 'extractor' | 'upload';
  ref: string;
  outcome: 'accepted' | 'rejected' | 'unchanged';
  needsReview: boolean;
  batchNo: number | null;
  usedModel: boolean;
}

/** q_intake_chunks handler: one chunk per message; safe to redeliver (lease + unique keys). */
export async function processChunk(app: App, msg: ChunkMessage): Promise<void> {
  const lease = await app.uow.transaction((tx) =>
    tx.repos.chunks.lease(
      msg.tenantId,
      msg.uploadId,
      msg.chunkNo,
      app.policy.chunkLeaseSec,
      app.policy.chunkConcurrency,
    ),
  );
  if (lease.outcome === 'busy') {
    // semaphore full: hand the message back later without spending one of its delivery attempts
    await app.uow.transaction((tx) => tx.queue.send('q_intake_chunks', { ...msg }, BUSY_RETRY_SEC));
    return;
  }
  if (lease.outcome === 'not-available') return;
  const chunk = lease.chunk;
  const upload = await app.uow.repos.uploads.find(msg.tenantId, msg.uploadId);
  if (!upload || upload.status !== 'processing') {
    await app.uow.repos.chunks.cancelQueued(msg.tenantId, msg.uploadId);
    return;
  }
  try {
    await runChunk(app, upload, chunk, msg.correlationId);
  } catch (err) {
    if (chunk.attempts >= MAX_CHUNK_ATTEMPTS) {
      await failChunk(app, upload, chunk, msg.correlationId, err instanceof Error ? err.name : 'error');
      return;
    }
    await app.uow.repos.chunks.release(msg.tenantId, msg.uploadId, msg.chunkNo);
    throw err;
  }
}

async function failChunk(app: App, upload: Upload, chunk: ChunkRecord, correlationId: string, code: string) {
  await app.uow.transaction(async (tx) => {
    await tx.repos.chunks.fail(upload.tenantId, upload.id, chunk.chunkNo, code.slice(0, 60));
    const u = await tx.repos.uploads.addCounts(upload.tenantId, upload.id, { chunksFailed: 1 });
    if (u.chunksDone + u.chunksFailed >= (u.chunkCount ?? 0)) {
      await tx.queue.send('q_intake_finalize', {
        tenantId: upload.tenantId,
        uploadId: upload.id,
        correlationId,
      });
    }
  });
}

async function runChunk(app: App, upload: Upload, chunk: ChunkRecord, correlationId: string): Promise<void> {
  const tenantId = upload.tenantId;
  const text = await readText(app, chunk.path);
  const lines = decodeChunk(text);
  const header = upload.header ?? [];
  const keys = originalKeys(header);
  const makeGetter = getterFactory(upload);
  const mode = upload.mode ?? 'strict';
  const version = upload.vocabularyVersion ?? 'v0.6';
  const table = mode === 'mapping' ? await legacyTable(app, tenantId, version) : undefined;
  const locality = await app.localities.resolver(tenantId);
  const options = { importCrmNotes: upload.importCrmNotes, locality };

  const rows = lines.map((line) => {
    const get = makeGetter(line.c);
    const opts = { ...options, duplicate: line.d === 1 };
    const row = table ? normaliseMapping(get, table, opts) : normaliseStrict(get, opts);
    return { line, row };
  });

  // Leftovers → (redacted) model; without one: model_unavailable (§4.8)
  const leftovers = rows.filter((r) => r.row.needsModel && !rejected(r.row)).map((r) => r.row);
  const model = leftovers.length
    ? await classifyLeftovers(app, leftovers)
    : { usedModel: new Set(), suggestions: new Map() };

  const processed: Processed[] = rows.map(({ line, row }) => {
    finaliseReasons(row, mode);
    const hash = contentHash(row.fields);
    const id = externalIdentity({
      recordId: row.recordId,
      externalId: row.externalId,
      templateId: upload.templateId,
      sourceType: upload.sourceType,
      sourceDetail: upload.sourceDetail,
      contentHash: hash,
    });
    const original: Record<string, string | null> = {};
    keys.forEach((k, i) => (original[k] = line.c[i] ?? null));
    return {
      line,
      row,
      rowId: rowIdFor(upload.id, line.r),
      original,
      hash,
      source: id.externalSource,
      ref: id.externalRef,
      outcome: rejected(row) ? 'rejected' : 'accepted',
      needsReview: row.extractorNeedsReview || row.reasons.length > 0,
      batchNo: null,
      usedModel: model.usedModel.has(row),
    };
  });

  // unchanged detection (§4.5)
  if (!upload.reprocessUnchanged) {
    for (const source of ['extractor', 'upload'] as const) {
      const cand = processed.filter((p) => p.outcome === 'accepted' && p.source === source);
      if (!cand.length) continue;
      const known = await app.uow.repos.fingerprints.getMany(
        tenantId,
        source,
        cand.map((p) => p.ref),
      );
      for (const p of cand) if (known.get(p.ref) === p.hash) p.outcome = 'unchanged';
    }
  }
  const accepted = processed.filter((p) => p.outcome === 'accepted');
  const batches = batchNumbers(upload.chunkSize ?? BATCH_SIZE, chunk.chunkNo, accepted.length);
  accepted.forEach((p, i) => (p.batchNo = batches[Math.floor(i / BATCH_SIZE)] ?? null));

  const now = app.clock.now();
  const month = partitionMonth(upload.startedAt ?? now);
  const raw: RawRowRecord[] = processed.map((p) => {
    const c = classificationOf(p.row.fields);
    const primary = primaryReason(p.row.reasons);
    return {
      id: p.rowId,
      tenantId,
      partitionMonth: month,
      uploadId: upload.id,
      chunkNo: chunk.chunkNo,
      batchNo: p.batchNo,
      rowNo: p.line.r,
      sheetName: upload.sheetName,
      original: p.original,
      normalised: p.row.fields,
      crmNote: p.row.crmNote,
      externalSource: p.source,
      externalRef: p.ref,
      parentExternalRef: p.row.parentRef,
      contentHash: p.hash,
      outcome: p.outcome,
      needsReview: p.needsReview,
      reviewReasonText: p.row.reviewReasonText,
      reasonCodes: uniqueCodes(p.row.reasons),
      primaryReasonCode: primary?.code ?? (p.needsReview ? 'other' : null),
      detailCode: primary?.detail ?? (p.needsReview ? 'extractor_flag' : null),
      recordScope: c.recordScope,
      side: c.side,
      market: c.market,
      segment: c.segment,
      dealTypes: c.dealTypes,
      propertyTypes: c.propertyTypes,
      usedModel: p.usedModel,
      anonymised: upload.anonymise,
    };
  });
  const errors: RowErrorRecord[] = processed.flatMap((p) =>
    p.row.issues.map((i) => ({
      id: app.ids.uuid(),
      tenantId,
      uploadId: upload.id,
      rowId: p.rowId,
      rowNo: p.line.r,
      sheetName: upload.sheetName,
      field: i.field,
      severity: i.severity,
      code: i.code,
      value: i.value,
      message: i.message,
    })),
  );
  const rawById = new Map(raw.map((r) => [r.id, r]));
  const reviews: ReviewItemRecord[] = accepted
    .filter((p) => p.needsReview)
    .map((p) => {
      const r = rawById.get(p.rowId) as RawRowRecord;
      const f = p.row.fields;
      return {
        id: reviewItemIdFor(p.rowId),
        tenantId,
        uploadId: upload.id,
        rowId: p.rowId,
        rowNo: p.line.r,
        externalRef: p.ref,
        reasonCode: r.primaryReasonCode ?? 'other',
        detailCode: r.detailCode ?? 'extractor_flag',
        reviewReasonText: p.row.reviewReasonText,
        current: { ...classificationOf(f) },
        suggested: model.suggestions.get(p.row) ?? null,
        context: {
          locality: f['locality'] ?? null,
          city: f['city'] ?? null,
          priceText: f['priceText'] ?? null,
          areaText: f['areaText'] ?? null,
          sideEvidence: f['sideEvidence'] ?? null,
          redactedText: typeof f['rawText'] === 'string' ? redact(f['rawText']).text : null,
        },
        vocabularyVersion: version,
      };
    });
  const counts = {
    accepted: accepted.length,
    rejected: processed.filter((p) => p.outcome === 'rejected').length,
    unchanged: processed.filter((p) => p.outcome === 'unchanged').length,
    needsReview: accepted.filter((p) => p.needsReview).length,
  };
  const unclassified = accepted.filter((p) => classificationOf(p.row.fields).recordScope === null).length;

  await app.uow.transaction(
    async (tx) => {
      const u = await tx.repos.uploads.find(tenantId, upload.id, { forUpdate: true });
      if (!u || u.status !== 'processing') return;
      await tx.repos.rawRows.insertMany(raw);
      await tx.repos.rowErrors.insertMany(errors);
      const inserted = new Set(await tx.repos.reviews.insertMany(reviews));
      for (const source of ['extractor', 'upload'] as const) {
        await tx.repos.fingerprints.upsertMany(
          tenantId,
          source,
          accepted
            .filter((p) => p.source === source)
            .map((p) => ({ externalRef: p.ref, contentHash: p.hash, uploadId: upload.id, rowId: p.rowId })),
        );
      }
      for (const [i, batchNo] of batches.entries()) {
        const group = accepted.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        await tx.events.emit({
          eventType: 'rows.classified.v1',
          tenantId,
          aggregateType: 'upload_batch',
          aggregateId: batchAggregateId(upload.id, batchNo),
          aggregateVersion: 1,
          correlationId,
          data: {
            uploadId: upload.id,
            batchNo,
            anonymised: upload.anonymise,
            migrationApplied: upload.hasMigrationMap,
            rows: group.map((p) => eventRow(p, rawById.get(p.rowId) as RawRowRecord, upload)),
          },
        });
      }
      for (const item of reviews) {
        if (!inserted.has(item.id)) continue;
        await tx.events.emit({
          eventType: 'review_item.created.v1',
          tenantId,
          aggregateType: 'review_item',
          aggregateId: item.id,
          aggregateVersion: 1,
          correlationId,
          data: {
            reviewItemId: item.id,
            uploadId: upload.id,
            rowId: item.rowId,
            reasonCode: item.reasonCode,
          },
        });
      }
      await tx.repos.chunks.finish(tenantId, upload.id, chunk.chunkNo, counts);
      const after = await tx.repos.uploads.addCounts(tenantId, upload.id, {
        ...counts,
        unclassified,
        chunksDone: 1,
        batchesEmitted: batches.length,
      });
      if (after.stage !== 'classifying')
        await tx.repos.uploads.update(tenantId, upload.id, { stage: 'classifying' });
      if (after.chunksDone + after.chunksFailed >= (after.chunkCount ?? 0)) {
        await tx.queue.send('q_intake_finalize', { tenantId, uploadId: upload.id, correlationId });
      }
    },
    { timeoutMs: 30_000 },
  );
}

type EventRow = EventDataMap['rows.classified.v1']['rows'][number];

/** rows.classified.v1 row: classification, review code, repeat and source fields, content hash. No PII (§4.6). */
function eventRow(p: Processed, r: RawRowRecord, upload: Upload): EventRow {
  const f = p.row.fields;
  const out: Record<string, unknown> = {
    rowId: p.rowId,
    externalRef: p.ref,
    parentExternalRef: r.parentExternalRef ?? undefined,
    splitIndex: f['splitIndex'] ?? undefined,
    recordScope: r.recordScope ?? undefined,
    side: r.side ?? undefined,
    dealTypes: r.dealTypes,
    market: r.market ?? undefined,
    segment: r.segment ?? undefined,
    propertyTypes: r.propertyTypes,
    needsReview: r.needsReview,
    reviewReasonCode: r.needsReview ? (r.primaryReasonCode ?? 'other') : undefined,
    possibleRepeatOf: f['possibleRepeatOf'] ?? undefined,
    firstSeenDate: f['firstSeenDate'] ?? undefined,
    lastSeenDate: f['lastSeenDate'] ?? undefined,
    timesSeen: f['timesSeen'] ?? undefined,
    sourceType: upload.sourceType,
    sourceName: f['sourceName'] ?? undefined,
    sourceDate: f['sourceDate'] ?? undefined,
    contentHash: p.hash,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as EventRow;
}

async function readText(app: App, path: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of await app.files.read(path)) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}
