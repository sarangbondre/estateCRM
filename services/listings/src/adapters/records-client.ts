// records reads with a service token minted by web (R-2): scan terms (R-20), the micromarket hierarchy (R-13) and a
// signed download URL for photo originals (L-2). Called from the work queue only, never on a user request.
// Fallback when records is unreachable: the work item fails and is retried with backoff (DLQ + alarm after 5); the
// previous scan-term cache / hierarchy stay in use, and a photo stays pending.
import { createHmac } from 'node:crypto';
import type { components } from '@11e/contracts/records';
import { createServiceTokenClient } from '@11e/auth';
import { DownstreamError, createHttpClient } from '@11e/http';
import type { ClientOptions } from '@11e/http';
import type { MicromarketReader, PhotoSource, ScanTermsReader, TermHasher } from '../application/ports.js';

type ScanTerms = components['schemas']['ScanTerms'];
type MicromarketPage = components['schemas']['MicromarketPage'];

export interface RecordsClientOptions {
  recordsUrl: string;
  webUrl: string;
  credential: string | undefined;
  fetch?: typeof fetch;
  onCall?: ClientOptions['onCall'];
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function createRecordsClient(o: RecordsClientOptions): {
  scanTerms: ScanTermsReader;
  micromarkets: MicromarketReader;
  photos: PhotoSource;
} {
  const client = createHttpClient({
    name: 'records',
    baseUrl: o.recordsUrl,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.onCall ? { onCall: o.onCall } : {}),
  });
  const tokens = o.credential
    ? createServiceTokenClient({
        webUrl: o.webUrl,
        credential: o.credential,
        ...(o.fetch ? { fetch: o.fetch } : {}),
      })
    : null;
  const auth = async (tenantId: string) => {
    if (!tokens) throw new DownstreamError('records', undefined, 'SERVICE_CREDENTIAL is not configured');
    return { authorization: `Bearer ${await tokens.token('records', tenantId)}` };
  };

  return {
    scanTerms: {
      async fetch(tenantId, propertyId) {
        const res = await client.request<ScanTerms>(`/internal/v1/properties/${propertyId}/scan-terms`, {
          headers: await auth(tenantId),
        });
        if (res.status === 404) return 'not-found';
        if (res.status !== 200) throw new DownstreamError('records', res.status, `scan-terms: ${res.status}`);
        const b = res.body;
        return {
          saltKeyId: String(b.saltVersion),
          terms: [
            ...b.buildingTokenHashes.map((h) => ({ kind: 'building' as const, tokenHash: h, ngram: 1 })),
            ...b.wingHashes.map((h) => ({ kind: 'wing' as const, tokenHash: h, ngram: 1 })),
            ...b.unitHashes.map((h) => ({ kind: 'unit' as const, tokenHash: h, ngram: 1 })),
          ],
        };
      },
    },
    micromarkets: {
      async ancestors(tenantId) {
        const nodes: MicromarketPage['items'] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 200; page++) {
          const res = await client.request<MicromarketPage>('/v1/micromarkets', {
            query: { limit: 100, ...(cursor ? { cursor } : {}) },
            headers: await auth(tenantId),
          });
          if (res.status !== 200)
            throw new DownstreamError('records', res.status, `micromarkets: ${res.status}`);
          nodes.push(...res.body.items);
          if (!res.body.nextCursor) break;
          cursor = res.body.nextCursor;
        }
        return ancestorMap(nodes);
      },
    },
    photos: {
      async download(tenantId, photoId) {
        const res = await client.request<{ url: string }>(`/internal/v1/photos/${photoId}/signed-url`, {
          headers: await auth(tenantId),
        });
        if (res.status !== 200)
          throw new DownstreamError('records', res.status, `photo signed-url: ${res.status}`);
        const file = await (o.fetch ?? fetch)(res.body.url, { signal: AbortSignal.timeout(10_000) });
        if (!file.ok)
          throw new DownstreamError('records-storage', file.status, `photo download: ${file.status}`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > MAX_PHOTO_BYTES) throw new Error('photo larger than 10 MB');
        return bytes;
      },
    },
  };
}

/** name → ancestor names (parent chain), from the micromarket tree. */
export function ancestorMap(nodes: readonly { id: string; parentId?: string | null; name: string }[]) {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const out: Record<string, string[]> = {};
  for (const node of nodes) {
    const chain: string[] = [];
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    for (let depth = 0; parent && depth < 10; depth++) {
      chain.push(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    out[node.name] = chain;
  }
  return out;
}

/** HMAC-SHA-256(scan salt, token) hex: the same keyed hash records uses for scan terms (R-20). */
export function hmacTermHasher(salt: string): TermHasher {
  return { hash: (token) => createHmac('sha256', salt).update(token).digest('hex') };
}
