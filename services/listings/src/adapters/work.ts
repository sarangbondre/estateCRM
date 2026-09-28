// Private work queue q_listings_photos: photo renditions, public copies, scan-term and micromarket refreshes and
// projection-refresh batches (application/work.ts). Items are idempotent by construction (state checks per item).
import type { WorkHandler } from '@11e/outbox';
import type { WorkItem } from '../application/ports.js';
import { runWork } from '../application/work.js';
import type { AppDeps } from '../deps.js';
import type { ListingsDb } from './db.js';
import { WORK_QUEUE } from './store.js';

const KINDS = new Set([
  'photo-process',
  'photo-publish',
  'photo-unpublish',
  'scan-terms',
  'micromarkets',
  'projection-refresh',
]);

export function isWorkItem(payload: unknown): payload is WorkItem {
  const p = payload as { kind?: unknown; tenantId?: unknown } | null;
  return Boolean(p && typeof p.kind === 'string' && KINDS.has(p.kind) && typeof p.tenantId === 'string');
}

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<ListingsDb>> {
  return {
    [WORK_QUEUE]: async (payload) => {
      if (!isWorkItem(payload)) return; // unknown shapes are dropped (acknowledged), never retried forever
      const outcome = await runWork(deps.services, payload);
      if (outcome === 'skipped')
        deps.obs.logger.info({ code: `work-skipped-${payload.kind}` }, 'integration not configured');
    },
  };
}
