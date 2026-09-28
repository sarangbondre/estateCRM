// Private work queues: q_records_photo_fetch (sheet-link photos, LLD §4.12). The handler is idempotent on the photo's
// status (a photo that is no longer pending is skipped).
import type { WorkHandler } from '@11e/outbox';
import { systemActor } from '../application/context.js';
import { PHOTO_FETCH_QUEUE, fetchSheetPhoto } from '../application/photos.js';
import type { AppDeps } from '../deps.js';
import type { RecordsDb } from './db/schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<RecordsDb>> {
  return {
    [PHOTO_FETCH_QUEUE]: async (payload) => {
      const p = (payload ?? {}) as { tenantId?: unknown; photoId?: unknown; correlationId?: unknown };
      if (typeof p.tenantId !== 'string' || typeof p.photoId !== 'string' || !UUID.test(p.tenantId) || !UUID.test(p.photoId)) return;
      const actor = systemActor(p.tenantId, typeof p.correlationId === 'string' ? p.correlationId : `photo-${p.photoId}`);
      await fetchSheetPhoto(deps.app, actor, p.photoId);
    },
  };
}
