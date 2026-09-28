// Builds the concrete adapters behind the application ports. Called only by the composition root (main.ts) and by
// tests, which may replace the records/storage integrations with fakes.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { hashApiKey } from '@11e/auth';
import type { Services } from './application/context.js';
import type { Config } from './config.js';
import { agentNumberRequired } from './config.js';
import type { ListingsDb } from './adapters/db.js';
import { createMaintenance } from './adapters/maintenance.js';
import { hmacTermHasher } from './adapters/records-client.js';
import { publicUrlFor, supabasePhotoStore } from './adapters/storage.js';
import { createUnitOfWork } from './adapters/store.js';
import { createRateLimiter, createWebsiteAuth } from './adapters/website.js';

export function coreServices(
  config: Config,
  db: Kysely<ListingsDb>,
  integrations: Partial<
    Pick<Services, 'scanTerms' | 'micromarkets' | 'photoSource' | 'photoStore' | 'images' | 'clock'>
  > = {},
): Services {
  const photoStore =
    integrations.photoStore ??
    (config.storageUrl && config.storageServiceKey
      ? supabasePhotoStore({
          url: config.storageUrl,
          serviceKey: config.storageServiceKey,
          privateBucket: config.privateBucket,
          publicBucket: config.publicBucket,
        })
      : undefined);
  return {
    uow: createUnitOfWork(db),
    clock: integrations.clock ?? { now: () => new Date() },
    random: { bytes: (n) => new Uint8Array(randomBytes(n)), uuid: () => randomUUID() },
    policy: { agentNumberRequired: agentNumberRequired(config) },
    sha256: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
    termHasher: hmacTermHasher(config.scanSalt),
    publicPhotoUrl: photoStore
      ? (p) => photoStore.publicUrl(p)
      : publicUrlFor(config.storageUrl, config.publicBucket),
    scanTerms: integrations.scanTerms,
    micromarkets: integrations.micromarkets,
    photoSource: integrations.photoSource,
    photoStore,
    images: integrations.images,
  };
}

export function platformAdapters(config: Config, db: Kysely<ListingsDb>) {
  return {
    maintenance: createMaintenance(db),
    website: createWebsiteAuth(db, { cacheTtlMs: config.apiKeyCacheTtlMs }),
    rateLimiter: createRateLimiter(db),
    keyHasher: { hash: hashApiKey },
  };
}
