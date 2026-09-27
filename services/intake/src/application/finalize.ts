// Finalize (q_intake_finalize, LLD §4.3): any failed chunk → `failed` + upload.failed.v1 (chunk_failed; batches already
// emitted stay applied). Otherwise builds the rejected-rows CSV (original cells + an `error` column, streamed 1,000
// rows at a time), deletes the chunk files, sets `completed` and emits upload.completed.v1 (aggregate version 2) with
// counts and rejection reasons.
import { rejectedPathFor } from '../domain/upload.js';
import type { App, SystemActor } from './context.js';
import { failUpload } from './inspection.js';

const PAGE = 1000;
const REJECTED_FILE_DAYS = 7;
const SOURCE_FILE_DAYS = 30;

const csvCell = (v: string | null | undefined) => {
  const s = v ?? '';
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function runFinalize(
  app: App,
  msg: { tenantId: string; uploadId: string; correlationId: string },
) {
  const actor: SystemActor = { kind: 'system', tenantId: msg.tenantId, correlationId: msg.correlationId };
  const upload = await app.uow.repos.uploads.find(msg.tenantId, msg.uploadId);
  if (!upload || upload.status !== 'processing') return;
  if (upload.chunksDone + upload.chunksFailed < (upload.chunkCount ?? 0)) return; // not all chunks settled yet
  if (upload.chunksFailed > 0) return failUpload(app, actor, upload.id, 'chunk_failed');

  let rejectedPath: string | null = null;
  if (upload.counts.rejected > 0) {
    const header = upload.header ?? [];
    const lines = [[...header, 'error'].map(csvCell).join(',')];
    let after = 0;
    for (;;) {
      const rows = await app.uow.repos.rawRows.rejected(msg.tenantId, upload.id, after, PAGE);
      if (!rows.length) break;
      const errors = await app.uow.repos.rowErrors.forRows(
        msg.tenantId,
        upload.id,
        rows.map((r) => r.rowNo),
      );
      const byRow = new Map<number, string[]>();
      for (const e of errors)
        if (e.severity === 'error') byRow.set(e.rowNo, [...(byRow.get(e.rowNo) ?? []), e.message]);
      for (const r of rows) {
        const cells = Object.values(r.original);
        lines.push([...cells, (byRow.get(r.rowNo) ?? []).join('; ')].map(csvCell).join(','));
      }
      after = rows[rows.length - 1]?.rowNo ?? after;
      if (rows.length < PAGE) break;
    }
    rejectedPath = rejectedPathFor(msg.tenantId, upload.id);
    const BOM = String.fromCharCode(0xfeff); // Excel opens UTF-8 CSV correctly with a BOM
    await app.files.put(rejectedPath, `${BOM}${lines.join('\r\n')}\r\n`, 'text/csv');
  }
  await app.files.remove(await app.uow.repos.chunks.paths(msg.tenantId, upload.id));

  await app.uow.transaction(async (tx) => {
    const u = await tx.repos.uploads.find(msg.tenantId, upload.id, { forUpdate: true });
    if (!u || u.status !== 'processing') return;
    const now = app.clock.now();
    const day = 86_400_000;
    const cleanup = rejectedPath
      ? new Date(now.getTime() + REJECTED_FILE_DAYS * day)
      : u.sourceFileDeletedAt
        ? null
        : new Date(now.getTime() + SOURCE_FILE_DAYS * day);
    await tx.repos.uploads.update(msg.tenantId, u.id, {
      status: 'completed',
      stage: null,
      completedAt: now,
      rejectedFilePath: rejectedPath,
      rejectedFileReadyAt: rejectedPath ? now : null,
      batchCount: u.batchesEmitted,
      fileCleanupAt: cleanup,
      purgeAfter: new Date(now.getTime() + app.policy.rawRowRetentionDays * day),
    });
    await tx.events.emit({
      eventType: 'upload.completed.v1',
      tenantId: msg.tenantId,
      aggregateType: 'upload',
      aggregateId: u.id,
      aggregateVersion: 2,
      correlationId: msg.correlationId,
      data: {
        uploadId: u.id,
        code: u.code,
        counts: {
          read: u.counts.read,
          accepted: u.counts.accepted,
          rejected: u.counts.rejected,
          needsReview: u.counts.needsReview,
          unchanged: u.counts.unchanged,
        },
        rejectionReasons: await tx.repos.rowErrors.rejectionReasons(msg.tenantId, u.id),
        sourceType: u.sourceType,
        ...(u.sourceDetail ? { sourceDetail: u.sourceDetail } : {}),
        uploadedBy: u.uploadedBy,
      },
    });
  });
}
