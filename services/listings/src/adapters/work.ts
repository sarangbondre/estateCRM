// Private work queues: q_listings_photos. Each handler dedupes on its own work key.
import type { WorkHandler } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { ListingsDb } from './db.js';

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<ListingsDb>> {
  void deps;
  return {};
}
