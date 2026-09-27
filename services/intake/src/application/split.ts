// Split job (q_intake_split, LLD §4.3, ADR-0005): streams the load sheet once into NDJSON chunk files of chunk_size
// rows (anonymised when the switch is on), parses the migration_map sheet, then in ONE transaction inserts the chunk
// plan and migration entries, re-keys fingerprints, sets `processing`, writes upload.started.v1 and queues one
// q_intake_chunks message per chunk. A redelivered message does nothing once the upload left `queued`.
import { MigrationMapParser } from '../domain/migration.js';
import { MIGRATION_SHEET, normaliseHeader } from '../domain/schema.js';
import { chunkPathFor } from '../domain/upload.js';
import type { Upload } from '../domain/upload.js';
import type { App, SystemActor } from './context.js';
import { failUpload } from './inspection.js';
import { UnreadableFileError } from './ports.js';
import type { ChunkRecord, RowErrorRecord } from './ports.js';

export interface ChunkMessage {
  tenantId: string;
  uploadId: string;
  chunkNo: number;
  correlationId: string;
}

/** One line of a chunk file: data row number and the cells in header order. */
export interface ChunkLine {
  r: number;
  c: (string | null)[];
  /** 1 = the row's external reference appeared earlier in the file (duplicate-external-ref). */
  d?: 1;
}

/** Column holding the row's external reference: record_id (strict or mapped), else a mapped external_id. */
export function refColumn(upload: Upload): number {
  const header = upload.header ?? [];
  if (upload.mode === 'strict') return header.findIndex((h) => normaliseHeader(h) === 'record_id');
  const map = upload.columnMap ?? {};
  const byTarget = (t: string) => header.findIndex((h) => map[h] === t);
  const rid = byTarget('record_id');
  return rid >= 0 ? rid : byTarget('external_id');
}

export const encodeChunk = (lines: readonly ChunkLine[]) =>
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

export function decodeChunk(text: string): ChunkLine[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ChunkLine);
}

/** First day of the month of `d` (UTC): the raw_rows partition of an upload (LLD §3.3). */
export const partitionMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export async function runSplit(app: App, msg: { tenantId: string; uploadId: string; correlationId: string }) {
  const actor: SystemActor = { kind: 'system', tenantId: msg.tenantId, correlationId: msg.correlationId };
  const upload = await app.uow.repos.uploads.find(msg.tenantId, msg.uploadId);
  if (!upload || upload.status !== 'queued' || !upload.chunkSize) return;

  let plan: SplitPlan;
  try {
    plan = await writeChunks(app, upload);
  } catch (err) {
    if (err instanceof UnreadableFileError) return failUpload(app, actor, upload.id, 'unreadable_file');
    if (err instanceof TooManyRows) return failUpload(app, actor, upload.id, 'too_many_rows');
    throw err;
  }

  const now = app.clock.now();
  const started = await app.uow.transaction(
    async (tx) => {
      const u = await tx.repos.uploads.find(msg.tenantId, upload.id, { forUpdate: true });
      if (!u || u.status !== 'queued') return false;
      await tx.repos.rawRows.ensurePartition(partitionMonth(now));
      await tx.repos.chunks.insertMany(plan.chunks);
      await tx.repos.migration.insertMany(msg.tenantId, u.id, plan.migration.entries, () => app.ids.uuid());
      await tx.repos.rowErrors.insertMany(plan.migrationErrors);
      if (plan.migration.entries.length)
        await tx.repos.fingerprints.rekey(msg.tenantId, plan.migration.entries);
      await tx.repos.uploads.update(msg.tenantId, u.id, {
        status: 'processing',
        stage: 'normalising',
        startedAt: now,
        chunkCount: plan.chunks.length,
        hasMigrationMap: u.hasMigrationMap || plan.migrationSheetFound,
        migrationEntries: plan.migration.entries.length,
      });
      await tx.repos.uploads.addCounts(msg.tenantId, u.id, { read: plan.rowCount });
      await tx.events.emit({
        eventType: 'upload.started.v1',
        tenantId: msg.tenantId,
        aggregateType: 'upload',
        aggregateId: u.id,
        aggregateVersion: 1,
        correlationId: msg.correlationId,
        data: {
          uploadId: u.id,
          code: u.code,
          mode: u.mode ?? 'strict',
          sourceType: u.sourceType,
          ...(u.sourceDetail ? { sourceDetail: u.sourceDetail } : {}),
          rowCount: plan.rowCount,
          anonymised: u.anonymise,
          uploadedBy: u.uploadedBy,
        },
      });
      for (const c of plan.chunks) {
        const m: ChunkMessage = {
          tenantId: msg.tenantId,
          uploadId: u.id,
          chunkNo: c.chunkNo,
          correlationId: msg.correlationId,
        };
        await tx.queue.send('q_intake_chunks', { ...m });
      }
      if (plan.chunks.length === 0) {
        await tx.queue.send('q_intake_finalize', {
          tenantId: msg.tenantId,
          uploadId: u.id,
          correlationId: msg.correlationId,
        });
      }
      return true;
    },
    { timeoutMs: 30_000 },
  );
  // Pilot anonymise switch (§4.9): no un-anonymised copy is kept once the anonymised chunks exist.
  if (started && upload.anonymise) {
    await app.files.remove([upload.storagePath]);
    await app.uow.repos.uploads.update(msg.tenantId, upload.id, { sourceFileDeletedAt: app.clock.now() });
  }
}

