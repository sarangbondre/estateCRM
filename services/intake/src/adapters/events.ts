// Event consumers for q_intake (contracts/asyncapi/events.yaml). Handlers run inside the drain transaction
// together with processed_events dedupe (libs/outbox). Unknown event types are dead-lettered (no-handler).
import type { EventHandlers } from '@11e/outbox';
import { applyVocabularyRelease } from '../application/vocabulary.js';
import type { AppDeps } from '../deps.js';
import type { IntakeDb } from './db.js';
import { repositories } from './uow.js';

export function eventHandlers(deps: AppDeps): EventHandlers<IntakeDb> {
  const { app } = deps;
  return {
    // records unreachable → throw → retried with backoff (5 attempts → DLQ); uploads keep the previous release
    'vocabulary.released.v1': async (event, { trx }) => {
      if (!app.releases) throw new Error('records is not configured (RECORDS_URL, SERVICE_CREDENTIAL)');
      await applyVocabularyRelease(app.releases, repositories(trx), app.ids, event.tenantId, event.data);
    },
  };
}
