// Private work queues: q_journeys_work. Each handler dedupes on its own work key.
import type { WorkHandler } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { JourneysDb } from './db.js';

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<JourneysDb>> {
  void deps;
  return {};
}
