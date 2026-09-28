// Exports (LLD §4.9): CreateExport (validate a list plan, capped estimate vs the row cap, contact-column roles, 10 per
// hour, queue the job) → RunExportJob (keyset pages of 5,000 rows into a streaming xlsx; contacts fetched from
// records per page and written straight into the file, never stored; upload; completed + export.completed.v1 +
// audit.recorded.v1 in one transaction; 3 attempts then export.failed.v1) → ExpireExports (file deleted after 24 h).
import {
  CONTACT_BATCH,
  CONTACT_COLUMNS,
  EXPORTS_PER_HOUR,
  EXPORT_PAGE_ROWS,
  MAX_ATTEMPTS,
  SIGNED_URL_SECONDS,
  expiresAt,
  fileNameOf,
  filePathOf,
  mayExportContacts,
  overCap,
} from '../domain/exports/policy.js';
import type { QueryPlan } from '../domain/plans/types.js';
import type { ContactsReader, ExportJob, ExportRepo, FileStore, Ids, SpreadsheetWriter } from './ports.js';
import { columnsOf, shapeRows, validateFor } from './queries.js';
import type { Caller, QueryDeps } from './queries.js';

export interface ExportDeps {
  query: QueryDeps;
  exports: ExportRepo;
  files: FileStore;
  contacts: ContactsReader;
  sheets: SpreadsheetWriter;
  ids: Ids;
  maxRows: number;
}

export interface CreateExportInput {
  plan: QueryPlan;
  includeContacts?: boolean;
  fileName?: string;
  sourceMessageId?: string | null;
}

export type CreateExportOutcome =
  | { ok: true; job: ExportJob }
  | { ok: false; status: 400 | 403 | 422 | 429; code: string; detail?: string; errors?: { field: string; code: string; message: string }[] };

export async function createExport(deps: ExportDeps, caller: Caller, input: CreateExportInput): Promise<CreateExportOutcome> {
  const includeContacts = input.includeContacts ?? false;
  if (includeContacts && !mayExportContacts(caller.role))
    return { ok: false, status: 403, code: 'contacts-not-allowed', detail: `the ${caller.role} role may not export contact columns` };
  const { result } = await validateFor(deps.query, caller, input.plan);
  if (!result.ok) {
    if (result.code === 'not-allowed-for-role') return { ok: false, status: 403, code: 'forbidden', detail: result.errors[0]?.message ?? 'forbidden' };
    if (result.code === 'unknown-vocabulary-value') return { ok: false, status: 400, code: result.code, errors: result.errors };
    return { ok: false, status: 422, code: result.code, errors: result.errors };
  }
  const v = result.value;
  if (v.template.kind !== 'list')
    return { ok: false, status: 422, code: 'plan-invalid', errors: [{ field: 'plan.planId', code: 'not-a-list-plan', message: 'only list plans can be exported' }] };
  const now = deps.query.clock.now();
  const recent = await deps.exports.countSince(caller.tenantId, caller.userId, new Date(now.getTime() - 3_600_000));
  if (recent >= EXPORTS_PER_HOUR) return { ok: false, status: 429, code: 'rate-limited', detail: `at most ${EXPORTS_PER_HOUR} exports per hour` };
  const estimate = await deps.query.executor.execute(caller.tenantId, v, { now, limit: 1, withTotal: true });
  const estimatedRows = estimate.capped ? Number.MAX_SAFE_INTEGER : Number(estimate.total ?? 0);
  if (overCap(estimatedRows, deps.maxRows))
    return { ok: false, status: 422, code: 'export-too-large', detail: `more than ${deps.maxRows.toLocaleString('en-IN')} rows; narrow the filters` };
  const id = deps.ids.uuid();
  const job = await deps.exports.create(
    caller.tenantId,
    {
      id,
      requestedBy: caller.userId,
      requesterRole: caller.role,
      plan: v.plan,
      includeContacts,
      status: 'queued',
      estimatedRows: Math.min(estimatedRows, deps.maxRows),
      rowCount: null,
      filePath: null,
      fileBytes: null,
      sourceMessageId: input.sourceMessageId ?? null,
      attempts: 0,
      errorCode: null,
      completedAt: null,
      expiresAt: null,
    },
    (code) => fileNameOf(input.fileName, v.plan.planId, code),
    now,
  );
  return { ok: true, job };
}