class TooManyRows extends Error {}

interface SplitPlan {
  chunks: ChunkRecord[];
  rowCount: number;
  migration: MigrationMapParser;
  migrationSheetFound: boolean;
  migrationErrors: RowErrorRecord[];
}

async function writeChunks(app: App, upload: Upload): Promise<SplitPlan> {
  const chunkSize = upload.chunkSize as number;
  const header = upload.header ?? [];
  const anonymise = upload.anonymise ? app.anonymiser(upload.tenantId, header) : undefined;
  const migration = new MigrationMapParser();
  const chunks: ChunkRecord[] = [];
  let buffer: ChunkLine[] = [];
  let rowCount = 0;
  let loadHeaderSeen = false;
  let migrationHeaderSeen = false;
  let migrationSheetFound = false;
  const refIdx = refColumn(upload);
  const seenRefs = new Set<string>();

  const flush = async () => {
    if (!buffer.length) return;
    const chunkNo = chunks.length + 1;
    const path = chunkPathFor(upload.tenantId, upload.id, chunkNo);
    await app.files.put(path, encodeChunk(buffer), 'application/x-ndjson');
    chunks.push({
      id: app.ids.uuid(),
      tenantId: upload.tenantId,
      uploadId: upload.id,
      chunkNo,
      rowFrom: (buffer[0] as ChunkLine).r,
      rowTo: (buffer[buffer.length - 1] as ChunkLine).r,
      path,
      status: 'queued',
      attempts: 0,
    });
    buffer = [];
  };

  const scan = await app.sheets.open(upload.storagePath);
  for await (const row of scan.rows) {
    if (row.sheet === upload.sheetName) {
      if (!loadHeaderSeen) {
        loadHeaderSeen = true;
        continue;
      }
      rowCount += 1;
      if (rowCount > app.policy.maxRows) throw new TooManyRows();
      const cells = header.map((_, i) => row.cells[i] ?? null);
      const line: ChunkLine = { r: row.rowNo - 1, c: anonymise ? anonymise(cells) : cells };
      const ref = refIdx >= 0 ? (cells[refIdx] ?? '').trim().toLowerCase() : '';
      if (ref) {
        if (seenRefs.has(ref)) line.d = 1;
        else seenRefs.add(ref);
      }
      buffer.push(line);
      if (buffer.length >= chunkSize) await flush();
    } else if (row.sheet !== null && normaliseHeader(row.sheet) === MIGRATION_SHEET) {
      migrationSheetFound = true;
      if (!migrationHeaderSeen) {
        migrationHeaderSeen = true;
        migration.header(row.rowNo, row.cells);
      } else migration.row(row.rowNo, row.cells);
    }
  }
  await flush();
  const migrationErrors: RowErrorRecord[] = migration.issues.map((i) => ({
    id: app.ids.uuid(),
    tenantId: upload.tenantId,
    uploadId: upload.id,
    rowId: null,
    rowNo: i.rowNo,
    sheetName: MIGRATION_SHEET,
    field: i.field,
    severity: 'error',
    code: 'migration-entry-invalid',
    value: null,
    message: i.message,
  }));
  return { chunks, rowCount, migration, migrationSheetFound, migrationErrors };
}
