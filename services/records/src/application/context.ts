// Shared application context: ports bundle, the acting principal, and per-instance caches that are never the
// source of truth (records LLD §8: vocabulary 5 min / on release, micromarket tree 1 h / on change, launch area 5 min).
import { MicromarketIndex } from '../domain/micromarket-index.js';
import { VocabularyIndex } from '../domain/vocabulary.js';
import type { ReleaseFields } from '../domain/vocabulary.js';
import type { MicromarketRow } from './model.js';
import type {
  Clock,
  IdGenerator,
  ImageFetcher,
  IntakeRowsClient,
  KeyedHash,
  PhotoStore,
  Redactor,
  Tx,
  UnitOfWork,
} from './ports.js';

/** Reserved system actor for automatic changes (R-7). */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

export interface Actor {
  tenantId: string;
  userId: string;
  role: string;
  correlationId: string;
  via?: 'ui' | 'chat' | 'system';
}

export const systemActor = (tenantId: string, correlationId: string): Actor => ({
  tenantId,
  userId: SYSTEM_USER_ID,
  role: 'System',
  correlationId,
  via: 'system',
});

export interface AppPorts {
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  hash: KeyedHash;
  redactor: Redactor;
  intake?: IntakeRowsClient | undefined;
  photoStore?: PhotoStore | undefined;
  images?: ImageFetcher | undefined;
  /** Tenants served by this deployment (scheduled jobs iterate over them; Phase 1 has one). */
  tenantIds: readonly string[];
  /** Tenants that already have reference data (bootstrapped by a request). */
  knownTenants?: (() => Promise<string[]>) | undefined;
}

/** Configured tenants plus the ones records already holds data for. */
export async function tenantsOf(app: AppPorts): Promise<string[]> {
  const known = app.knownTenants ? await app.knownTenants() : [];
  return [...new Set([...app.tenantIds, ...known])];
}

class TtlCache<V> {
  readonly #entries = new Map<string, { value: V; at: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}
  get(key: string): V | undefined {
    const e = this.#entries.get(key);
    if (!e || this.now() - e.at > this.ttlMs) return undefined;
    return e.value;
  }
  set(key: string, value: V): void {
    this.#entries.set(key, { value, at: this.now() });
  }
  drop(key: string): void {
    this.#entries.delete(key);
  }
}

export class ReferenceCache {
  readonly vocabulary: TtlCache<VocabularyIndex>;
  readonly micromarkets: TtlCache<MicromarketIndex>;
  readonly launchCities: TtlCache<ReadonlySet<string>>;

  constructor(now: () => number = Date.now) {
    this.vocabulary = new TtlCache(5 * 60_000, now);
    this.micromarkets = new TtlCache(60 * 60_000, now);
    this.launchCities = new TtlCache(5 * 60_000, now);
  }

  invalidate(tenantId: string): void {
    this.vocabulary.drop(tenantId);
    this.micromarkets.drop(tenantId);
    this.launchCities.drop(tenantId);
  }
}

export interface App extends AppPorts {
  cache: ReferenceCache;
}

export function createApp(ports: AppPorts, cache = new ReferenceCache()): App {
  return { ...ports, cache };
}

/** Active vocabulary of the tenant (cached). Falls back to nothing when the tenant has no active release yet. */
export async function vocabularyOf(app: App, tx: Tx): Promise<VocabularyIndex | undefined> {
  const hit = app.cache.vocabulary.get(tx.tenantId);
  if (hit) return hit;
  const [active] = await tx.store.find('vocabulary_releases', { status: 'active' }, { limit: 1 });
  if (!active) return undefined;
  const content = active.content as { fields?: ReleaseFields };
  const index = new VocabularyIndex(active.version, content.fields ?? {});
  app.cache.vocabulary.set(tx.tenantId, index);
  return index;
}

/** The whole micromarket tree of the tenant (bounded: the hierarchy is a few thousand nodes). */
export async function micromarketIndexOf(app: App, tx: Tx): Promise<MicromarketIndex> {
  const hit = app.cache.micromarkets.get(tx.tenantId);
  if (hit) return hit;
  const rows: MicromarketRow[] = await tx.store.find('micromarkets', {}, { limit: 1000 });
  const index = new MicromarketIndex(rows);
  app.cache.micromarkets.set(tx.tenantId, index);
  return index;
}

export async function launchCitiesOf(app: App, tx: Tx): Promise<ReadonlySet<string>> {
  const hit = app.cache.launchCities.get(tx.tenantId);
  if (hit) return hit;
  const rows = await tx.store.find('launch_area_cities', { enabled: true }, { limit: 1000 });
  const set = new Set(rows.map((r) => r.city_norm));
  app.cache.launchCities.set(tx.tenantId, set);
  return set;
}
