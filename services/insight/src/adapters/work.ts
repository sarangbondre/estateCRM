// Private work queue q_insight_exports: one export job per message (LLD §4.9). The job row dedupes (claim only
// queued/running jobs); a thrown error leaves the message for a retry (drain back-off), and after 3 attempts the job
// is failed with export.failed.v1.
import type { WorkHandler } from '@11e/outbox';
import { runExportJob } from '../application/exports.js';
import type { AppDeps } from '../deps.js';
import type { InsightDb } from './db.js';
import type { Wired } from './wiring.js';

export function workHandlers(deps: AppDeps, wired: Wired): Record<string, WorkHandler<InsightDb>> {
  return {
    q_insight_exports: async (payload, { msgId }) => {
      const r = await runExportJob(wired.exports, payload, `export-${msgId}`);
      deps.obs.logger.info({ queue: 'q_insight_exports', msgId, outcome: r }, 'export job');
    },
  };
}