/** The Export resource (contract): a fresh 10-minute signed URL on each read while completed and not expired. */
export async function exportView(deps: Pick<ExportDeps, 'files'>, job: ExportJob, now: Date) {
  const live = job.status === 'completed' && job.filePath && job.expiresAt && job.expiresAt > now;
  return {
    exportId: job.id,
    code: job.code,
    status: job.status,
    estimatedRows: job.estimatedRows,
    rowCount: job.rowCount,
    includesContacts: job.includeContacts,
    fileName: job.fileName,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    downloadUrl: live ? await deps.files.signedUrl(job.filePath as string, SIGNED_URL_SECONDS) : null,
    errorCode: job.errorCode,
    requestedBy: job.requestedBy,
  };
}

const joinUnique = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].join('; ');

/** One job (drain of q_insight_exports). Throws to retry; after 3 attempts the job fails with export.failed.v1. */
export async function runExportJob(deps: ExportDeps, payload: unknown, correlationId: string): Promise<'done' | 'skipped' | 'failed'> {
  const p = payload as { tenantId?: unknown; exportId?: unknown };
  if (typeof p.tenantId !== 'string' || typeof p.exportId !== 'string') return 'skipped';
  const now = deps.query.clock.now();
  const job = await deps.exports.claim(p.tenantId, p.exportId, now);
  if (!job) return 'skipped'; // finished already (duplicate delivery)
  const caller: Caller = { tenantId: p.tenantId, userId: job.requestedBy, role: job.requesterRole };
  try {
    const { result } = await validateFor(deps.query, caller, job.plan);
    if (!result.ok) {
      await deps.exports.fail(p.tenantId, job, 'plan-invalid', now, correlationId);
      return 'failed';
    }
    const v = result.value;
    const contacts = job.includeContacts && (v.template.base === 'offer' || v.template.base === 'demand');
    const columns = [...columnsOf(v), ...(contacts ? CONTACT_COLUMNS : [])];
    let rowCount = 0;
    const pages = async function* () {
      let cursor: string | null = null;
      for (let i = 0; i < 1_000; i++) {
        const exec = await deps.query.executor.execute(p.tenantId as string, v, {
          now,
          pageSize: EXPORT_PAGE_ROWS,
          cursor,
          ...(contacts ? { withContactIds: true } : {}),
        });
        const rows = shapeRows(v, exec);
        if (contacts) {
          const ids = [...new Set(exec.rows.flatMap((r) => (r['_contact_ids'] as string[] | null) ?? []))];
          const found = new Map<string, { name: string | null; phones: string[]; emails: string[] }>();
          for (let k = 0; k < ids.length; k += CONTACT_BATCH) {
            const batch = await deps.contacts.batch(p.tenantId as string, ids.slice(k, k + CONTACT_BATCH), job.id, job.requestedBy);
            for (const [id, c] of batch) found.set(id, c);
          }
          exec.rows.forEach((r, j) => {
            const people = ((r['_contact_ids'] as string[] | null) ?? []).map((id) => found.get(id)).filter((x) => !!x);
            const row = rows[j] as Record<string, unknown>;
            row['_contact_names'] = joinUnique(people.map((x) => x?.name));
            row['_contact_phones'] = joinUnique(people.flatMap((x) => x?.phones ?? []));
            row['_contact_emails'] = joinUnique(people.flatMap((x) => x?.emails ?? []));
          });
        }
        rowCount += rows.length;
        yield rows;
        cursor = exec.nextCursor;
        if (!cursor) return;
      }
    };
    const file = await deps.sheets.write(job.code, columns, pages());
    const path = filePathOf(p.tenantId, job.code);
    await deps.files.put(path, file, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const done = deps.query.clock.now();
    await deps.exports.complete(p.tenantId, job, {
      rowCount,
      filePath: path,
      fileBytes: file.byteLength,
      now: done,
      expiresAt: expiresAt(done),
      via: job.sourceMessageId ? 'chat' : 'ui',
      correlationId,
    });
    return 'done';
  } catch (err) {
    if (job.attempts >= MAX_ATTEMPTS) {
      const code = (err as { code?: string }).code === 'query-timeout' ? 'query-timeout' : (err as Error).name === 'DownstreamError' ? 'dependency-unavailable' : 'internal';
      await deps.exports.fail(p.tenantId, job, code, now, correlationId);
      return 'failed';
    }
    throw err;
  }
}

/** export-expire: delete files past their 24 h and mark the jobs expired (bounded batch). */
export async function expireExports(deps: Pick<ExportDeps, 'exports' | 'files' | 'query'>, batch = 100): Promise<{ processed: number; remaining: number }> {
  const now = deps.query.clock.now();
  const due = await deps.exports.expiring(now, batch);
  const paths = due.map((d) => d.filePath).filter((x): x is string => !!x);
  if (paths.length) await deps.files.remove(paths);
  for (const d of due) await deps.exports.markExpired(d.tenantId, d.id, now);
  return { processed: due.length, remaining: due.length >= batch ? 1 : 0 };
}
