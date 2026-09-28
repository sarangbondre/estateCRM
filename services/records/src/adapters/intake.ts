// IntakeRowsClient (R-2, records LLD §4.2 step 3): intake's internal row and migration-map API with a service token
// (aud=intake) minted by web; 2 s timeout, 3 retries with jitter, circuit breaker (libs/http client).
import { createServiceTokenClient } from '@11e/auth';
import { DownstreamError, createHttpClient } from '@11e/http';
import type { HttpClient } from '@11e/http';
import { BatchNotFoundError } from '../application/ports.js';
import type { IntakeRowBatch, IntakeRowsClient, MigrationMapEntry } from '../application/ports.js';
import type { Config } from '../config.js';

export interface IntakeClientOptions {
  baseUrl: string;
  /** Bearer token for intake (service token, or a fixed token in tests against the contract mock). */
  token: (tenantId: string) => Promise<string>;
  fetch?: typeof fetch;
}

export function intakeRowsClient(options: IntakeClientOptions): IntakeRowsClient {
  const http: HttpClient = createHttpClient({
    name: 'intake',
    baseUrl: options.baseUrl,
    timeoutMs: 2000,
    retries: 3,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const auth = async (tenantId: string) => ({ authorization: `Bearer ${await options.token(tenantId)}` });
  return {
    async batch(tenantId, uploadId, batchNo, correlationId) {
      const r = await http.request<IntakeRowBatch & { code?: string }>(`internal/v1/uploads/${uploadId}/rows`, {
        query: { batch: batchNo },
        headers: await auth(tenantId),
        correlationId,
      });
      if (r.status === 404) throw new BatchNotFoundError(`batch ${batchNo} of upload ${uploadId} not found`);
      if (r.status !== 200) throw new DownstreamError('intake', r.status, `intake rows: ${r.status}`);
      return r.body;
    },
    async migrationMap(tenantId, uploadId, cursor, correlationId) {
      const r = await http.request<{ items: MigrationMapEntry[]; nextCursor: string | null }>(
        `internal/v1/uploads/${uploadId}/migration-map`,
        { query: { limit: 1000, ...(cursor ? { cursor } : {}) }, headers: await auth(tenantId), correlationId },
      );
      if (r.status === 404) return { items: [], nextCursor: null };
      if (r.status !== 200) throw new DownstreamError('intake', r.status, `intake migration map: ${r.status}`);
      return { items: r.body.items ?? [], nextCursor: r.body.nextCursor ?? null };
    },
  };
}

/** Production wiring: tokens from web's service-token endpoint with this service's credential. */
export function createIntakeClient(config: Config): IntakeRowsClient | undefined {
  if (!config.serviceCredential) return undefined;
  const tokens = createServiceTokenClient({ webUrl: config.webUrl, credential: config.serviceCredential });
  return intakeRowsClient({ baseUrl: config.intakeUrl, token: (tenantId) => tokens.token('intake', tenantId) });
}
