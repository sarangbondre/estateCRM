// Integration-test harness on the local stack (`pnpm db:start`): migrations, the app with generated signing keys,
// staff and service tokens, fakes for records/storage, and a fresh tenant per harness so files never share rows.
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JSONWebKeySet } from 'jose';
import { authenticate } from '@11e/auth';
import { createDb, migrate, withTransaction } from '@11e/db';
import type { EventDataMap, EventType } from '@11e/contracts/events';
import { observe } from '@11e/observability';
import { buildApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { SCHEMA, SERVICE, loadConfig } from '../src/config.js';
import type { ListingsDb } from '../src/adapters/db.js';
import { storeIn } from '../src/adapters/store.js';
import { hmacTermHasher } from '../src/adapters/records-client.js';
import { handlers } from '../src/application/ingest.js';
import type { Handler, Incoming } from '../src/application/ingest.js';
import type { PhotoStore, PrivateTermRow, Store } from '../src/application/ports.js';
import { coreServices, platformAdapters } from '../src/wiring.js';

const HOST = '127.0.0.1:54322/postgres';
export const env = {
  DATABASE_URL:
    process.env['LISTINGS_DATABASE_URL'] ?? `postgresql://${SCHEMA}_svc:local_${SCHEMA}_svc@${HOST}`,
  MIGRATOR_DATABASE_URL:
    process.env['LISTINGS_MIGRATOR_DATABASE_URL'] ??
    `postgresql://${SCHEMA}_migrator:local_${SCHEMA}_migrator@${HOST}`,
  CRON_SECRET: randomUUID(),
  FEED_SETTLE_MS: '0',
  API_KEY_CACHE_TTL_MS: '0',
  SCAN_SALT: 'test-scan-salt',
};

export const SALT = env.SCAN_SALT;
export const termHash = hmacTermHasher(SALT).hash;

let migrated: Promise<unknown> | undefined;
export const ensureMigrated = () =>
  (migrated ??= migrate({
    connectionString: env.MIGRATOR_DATABASE_URL,
    schema: SCHEMA,
    dir: new URL('../migrations', import.meta.url).pathname,
  }));

/** In-memory records scan terms: propertyId → terms (hashes of normalised tokens, as records computes them). */
export class FakeRecords {
  terms = new Map<string, { kind: PrivateTermRow['kind']; token: string }[]>();
  photos = new Map<string, Uint8Array>();
  ancestors: Record<string, string[]> = {};
  calls = 0;
}

export class FakePhotoStore implements PhotoStore {
  privateFiles = new Map<string, Uint8Array>();
  publicFiles = new Set<string>();
  async putPrivate(path: string, bytes: Uint8Array) {
    this.privateFiles.set(path, bytes);
  }
  async copyToPublic(privatePath: string, publicPath: string) {
    if (!this.privateFiles.has(privatePath)) throw new Error('no such private file');
    this.publicFiles.add(publicPath);
  }
  async removePublic(publicPath: string) {
    this.publicFiles.delete(publicPath);
  }
  async removePrivate(privatePath: string) {
    this.privateFiles.delete(privatePath);
  }
  publicUrl(publicPath: string) {
    return `https://cdn.example.com/listings-public/${publicPath}`;
  }
}

export interface Harness {
  deps: AppDeps;
  app: ReturnType<typeof buildApp>['app'];
  svc: ReturnType<typeof buildApp>;
  tenant: string;
  user: string;
  now: { value: Date | null };
  records: FakeRecords;
  photoStore: FakePhotoStore;
  staff(role?: string, opts?: { tenant?: string; user?: string }): Promise<Record<string, string>>;
  service(caller: string, opts?: { tenant?: string }): Promise<Record<string, string>>;
  cron: Record<string, string>;
  /** Applies an event through its handler in a committed transaction (like the drain does). */
  event<T extends EventType>(
    type: T,
    data: EventDataMap[T],
    opts?: { version?: number; aggregateId?: string; producer?: string; tenant?: string },
  ): Promise<void>;
  tx<T>(fn: (store: Store) => Promise<T>, tenant?: string): Promise<T>;
  close(): Promise<void>;
}

let versionSeq = 1;

export async function harness(options: { environment?: string } = {}): Promise<Harness> {
  await ensureMigrated();
  const config = loadConfig({ ...env, ENVIRONMENT_NAME: options.environment ?? 'test' });
  const handle = createDb<ListingsDb>({
    connectionString: config.databaseUrl,
    schema: SCHEMA,
    maxConnections: 4,
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwks: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }],
  };
  const records = new FakeRecords();
  const photoStore = new FakePhotoStore();
  const now = { value: null as Date | null };
  const services = coreServices(config, handle.db, {
    clock: { now: () => now.value ?? new Date() },
    photoStore,
    scanTerms: {
      async fetch(_tenant, propertyId) {
        records.calls++;
        const terms = records.terms.get(propertyId);
        if (!terms) return 'not-found';
        return {
          saltKeyId: '1',
          terms: terms.map((t) => ({ kind: t.kind, tokenHash: termHash(t.token), ngram: 1 })),
        };
      },
    },
    micromarkets: { ancestors: async () => records.ancestors },
    photoSource: {
      async download(_tenant, photoId) {
        const b = records.photos.get(photoId);
        if (!b) throw new Error('photo not found in records');
        return b;
      },
    },
    images: {
      async sanitise(bytes) {
        return { bytes, width: 1600, height: 1200, contentType: 'image/jpeg', ext: 'jpg' };
      },
    },
  });
  const platform = platformAdapters(config, handle.db);
  const auth = authenticate({
    service: SERVICE,
    jwks,
    cronSecret: env.CRON_SECRET,
    verifyApiKey: platform.website.verify,
  });
  const deps: AppDeps = {
    config,
    db: handle.db,
    obs: observe(SERVICE, { level: 'fatal' }),
    auth,
    services,
    ...platform,
  };
  const svc = buildApp(deps);
  const tenant = randomUUID();
  const user = randomUUID();
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('web')
      .setAudience(SERVICE)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime('5m')
      .sign(pair.privateKey);
  const h: Harness = {
    deps,
    app: svc.app,
    svc,
    tenant,
    user,
    now,
    records,
    photoStore,
    async staff(role = 'Admin', o = {}) {
      const t = o.tenant ?? tenant;
      const u = o.user ?? user;
      const token = await sign({ sub: 'web', tid: t, uid: u, role });
      return { authorization: `Bearer ${token}`, 'x-user-id': u, 'x-user-role': role, 'x-tenant-id': t };
    },
    async service(caller, o = {}) {
      return { authorization: `Bearer ${await sign({ sub: caller, tid: o.tenant ?? tenant })}` };
    },
    cron: { 'x-cron-secret': env.CRON_SECRET },
    async event(type, data, o = {}) {
      const handler = handlers[type] as Handler<EventType> | undefined;
      if (!handler) throw new Error(`no handler for ${type}`);
      const d = data as Record<string, unknown>;
      const aggregateId =
        o.aggregateId ??
        String(
          d['offerId'] ??
            d['demandId'] ??
            d['projectId'] ??
            d['photoId'] ??
            d['subjectId'] ??
            d['mergeId'] ??
            randomUUID(),
        );
      const e: Incoming<EventType> = {
        eventId: randomUUID(),
        eventType: type,
        producer: o.producer ?? 'records',
        aggregateType: 'test',
        aggregateId,
        aggregateVersion: o.version ?? versionSeq++,
        data: data as EventDataMap[EventType],
      };
      await withTransaction(
        handle.db,
        (trx) => handler(services, storeIn(trx, o.tenant ?? tenant, 'test'), e),
        {
          statementTimeoutMs: 30_000,
        },
      );
    },
    tx: (fn, t) =>
      withTransaction(handle.db, (trx) => fn(storeIn(trx, t ?? tenant, 'test')), {
        statementTimeoutMs: 30_000,
      }),
    close: () => handle.close(),
  };
  return h;
}

