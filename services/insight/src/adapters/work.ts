// Private work queues: q_insight_exports. Each handler dedupes on its own work key.
import type { WorkHandler } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { InsightDb } from './db.js';

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<InsightDb>> {
  void deps;
  return {};
}
