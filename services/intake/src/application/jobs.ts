// Scheduled jobs (intake.yaml jobs enum, infra/schedules.yaml). Each run is bounded by a time budget and batch sizes
// and reports `remaining` so the scheduler (pg_cron + pokes) can continue.
import { MAX_CHUNK_ATTEMPTS } from './chunk.js';
import type { App } from './context.js';

const BUDGET_MS = 45_000;
const DAY = 86_400_000;
const REJECTED_FILE_DAYS = 7;
const SOURCE_FILE_DAYS = 30;

export interface JobOutcome {
  processed: number;
  remaining: number;
}

/**
 * retention-purge (R-15: raw rows 30 days pilot / 24 months after completion): deletes an upload's raw rows, row errors
 * and review items (PII) in bounded batches, then marks it purged. The upload summary row itself is kept.
 */
export async function retentionPurge(app: App, now = app.clock.now()): Promise<JobOutcome> {
  const started = Date.now();
  let processed = 0;
  const due = await app.uow.repos.uploads.purgeDue(now, 20);
  let remaining = 0;
  for (const u of due) {
    if (Date.now() - started > BUDGET_MS) {
      remaining++;
      continue;
    }
    for (;;) {
      const n =
        (await app.uow.repos.rawRows.purge(u.tenantId, u.id, 5000)) +
        (await app.uow.repos.rowErrors.purge(u.tenantId, u.id, 5000)) +
        (await app.uow.repos.reviews.purge(u.tenantId, u.id, 5000));
      if (n === 0) break;
      if (Date.now() - started > BUDGET_MS) break;
    }
    if (Date.now() - started <= BUDGET_MS) {
      await app.uow.repos.uploads.update(u.tenantId, u.id, { purgedAt: now });
      processed++;
    } else remaining++;
  }
  if (due.length === 20) remaining++;
  return { processed, remaining };
}

/**
 * reap-chunk-leases: a lease that expired means the worker died. The chunk is queued again (and its message re-sent),
 * or failed after the last attempt; the last settled chunk queues finalize.
 */
export async function reapChunkLeases(app: App, now = app.clock.now()): Promise<JobOutcome> {
  const expired = await app.uow.repos.chunks.expiredLeases(now, 100);
  for (const c of expired) {
    await app.uow.transaction(async (tx) => {
      if (c.attempts >= MAX_CHUNK_ATTEMPTS) {
        await tx.repos.chunks.fail(c.tenantId, c.uploadId, c.chunkNo, 'lease_expired');
        const u = await tx.repos.uploads.addCounts(c.tenantId, c.uploadId, { chunksFailed: 1 });
        if (u.status === 'processing' && u.chunksDone + u.chunksFailed >= (u.chunkCount ?? 0)) {
          await tx.queue.send('q_intake_finalize', {
            tenantId: c.tenantId,
            uploadId: c.uploadId,
            correlationId: 'reap-chunk-leases',
          });
        }
      } else {
        await tx.repos.chunks.release(c.tenantId, c.uploadId, c.chunkNo);
        await tx.queue.send('q_intake_chunks', {
          tenantId: c.tenantId,
          uploadId: c.uploadId,
          chunkNo: c.chunkNo,
          correlationId: 'reap-chunk-leases',
        });
      }
    });
  }
  return { processed: expired.length, remaining: expired.length === 100 ? 1 : 0 };
}

/**
 * delete-processed-files (LLD §7): rejected-rows files 7 days after completion; source files 30 days after
 * completion (anonymised sources are already gone after the split); abandoned or failed uploads' sources when due.
 */
export async function deleteProcessedFiles(app: App, now = app.clock.now()): Promise<JobOutcome> {
  const due = await app.uow.repos.uploads.fileCleanupDue(now, 50);
  for (const u of due) {
    const paths: string[] = [];
    const done = u.completedAt ?? u.createdAt;
    let rejectedGone = !u.rejectedFilePath;
    if (u.rejectedFilePath && now.getTime() >= done.getTime() + REJECTED_FILE_DAYS * DAY) {
      paths.push(u.rejectedFilePath);
      rejectedGone = true;
    }
    let sourceGone = u.sourceFileDeletedAt !== null;
    const sourceDue = u.status !== 'completed' || now.getTime() >= done.getTime() + SOURCE_FILE_DAYS * DAY;
    if (!sourceGone && sourceDue && !['processing', 'queued', 'inspecting'].includes(u.status)) {
      paths.push(u.storagePath);
      sourceGone = true;
    }
    if (paths.length) await app.files.remove(paths);
    const next = !sourceGone
      ? new Date(Math.max(now.getTime() + DAY, done.getTime() + SOURCE_FILE_DAYS * DAY))
      : !rejectedGone
        ? new Date(done.getTime() + REJECTED_FILE_DAYS * DAY)
        : null;
    await app.uow.repos.uploads.update(u.tenantId, u.id, {
      fileCleanupAt: next,
      ...(sourceGone && !u.sourceFileDeletedAt ? { sourceFileDeletedAt: now } : {}),
      ...(u.rejectedFilePath && rejectedGone ? { rejectedFilePath: null, rejectedFileReadyAt: null } : {}),
    });
  }
  return { processed: due.length, remaining: due.length === 50 ? 1 : 0 };
}
