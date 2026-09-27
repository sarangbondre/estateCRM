// Photos (REC-09, D-5, A-26, R-8): signed uploads to the private bucket, attach with checks (size, magic bytes,
// duplicate guard), selection per offer, deletion, listings' signed read, and sheet-link fetches (work queue).
import { createHash } from 'node:crypto';
import { RecordsError, notFound } from '../domain/errors.js';
import { PHOTO_LIMIT, PHOTO_MAX_BYTES, imageSize, sniffImage } from '../domain/privacy.js';
import type { Actor, App } from './context.js';
import { activeOfferIdsOf, agg, bumpOffersUpdated } from './emit.js';
import { mustFind } from './lookup.js';
import type { PhotoRow } from './model.js';
import { mergedError } from './people.js';
import type { PhotoStore, StoredObject, Tx } from './ports.js';
import type { PageRequest } from './queries.js';

export const PHOTO_BUCKET_PREFIX = 'records-photos/';
export const PHOTO_FETCH_QUEUE = 'q_records_photo_fetch';
const UPLOAD_URL_TTL_SEC = 15 * 60;
const READ_URL_TTL_SEC = 60 * 60;
const INTERNAL_URL_TTL_SEC = 5 * 60;

const objectPath = (storagePath: string) => storagePath.replace(/^records-photos\//, '');

function store(app: App): PhotoStore {
  if (!app.photoStore) throw new RecordsError('dependency-unavailable', 'photo storage is not configured');
  return app.photoStore;
}

async function activePhotoCount(tx: Tx, propertyId: string): Promise<number> {
  const rows = await tx.store.find('photos', { property_id: propertyId }, { limit: PHOTO_LIMIT * 4 });
  const freshPending = new Date(tx.now.getTime() - 60 * 60 * 1000);
  return rows.filter((p) => p.status === 'ready' || (p.status === 'pending_upload' && p.created_at > freshPending)).length;
}

export async function requestPhotoUpload(
  app: App,
  actor: Actor,
  input: { propertyId: string; contentType: string; sizeBytes: number; origin: PhotoRow['origin']; isReal: boolean },
): Promise<{ photoId: string; uploadUrl: string; expiresAt: string }> {
  const photos = store(app);
  const row = await app.uow.run(actor, async (tx) => {
    const property = await tx.store.get('properties', input.propertyId, { lock: true });
    if (!property) throw notFound('property');
    if (property.status === 'merged') throw mergedError(property.merged_into_id);
    if ((await activePhotoCount(tx, property.id)) >= PHOTO_LIMIT) throw new RecordsError('photo-limit-reached');
    const id = app.ids.next();
    const photo: PhotoRow = {
      id,
      tenant_id: tx.tenantId,
      property_id: property.id,
      origin: input.origin,
      is_real: input.isReal,
      status: 'pending_upload',
      storage_path: `${PHOTO_BUCKET_PREFIX}${tx.tenantId}/${property.id}/${id}`,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      width: null,
      height: null,
      sha256: null,
      has_text_detected: null,
      source_url: null,
      fetch_error: null,
      created_by: actor.userId,
      created_at: tx.now,
      updated_at: tx.now,
    };
    await tx.store.insert('photos', photo);
    return photo;
  });
  const uploadUrl = await photos.signedUploadUrl(objectPath(row.storage_path), input.contentType, UPLOAD_URL_TTL_SEC);
  return { photoId: row.id, uploadUrl, expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString() };
}

/** Marks a verified object ready, counts it on the property, links offers and emits the events (one transaction). */
async function markReady(
  app: App,
  tx: Tx,
  photo: PhotoRow,
  object: StoredObject,
  contentType: string,
  offerIds: readonly string[] | undefined,
): Promise<void> {
  const duplicate = await tx.store.find('photos', { property_id: photo.property_id, sha256: object.sha256, status: 'ready' }, { limit: 1 });
  if (duplicate.length) throw new RecordsError('conflict', 'the same image is already on this property');
  const size = imageSize(object.head, contentType as 'image/jpeg');
  await tx.store.update('photos', photo.id, {
    status: 'ready',
    content_type: contentType,
    size_bytes: object.sizeBytes,
    sha256: object.sha256,
    width: size?.width ?? null,
    height: size?.height ?? null,
    fetch_error: null,
  });
  const property = await tx.store.get('properties', photo.property_id, { lock: true });
  if (!property) throw notFound('property');
  await tx.store.update('properties', property.id, {
    photo_count: property.photo_count + 1,
    has_real_photos: property.has_real_photos || photo.is_real,
    version: property.version + 1,
  });
  const propertyOffers = await activeOfferIdsOf(tx, [property.id]);
  const targets = offerIds?.length ? [...new Set(offerIds)] : propertyOffers;
  if (targets.some((id) => !propertyOffers.includes(id))) throw new RecordsError('photo-not-on-property');
  for (const offerId of targets) {
    const existing = await tx.store.find('offer_photos', { offer_id: offerId }, { limit: PHOTO_LIMIT * 2 });
    await tx.store.insertIgnore('offer_photos', {
      offer_id: offerId,
      photo_id: photo.id,
      sort: existing.reduce((m, r) => Math.max(m, r.sort + 1), 0),
    });
  }
  await tx.events.emit('photo.added.v1', agg('photo', photo.id, 1), {
    photoId: photo.id,
    propertyId: photo.property_id,
    origin: photo.origin,
    isReal: photo.is_real,
    storagePath: photo.storage_path,
  });
  await bumpOffersUpdated(tx, propertyOffers);
}

export async function attachPhoto(app: App, actor: Actor, id: string, offerIds: string[] | undefined): Promise<PhotoRow> {
  const photos = store(app);
  const pending = await app.uow.run(actor, (tx) => tx.store.get('photos', id));
  if (!pending) throw notFound('photo');
  if (pending.status === 'ready') return pending; // naturally idempotent: no second event
  const object = await photos.inspect(objectPath(pending.storage_path));
  if (!object) throw new RecordsError('photo-upload-missing');
  const type = sniffImage(object.head);
  if (!type || object.sizeBytes > PHOTO_MAX_BYTES) {
    await app.uow.run(actor, (tx) => tx.store.update('photos', id, { status: 'rejected' }));
    if (object.sizeBytes > PHOTO_MAX_BYTES) {
      throw new RecordsError('validation-failed', 'photos are limited to 10 MB', { errors: [{ field: 'sizeBytes', code: 'too-large' }] });
    }
    throw new RecordsError('unsupported-media-type', 'only JPG, PNG and WebP images are accepted');
  }
  return app.uow.run(actor, async (tx) => {
    const photo = await tx.store.get('photos', id, { lock: true });
    if (!photo) throw notFound('photo');
    if (photo.status === 'ready') return photo;
    await markReady(app, tx, photo, object, type, offerIds);
    return (await tx.store.get('photos', id)) as PhotoRow;
  });
}

export async function deletePhoto(app: App, actor: Actor, id: string): Promise<void> {
  const removed = await app.uow.run(actor, async (tx) => {
    const photo = await tx.store.get('photos', id, { lock: true });
    if (!photo) return null; // already deleted → 204 without events
    const links = await tx.store.find('offer_photos', { photo_id: id }, { limit: 1000 });
    await tx.store.delete('offer_photos', { photo_id: id });
    await tx.store.delete('photos', { id });
    if (photo.status === 'ready') {
      const property = await tx.store.get('properties', photo.property_id, { lock: true });
      if (property) {
        const left = await tx.store.find('photos', { property_id: property.id, status: 'ready' }, { limit: PHOTO_LIMIT * 2 });
        await tx.store.update('properties', property.id, {
          photo_count: left.length,
          has_real_photos: left.some((p) => p.is_real),
          version: property.version + 1,
        });
      }
      await tx.events.emit('photo.removed.v1', agg('photo', photo.id, 2), { photoId: photo.id, propertyId: photo.property_id });
      await bumpOffersUpdated(tx, [...new Set([...(await activeOfferIdsOf(tx, [photo.property_id])), ...links.map((l) => l.offer_id)])]);
    }
    return photo;
  });
  if (removed && app.photoStore) {
    try {
      await app.photoStore.remove(objectPath(removed.storage_path));
    } catch {
      // The row is gone; an orphaned object is harmless and private (bucket lifecycle cleans it).
    }
  }
}

export async function listPhotos(
  app: App,
  actor: Actor,
  propertyIdOrCode: string,
  page: PageRequest,
): Promise<{ rows: PhotoRow[]; urls: Map<string, string> }> {
  const rows = await app.uow.run(actor, async (tx) => {
    const property = await mustFind(tx, 'properties', propertyIdOrCode);
    return tx.q.listPhotos(property.id, page);
  });
  const urls = new Map<string, string>();
  if (app.photoStore) {
    for (const p of rows.filter((r) => r.status === 'ready')) {
      urls.set(p.id, await app.photoStore.signedReadUrl(objectPath(p.storage_path), READ_URL_TTL_SEC));
    }
  }
  return { rows, urls };
}

/** Internal (listings, L-2): 5-minute signed URL to read the original of a ready photo. */
export async function internalSignedUrl(app: App, actor: Actor, id: string): Promise<{ url: string; expiresAt: string }> {
  const photos = store(app);
  const photo = await app.uow.run(actor, (tx) => tx.store.get('photos', id));
  if (!photo || photo.status !== 'ready') throw notFound('photo');
  const url = await photos.signedReadUrl(objectPath(photo.storage_path), INTERNAL_URL_TTL_SEC);
  return { url, expiresAt: new Date(Date.now() + INTERNAL_URL_TTL_SEC * 1000).toISOString() };
}

/** Queues sheet-link photos of a property (ingestion mapping mode `photoUrls`); failures never block the upload. */
export async function queueSheetPhotos(app: App, tx: Tx, propertyId: string, urls: readonly string[]): Promise<void> {
  const existing = await tx.store.find('photos', { property_id: propertyId }, { limit: PHOTO_LIMIT * 4 });
  const known = new Set(existing.map((p) => p.source_url));
  let room = PHOTO_LIMIT - existing.filter((p) => p.status === 'ready' || p.status === 'pending_upload').length;
  for (const url of [...new Set(urls)]) {
    if (room <= 0 || known.has(url)) continue;
    room--;
    const id = app.ids.next();
    await tx.store.insert('photos', {
      id,
      property_id: propertyId,
      origin: 'sheet_link',
      is_real: false,
      status: 'pending_upload',
      storage_path: `${PHOTO_BUCKET_PREFIX}${tx.tenantId}/${propertyId}/${id}`,
      content_type: null,
      size_bytes: null,
      width: null,
      height: null,
      sha256: null,
      has_text_detected: null,
      source_url: url,
      fetch_error: null,
      created_by: null,
    });
    await tx.enqueueWork(PHOTO_FETCH_QUEUE, { photoId: id });
  }
}

/** Work handler for q_records_photo_fetch: download, verify, store, attach. Idempotent on the photo status. */
export async function fetchSheetPhoto(app: App, actor: Actor, photoId: string): Promise<void> {
  const photo = await app.uow.run(actor, (tx) => tx.store.get('photos', photoId));
  if (!photo || photo.status !== 'pending_upload' || !photo.source_url) return;
  const fail = (reason: string) =>
    app.uow.run(actor, (tx) => tx.store.update('photos', photoId, { status: 'fetch_failed', fetch_error: reason.slice(0, 200) }));
  if (!app.images || !app.photoStore) return fail('photo fetching is not configured');
  let bytes: Uint8Array;
  try {
    bytes = (await app.images.fetch(photo.source_url)).bytes;
  } catch (err) {
    return fail(`download failed: ${(err as Error).message}`);
  }
  const type = sniffImage(bytes);
  if (!type) return fail('not a JPG, PNG or WebP image');
  if (bytes.byteLength > PHOTO_MAX_BYTES) return fail('image larger than 10 MB');
  await app.photoStore.put(objectPath(photo.storage_path), bytes, type);
  const object: StoredObject = {
    sizeBytes: bytes.byteLength,
    head: bytes.slice(0, 65536),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  try {
    await app.uow.run(actor, async (tx) => {
      const current = await tx.store.get('photos', photoId, { lock: true });
      if (!current || current.status !== 'pending_upload') return;
      await markReady(app, tx, current, object, type, undefined);
    });
  } catch (err) {
    if (err instanceof RecordsError) return fail(err.detail ?? err.code);
    throw err;
  }
}
