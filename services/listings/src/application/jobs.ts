// Scheduled jobs (contract runJob enum, infra/schedules.yaml). Each runs one bounded batch and reports what remains.
import { scanText } from '../domain/privacy.js';
import type { SubjectType } from '../domain/types.js';
import type { Services } from './context.js';
import { reconcile } from './engine.js';
import { expireRotatedKeys } from './admin.js';

export interface SweepRow {
  tenantId: string;
  id: string;
  subjectType: SubjectType;
  subjectId: string;
}

/** Cross-tenant maintenance queries (job paths; documented exceptions to tenant-first, like R-4). */
export interface Maintenance {
  sweepBatch(afterId: string | null, limit: number): Promise<SweepRow[]>;
  allPublicationsAfter(after: { tenantId: string; id: string } | null, limit: number): Promise<SweepRow[]>;
  publicPayload(tenantId: string, id: string): Promise<Record<string, unknown> | undefined>;
  pruneChangeFeed(before: Date, limit: number): Promise<number>;
  pruneScans(before: Date, limit: number): Promise<number>;
  pruneRateLimits(before: Date, limit: number): Promise<number>;
  pruneTechnical(limit: number): Promise<number>;
  expiredRotatingKeys(now: Date, limit: number): Promise<{ tenantId: string; id: string }[]>;
  getCheckpoint(name: string): Promise<Record<string, unknown> | undefined>;
  setCheckpoint(name: string, cursor: Record<string, unknown>): Promise<void>;
}

export interface JobOutcome {
  processed: number;
  remaining: number;
  /** M8 output-audit hits (alarm). */
  auditHits?: { tenantId: string; publicId: string; kinds: string[] }[];
}

const BATCH = 500;
const PRUNE_BATCH = 5000;

/** Text fields of a public payload that the output audit re-scans (M8). */
function payloadTexts(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['label', 'headline', 'description', 'name', 'developerName', 'note']) {
    const v = payload[k];
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

/**
 * ceiling-sweep (04:30 IST, after the nightly life curve): recomputes every publication above Private (auto-downgrades
 * missed events) and re-scans every served payload with the §4.4 patterns (nightly output audit, M8 = 0).
 */
export async function ceilingSweep(s: Services, m: Maintenance): Promise<JobOutcome> {
  const cp = await m.getCheckpoint('ceiling-sweep');
  const after = typeof cp?.['after'] === 'string' ? cp['after'] : null;
  const rows = await m.sweepBatch(after, BATCH);
  const auditHits: NonNullable<JobOutcome['auditHits']> = [];
  for (const r of rows) {
    await s.uow.run(r.tenantId, 'job-ceiling-sweep', (store) =>
      reconcile(s, store, r.subjectType, r.subjectId),
    );
    const payload = await m.publicPayload(r.tenantId, r.id);
    if (!payload) continue;
    const ids = new Set(
      [payload['agentReraNumber'], payload['projectReraNumber']].filter(
        (x): x is string => typeof x === 'string',
      ),
    );
    const kinds = payloadTexts(payload).flatMap((t) =>
      scanText({ text: t, allowIds: ids })
        .filter((f) => f.severity === 'block')
        .map((f) => f.kind),
    );
    if (kinds.length) auditHits.push({ tenantId: r.tenantId, publicId: String(payload['publicId']), kinds });
  }
  const done = rows.length < BATCH;
  await m.setCheckpoint('ceiling-sweep', { after: done ? null : (rows.at(-1)?.id ?? null) });
  return { processed: rows.length, remaining: done ? 0 : 1, auditHits };
}

/** projection-refresh: rewrite every payload (settings or vocabulary change), resumable across tenants. */
export async function projectionRefresh(s: Services, m: Maintenance): Promise<JobOutcome> {
  const cp = await m.getCheckpoint('projection-refresh');
  const after =
    typeof cp?.['tenantId'] === 'string' && typeof cp['id'] === 'string'
      ? { tenantId: cp['tenantId'], id: cp['id'] }
      : null;
  const rows = await m.allPublicationsAfter(after, BATCH);
  for (const r of rows)
    await s.uow.run(r.tenantId, 'job-projection-refresh', (store) =>
      reconcile(s, store, r.subjectType, r.subjectId, { cascade: false, refresh: true }),
    );
  const last = rows.at(-1);
  const done = rows.length < BATCH;
  await m.setCheckpoint('projection-refresh', done || !last ? {} : { tenantId: last.tenantId, id: last.id });
  return { processed: rows.length, remaining: done ? 0 : 1 };
}

export async function changeFeedPrune(s: Services, m: Maintenance): Promise<JobOutcome> {
  const now = s.clock.now().getTime();
  const feed = await m.pruneChangeFeed(new Date(now - 30 * 86_400_000), PRUNE_BATCH);
  // Scan findings are kept 90 days (the latest per subject stays while it exists, LLD §7).
  const scans = await m.pruneScans(new Date(now - 90 * 86_400_000), PRUNE_BATCH);
  return { processed: feed + scans, remaining: feed === PRUNE_BATCH || scans === PRUNE_BATCH ? 1 : 0 };
}

export async function rateLimitPrune(s: Services, m: Maintenance): Promise<JobOutcome> {
  const n = await m.pruneRateLimits(new Date(s.clock.now().getTime() - 3_600_000), PRUNE_BATCH);
  return { processed: n, remaining: n === PRUNE_BATCH ? 1 : 0 };
}

/** idempotency-prune: expired Idempotency-Keys (24 h) plus processed_events (30 d) and published outbox rows (7 d). */
export async function idempotencyPrune(m: Maintenance): Promise<JobOutcome> {
  const n = await m.pruneTechnical(PRUNE_BATCH);
  return { processed: n, remaining: n >= PRUNE_BATCH ? 1 : 0 };
}

export async function apiKeyExpire(s: Services, m: Maintenance): Promise<JobOutcome> {
  const due = await m.expiredRotatingKeys(s.clock.now(), BATCH);
  const byTenant = new Map<string, string[]>();
  for (const k of due) byTenant.set(k.tenantId, [...(byTenant.get(k.tenantId) ?? []), k.id]);
  let n = 0;
  for (const [tenantId, ids] of byTenant) n += await expireRotatedKeys(s, tenantId, ids);
  return { processed: n, remaining: due.length === BATCH ? 1 : 0 };
}
