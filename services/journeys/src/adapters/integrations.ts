// Outbound adapters (LLD §2 adapters/records, listings, storage, pdf): records' existing GET endpoints, listings'
// publication settings and intake's row-note endpoint (CR-012), all with a web-issued service token (R-2), behind
// timeouts, retries and circuit breakers.
import { createHash, randomBytes } from 'node:crypto';
import { createServiceTokenClient } from '@11e/auth';
import type { ServiceTokenClient } from '@11e/auth';
import { createHttpClient } from '@11e/http';
import type { HttpClient } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { OfferContent, PropertyContent } from '../domain/proposals.js';
import type {
  FileStoragePort,
  Integrations,
  ProposalContentPort,
  PublicationSettingsPort,
  TokenPort,
  UploadNotesPort,
} from '../application/ports.js';
import type { Config } from '../config.js';
import { createPdfRenderer } from './pdf.js';
import { createStorage } from './storage.js';

export function createTokens(salt: string): TokenPort {
  return {
    newToken: () => randomBytes(32).toString('base64url'),
    hash: (token) => createHash('sha256').update(token).digest(),
    // salt rotated monthly: the month is part of the hashed material
    ipHash: (ip, at) => createHash('sha256').update(`${salt}:${at.toISOString().slice(0, 7)}:${ip}`).digest(),
  };
}

function client(name: string, baseUrl: string, tokens: ServiceTokenClient | null, audience: string, obs: Observability) {
  const headers = new Map<string, () => Promise<Record<string, string>>>();
  return (tenantId: string): HttpClient =>
    createHttpClient({
      name,
      baseUrl,
      timeoutMs: 2000,
      retries: 2,
      onCall: obs.onCall,
      headers: async () => {
        if (!tokens) return {};
        let h = headers.get(tenantId);
        if (!h) {
          h = tokens.headersFor(audience, tenantId);
          headers.set(tenantId, h);
        }
        return h();
      },
    });
}

export function createRecordsContent(baseUrl: string, tokens: ServiceTokenClient | null, obs: Observability): ProposalContentPort {
  const clients = new Map<string, HttpClient>();
  const make = client('records', baseUrl, tokens, 'records', obs);
  const of = (tenantId: string) => {
    let c = clients.get(tenantId);
    if (!c) clients.set(tenantId, (c = make(tenantId)));
    return c;
  };
  return {
    async offer(tenantId, offerId) {
      const r = await of(tenantId).request<OfferContent>(`/v1/offers/${offerId}`);
      return r.status === 200 ? r.body : null;
    },
    async property(tenantId, propertyId) {
      const r = await of(tenantId).request<PropertyContent>(`/v1/properties/${propertyId}`);
      return r.status === 200 ? r.body : null;
    },
    async photos(tenantId, propertyId) {
      const r = await of(tenantId).request<{ items?: { id: string; url?: string | null; caption?: string | null; status?: string }[] }>(
        `/v1/properties/${propertyId}/photos`,
        { query: { limit: 30 } },
      );
      if (r.status !== 200) return [];
      return (r.body.items ?? [])
        .filter((p) => !p.status || p.status === 'ready')
        .map((p) => ({ id: p.id, url: p.url ?? null, caption: p.caption ?? null }));
    },
  };
}

export function createPublicationSettings(baseUrl: string, tokens: ServiceTokenClient | null, obs: Observability): PublicationSettingsPort {
  const make = client('listings', baseUrl, tokens, 'listings', obs);
  return {
    async mahareraAgentNumber(tenantId) {
      const r = await make(tenantId).request<{ mahareraAgentNumber?: string }>('/v1/publication-settings');
      // 404 / no number yet: the pilot shows "registration pending" (questionnaire A7).
      return r.status === 200 && r.body?.mahareraAgentNumber ? r.body.mahareraAgentNumber : null;
    },
  };
}

/**
 * intake GET /internal/v1/uploads/{uploadId}/rows/{rowNo}/note (CR-012). The body may hold PII: it is returned to the
 * caller only, never logged (the http client logs method, path, status and duration). 404 → null (no note or purged).
 */
export function createUploadNotes(baseUrl: string, tokens: ServiceTokenClient | null, obs: Observability): UploadNotesPort {
  const clients = new Map<string, HttpClient>();
  const make = client('intake', baseUrl, tokens, 'intake', obs);
  return {
    async rowNote(tenantId, uploadId, rowNo) {
      let c = clients.get(tenantId);
      if (!c) clients.set(tenantId, (c = make(tenantId)));
      const r = await c.request<{ note?: string; uploadCode?: string }>(
        `/internal/v1/uploads/${encodeURIComponent(uploadId)}/rows/${rowNo}/note`,
      );
      if (r.status === 404) return null;
      if (r.status !== 200 || typeof r.body?.note !== 'string') throw new Error(`intake note: unexpected status ${r.status}`);
      return { note: r.body.note, uploadCode: r.body.uploadCode ?? null };
    },
  };
}

export function createIntegrations(config: Config, obs: Observability): Integrations {
  const tokens = config.serviceCredential
    ? createServiceTokenClient({ webUrl: config.webUrl, credential: config.serviceCredential })
    : null;
  const storage: FileStoragePort = createStorage(config);
  return {
    content: createRecordsContent(config.recordsUrl, tokens, obs),
    publication: createPublicationSettings(config.listingsUrl, tokens, obs),
    uploadNotes: createUploadNotes(config.intakeUrl, tokens, obs),
    storage,
    pdf: createPdfRenderer(),
    tokens: createTokens(config.ipHashSalt),
    publicBaseUrl: config.publicBaseUrl,
  };
}
