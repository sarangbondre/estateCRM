// Slow work from the private queue q_listings_photos (CLAUDE.md §3.5): photo renditions (LLD §4.5), public copies,
// scan-term refresh (R-20), micromarket hierarchy (R-13) and projection refresh batches. No third-party AI, no OCR.
import { publicNameFrom } from '../domain/ids.js';
import type { Services } from './context.js';
import { reconcile } from './engine.js';
import type { Store, WorkItem } from './ports.js';

const MAX_PHOTO_ATTEMPTS = 3;
const REFRESH_BATCH = 500;
const PROPERTY_CASCADE = 100;

export type WorkOutcome = 'done' | 'skipped' | 'retry-later';

async function reconcileProperty(s: Services, store: Store, propertyId: string) {
  for (const id of await store.offersOfProperty(propertyId, PROPERTY_CASCADE))
    await reconcile(s, store, 'offer', id);
}

async function processPhoto(
  s: Services,
  item: Extract<WorkItem, { kind: 'photo-process' }>,
): Promise<WorkOutcome> {
  const { photoSource, photoStore, images } = s;
  if (!photoSource || !photoStore || !images) return 'skipped'; // storage not configured (local): stays pending
  const photo = await s.uow.run(item.tenantId, `work-photo-${item.photoId}`, (store) =>
    store.getPhoto(item.photoId),
  );
  if (!photo || photo.status !== 'pending') return 'done';
  try {
    const original = await photoSource.download(item.tenantId, photo.id);
    const clean = await images.sanitise(original);
    const privatePath = `${item.tenantId}/${photo.id}.${clean.ext}`;
    await photoStore.putPrivate(privatePath, clean.bytes, clean.contentType);
    await s.uow.run(item.tenantId, `work-photo-${item.photoId}`, async (store) => {
      await store.markPhotoReady(photo.id, privatePath, clean.width, clean.height);
      await reconcileProperty(s, store, photo.propertyId);
    });
    return 'done';
  } catch (err) {
    const attempts = await s.uow.run(item.tenantId, `work-photo-${item.photoId}`, (store) =>
      store.markPhotoAttempt(photo.id, MAX_PHOTO_ATTEMPTS),
    );
    // After 3 attempts the photo is `failed` (C-12 shows it); earlier failures are retried by the queue.
    if (attempts >= MAX_PHOTO_ATTEMPTS) return 'done';
    throw err;
  }
}

async function publishPhoto(
  s: Services,
  item: Extract<WorkItem, { kind: 'photo-publish' }>,
): Promise<WorkOutcome> {
  const store0 = s.photoStore;
  if (!store0) return 'skipped';
  const photo = await s.uow.run(item.tenantId, `work-photo-${item.photoId}`, (store) =>
    store.getPhotoFull(item.photoId),
  );
  if (!photo || photo.status !== 'ready' || !photo.privatePath || photo.publicPath) return 'done';
  const publicName = photo.publicName ?? publicNameFrom(s.random.bytes(16));
  const ext = photo.privatePath.split('.').pop() ?? 'jpg';
  const publicPath = `${item.tenantId}/${publicName}.${ext}`;
  await store0.copyToPublic(photo.privatePath, publicPath);
  await s.uow.run(item.tenantId, `work-photo-${item.photoId}`, async (store) => {
    await store.setPhotoPublic(photo.id, publicName, publicPath);
    await reconcileProperty(s, store, photo.propertyId);
  });
  return 'done';
}

async function unpublishPhoto(
  s: Services,
  item: Extract<WorkItem, { kind: 'photo-unpublish' }>,
): Promise<WorkOutcome> {
  const photo = await s.uow.run(item.tenantId, `work-photo-${item.photoId}`, (store) =>
    store.getPhotoFull(item.photoId),
  );
  if (!photo?.publicPath) return 'done';
  const stillUsed = await s.uow.run(item.tenantId, `work-photo-${item.photoId}`, (store) =>
    store.photoUsedByPublicOffer(photo.id, photo.propertyId),
  );
  if (stillUsed && photo.status === 'ready') return 'done';
  if (s.photoStore) await s.photoStore.removePublic(photo.publicPath);
  await s.uow.run(item.tenantId, `work-photo-${item.photoId}`, async (store) => {
    await store.setPhotoPublic(photo.id, photo.publicName ?? '', null);
    await reconcileProperty(s, store, photo.propertyId);
  });
  return 'done';
}

async function refreshScanTerms(
  s: Services,
  item: Extract<WorkItem, { kind: 'scan-terms' }>,
): Promise<WorkOutcome> {
  if (!s.scanTerms) return 'skipped'; // records not configured (local without the mock): regex rules still apply
  const result = await s.scanTerms.fetch(item.tenantId, item.propertyId);
  await s.uow.run(item.tenantId, `work-scan-terms-${item.propertyId}`, async (store) => {
    const now = s.clock.now();
    const terms =
      result === 'not-found'
        ? []
        : result.terms.map((t) => ({ ...t, propertyId: item.propertyId, saltKeyId: result.saltKeyId }));
    await store.replaceTerms(item.propertyId, terms, now);
    await store.markScanTermsFetched(item.propertyId, now);
  });
  return 'done';
}

async function refreshMicromarkets(
  s: Services,
  item: Extract<WorkItem, { kind: 'micromarkets' }>,
): Promise<WorkOutcome> {
  if (!s.micromarkets) return 'skipped';
  const ancestors = await s.micromarkets.ancestors(item.tenantId);
  await s.uow.run(item.tenantId, 'work-micromarkets', async (store) => {
    await store.saveMicromarkets(ancestors);
    await store.enqueue({ kind: 'projection-refresh', tenantId: item.tenantId, after: null });
  });
  return 'done';
}

/** One batch of 500 publications of a tenant: recompute ceilings and rewrite payloads; re-enqueues the rest. */
export async function refreshProjectionBatch(
  s: Services,
  tenantId: string,
  after: string | null,
  batch = REFRESH_BATCH,
): Promise<{ processed: number; next: string | null }> {
  return s.uow.run(tenantId, 'projection-refresh', async (store) => {
    const rows = await store.publicationsAfter(after, batch);
    for (const r of rows)
      await reconcile(s, store, r.subjectType, r.subjectId, { cascade: false, refresh: true });
    const next = rows.length === batch ? (rows.at(-1)?.id ?? null) : null;
    if (next) await store.enqueue({ kind: 'projection-refresh', tenantId, after: next });
    return { processed: rows.length, next };
  });
}

export async function runWork(s: Services, item: WorkItem): Promise<WorkOutcome> {
  switch (item.kind) {
    case 'photo-process':
      return processPhoto(s, item);
    case 'photo-publish':
      return publishPhoto(s, item);
    case 'photo-unpublish':
      return unpublishPhoto(s, item);
    case 'scan-terms':
      return refreshScanTerms(s, item);
    case 'micromarkets':
      return refreshMicromarkets(s, item);
    case 'projection-refresh':
      await refreshProjectionBatch(s, item.tenantId, item.after ?? null);
      return 'done';
  }
}
