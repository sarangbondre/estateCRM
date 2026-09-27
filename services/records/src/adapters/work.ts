// Private work queues: q_records_photo_fetch. Each handler dedupes on its own work key.
import type { WorkHandler } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { RecordsDb } from './db.js';

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<RecordsDb>> {
  void deps;
  return {};
}