export const call = (
  h: Harness,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) =>
  h.app.request(path, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

// ---- fixtures ------------------------------------------------------------------------------------------------------

export function offerData(
  over: Partial<EventDataMap['offer.created.v1']> = {},
): EventDataMap['offer.created.v1'] {
  const id = over.offerId ?? randomUUID();
  return {
    offerId: id,
    code: `INV-${id.slice(0, 6)}`,
    propertyId: randomUUID(),
    dealType: 'Lease',
    segment: 'Residential',
    propertyTypes: ['Apartment'],
    bhkMin: 2,
    bhkMax: 2,
    areaSqftMin: 650,
    areaSqftMax: 650,
    areaBasis: 'Carpet',
    rentMonthlyInrMin: 45000,
    rentMonthlyInrMax: 45000,
    depositInr: 200000,
    currentRentInr: 40000,
    locality: 'Andheri West',
    micromarket: 'Andheri',
    city: 'Mumbai',
    furnishing: 'Semi Furnished',
    recordStage: 'Verified',
    hasRealPhotos: false,
    floorBand: 'Mid',
    totalFloors: 20,
    parking: 1,
    amenities: ['Gym', 'Lift'],
    selectedPhotoIds: [],
    ...over,
  };
}

export function demandData(
  over: Partial<EventDataMap['demand.created.v1']> = {},
): EventDataMap['demand.created.v1'] {
  const id = over.demandId ?? randomUUID();
  return {
    demandId: id,
    code: `DEM-${id.slice(0, 6)}`,
    dealTypes: ['Lease'],
    segment: 'Commercial',
    propertyTypes: ['Office'],
    micromarkets: ['BKC'],
    areaSqftMin: 1000,
    areaSqftMax: 1500,
    rentMonthlyInrMin: 180000,
    rentMonthlyInrMax: 260000,
    moveInBy: '2026-12-15',
    ...over,
  };
}

/** Sets the MahaRERA agent number directly (settings tests use the API). */
export async function setAgentNumber(h: Harness, number = 'A51900012345', tenant?: string) {
  await h.tx(async (store) => {
    const cur = await store.getSettings();
    await store.saveSettings(
      {
        mahareraAgentNumber: number,
        note: 'Details subject to confirmation',
        version: (cur?.version ?? 0) + 1,
        updatedAt: new Date(),
        updatedBy: null,
      },
      !cur,
    );
  }, tenant);
}
