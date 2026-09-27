// records client (service token aud=records, R-2): vocabulary and micromarkets for vocabulary-refresh. Timeout 2 s,
// one retry for GETs, circuit breaker (libs/http). Contacts for exports are added in INS-05.
import type { ServiceTokenClient } from '@11e/auth';
import { createHttpClient } from '@11e/http';
import type { HttpClient } from '@11e/http';
import type { MicromarketNode, RecordsReference, VocabularyReleaseDoc } from '../application/ports.js';

interface MicromarketPage {
  items: {
    id: string;
    parentId?: string | null;
    level: string;
    name: string;
    aliases?: string[];
    city: string;
    inLaunchArea: boolean;
    treeVersion?: number;
  }[];
  nextCursor: string | null;
}

export function recordsHttpClient(baseUrl: string): HttpClient {
  return createHttpClient({ name: 'records', baseUrl });
}

export function createRecordsReference(http: HttpClient | null, tokens: ServiceTokenClient | null): RecordsReference {
  const auth = async (tenantId: string) => ({ authorization: `Bearer ${await tokens?.token('records', tenantId)}` });
  return {
    available: !!http && !!tokens,
    async vocabulary(tenantId) {
      if (!http) throw new Error('records client not configured');
      const r = await http.request<VocabularyReleaseDoc>('/v1/vocabulary', { headers: await auth(tenantId) });
      if (r.status !== 200) throw new Error(`records vocabulary: ${r.status}`);
      return r.body;
    },
    async micromarkets(tenantId) {
      if (!http) throw new Error('records client not configured');
      const out: MicromarketNode[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const r: { status: number; body: MicromarketPage } = await http.request<MicromarketPage>('/v1/micromarkets', {
          headers: await auth(tenantId),
          query: { limit: 100, ...(cursor ? { cursor } : {}) },
        });
        if (r.status !== 200) throw new Error(`records micromarkets: ${r.status}`);
        for (const m of r.body.items)
          out.push({
            id: m.id,
            parentId: m.parentId ?? null,
            level: m.level,
            name: m.name,
            aliases: m.aliases ?? [],
            city: m.city,
            inLaunchArea: m.inLaunchArea,
            treeVersion: m.treeVersion ?? null,
          });
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
  };
}
