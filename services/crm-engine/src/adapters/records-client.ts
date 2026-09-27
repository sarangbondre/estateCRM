// records' micromarket reference data (R-13, LLD §4.8): GET /v1/micromarkets with a service token minted by web (R-2).
// Called only by the micromarket-refresh job, never on a request path. Fallback when records is unreachable: the job
// fails, keeps the previous hierarchy copy and retries on the next call (CLAUDE.md §3.5).
import type { components } from '@11e/contracts/records';
import { createServiceTokenClient } from '@11e/auth';
import { DownstreamError, createHttpClient } from '@11e/http';
import type { MicromarketSource } from '../application/ports.js';
import type { MmSourceNode } from '../domain/micromarket.js';

type Page = components['schemas']['MicromarketPage'];

export interface RecordsClientOptions {
  recordsUrl: string;
  webUrl: string;
  credential: string | undefined;
  fetch?: typeof fetch;
  /** Hard cap on pages (100 nodes each). */
  maxPages?: number;
}

export function recordsMicromarketSource(options: RecordsClientOptions): MicromarketSource {
  const client = createHttpClient({
    name: 'records',
    baseUrl: options.recordsUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const tokens = options.credential
    ? createServiceTokenClient({
        webUrl: options.webUrl,
        credential: options.credential,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : null;
  return {
    async fetchAll(tenantId) {
      if (!tokens) throw new DownstreamError('records', undefined, 'SERVICE_CREDENTIAL is not configured');
      const out: MmSourceNode[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < (options.maxPages ?? 500); page++) {
        const res = await client.request<Page>('/v1/micromarkets', {
          query: { limit: 100, ...(cursor ? { cursor } : {}) },
          headers: { authorization: `Bearer ${await tokens.token('records', tenantId)}` },
        });
        for (const m of res.body.items)
          out.push({
            id: m.id,
            parentId: m.parentId ?? null,
            level: m.level,
            name: m.name,
            aliases: m.aliases ?? [],
            adjacentIds: m.adjacentIds ?? [],
            inLaunchArea: m.inLaunchArea,
          });
        if (!res.body.nextCursor) break;
        cursor = res.body.nextCursor;
      }
      return out;
    },
  };
}
