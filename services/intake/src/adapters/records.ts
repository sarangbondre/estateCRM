// records reference data over HTTP with a service token (R-2): the micromarket hierarchy (locality normalisation,
// cached 10 min per tenant) and vocabulary releases (vocabulary.released.v1 consumer). 2 s timeout, retry and circuit
// breaker from libs/http. Fallback: an unreachable records keeps localities as written; the vocabulary message retries.
import { createServiceTokenClient } from '@11e/auth';
import { DownstreamError, createHttpClient } from '@11e/http';
import type { HttpClient } from '@11e/http';
import type { LocalityDirectory, VocabularyRelease } from '../application/ports.js';
import type { ReleaseSource } from '../application/vocabulary.js';
import { normaliseHeader } from '../domain/schema.js';

export interface RecordsClientOptions {
  baseUrl: string;
  token: (tenantId: string) => Promise<string>;
  fetch?: typeof fetch;
  onError?: (err: unknown) => void;
}

interface MicromarketItem {
  name: string;
  aliases?: string[];
  level: string;
}

const TTL_MS = 10 * 60_000;
const MAX_PAGES = 50;

export function recordsClient(o: RecordsClientOptions): LocalityDirectory & ReleaseSource {
  const http: HttpClient = createHttpClient({
    name: 'records',
    baseUrl: o.baseUrl,
    timeoutMs: 2000,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const auth = async (tenantId: string) => ({ authorization: `Bearer ${await o.token(tenantId)}` });
  const cache = new Map<string, { at: number; map: Map<string, string> }>();

  async function load(tenantId: string): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const ambiguous = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await http.request<{ items: MicromarketItem[]; nextCursor: string | null }>(
        'v1/micromarkets',
        {
          query: { limit: 100, ...(cursor ? { cursor } : {}) },
          headers: await auth(tenantId),
        },
      );
      if (r.status !== 200)
        throw new DownstreamError('records', r.status, `records micromarkets: ${r.status}`);
      for (const m of r.body.items ?? []) {
        if (m.level === 'zone') continue;
        for (const alias of [m.name, ...(m.aliases ?? [])]) {
          const k = normaliseHeader(alias);
          if (names.has(k) && names.get(k) !== m.name) ambiguous.add(k);
          else names.set(k, m.name);
        }
      }
      if (!r.body.nextCursor) break;
      cursor = r.body.nextCursor;
    }
    for (const k of ambiguous) names.delete(k);
    return names;
  }

  return {
    async resolver(tenantId) {
      let entry = cache.get(tenantId);
      if (!entry || Date.now() - entry.at > TTL_MS) {
        try {
          entry = { at: Date.now(), map: await load(tenantId) };
        } catch (err) {
          o.onError?.(err);
          entry = { at: Date.now() - TTL_MS + 60_000, map: entry?.map ?? new Map() }; // retry in a minute
        }
        cache.set(tenantId, entry);
      }
      const map = entry.map;
      return (name) => map.get(normaliseHeader(name));
    },

    async release(tenantId, version): Promise<VocabularyRelease> {
      const r = await http.request<Record<string, unknown>>('v1/vocabulary', {
        query: { version },
        headers: await auth(tenantId),
      });
      if (r.status !== 200) throw new DownstreamError('records', r.status, `records vocabulary: ${r.status}`);
      const b = r.body;
      return {
        version: String(b['version']),
        checksum: String(b['checksum']),
        content: {
          version: b['version'],
          fields: b['fields'],
          recordScopes: b['recordScopes'],
          legacyTerms: b['legacyTerms'],
          displayLabels: b['displayLabels'] ?? [],
        },
      };
    },
  };
}

export function createRecordsClient(config: {
  recordsUrl: string | undefined;
  webUrl: string;
  serviceCredential: string | undefined;
}): (LocalityDirectory & ReleaseSource) | undefined {
  if (!config.recordsUrl || !config.serviceCredential) return undefined;
  const tokens = createServiceTokenClient({ webUrl: config.webUrl, credential: config.serviceCredential });
  return recordsClient({
    baseUrl: config.recordsUrl,
    token: (tenantId) => tokens.token('records', tenantId),
  });
}
