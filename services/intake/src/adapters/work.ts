// Private work queues: q_intake_chunks, q_intake_finalize, q_intake_inspect, q_intake_split. Each handler dedupes on its own work key.
import type { WorkHandler } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { IntakeDb } from './db.js';

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<IntakeDb>> {
  void deps;
  return {};
}
