// Private work queues: q_crm_engine_rescore. Each handler dedupes on its own work key.
import type { WorkHandler } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { CrmEngineDb } from './db.js';

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<CrmEngineDb>> {
  void deps;
  return {};
}
