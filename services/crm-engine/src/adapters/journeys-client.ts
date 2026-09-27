// journeys' GET /internal/v1/subject-states (projection rebuild, service token aud=journeys minted by web, R-2).
// Used only by projection-reconcile; never on a request path. Fallback: the job fails and resumes from its cursor.
import type { components } from '@11e/contracts/journeys';
import { createServiceTokenClient } from '@11e/auth';
import { DownstreamError, createHttpClient } from '@11e/http';
import type { ClientOptions } from '@11e/http';
import type { SubjectStateSource } from '../application/ports.js';

type Page = components['schemas']['SubjectStatePage'];

export interface JourneysClientOptions {
  journeysUrl: string;
  webUrl: string;
  credential: string | undefined;
  fetch?: typeof fetch;
  /** RED metrics per downstream (libs/observability onCall). */
  onCall?: ClientOptions['onCall'];
}

export function journeysSubjectStates(options: JourneysClientOptions): SubjectStateSource {
  const client = createHttpClient({
    name: 'journeys',
    baseUrl: options.journeysUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.onCall ? { onCall: options.onCall } : {}),
  });
  const tokens = options.credential
    ? createServiceTokenClient({
        webUrl: options.webUrl,
        credential: options.credential,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : null;
  return {
    async page(tenantId, subjectType, cursor) {
      if (!tokens) throw new DownstreamError('journeys', undefined, 'SERVICE_CREDENTIAL is not configured');
      const res = await client.request<Page>('/internal/v1/subject-states', {
        query: { subjectType, limit: 100, ...(cursor ? { cursor } : {}) },
        headers: { authorization: `Bearer ${await tokens.token('journeys', tenantId)}` },
      });
      return {
        items: res.body.items.map((s) => ({
          subjectType: s.subjectType,
          subjectId: s.subjectId,
          commercialStatus: s.commercialStatus,
          exit: s.exit ?? null,
          lifeStage: s.lifeStage,
          version: s.version,
        })),
        nextCursor: res.body.nextCursor,
      };
    },
  };
}
