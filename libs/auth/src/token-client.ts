// Service-token client (R-2): obtains `aud=<target>` tokens from web's POST /internal/v1/service-tokens with this
// service's credential, and caches each until shortly before it expires. Use as `headers` in createHttpClient.
export interface ServiceTokenClientOptions {
  /** web base URL */
  webUrl: string;
  /** X-Service-Credential for this service (from the secrets store / Vercel env). */
  credential: string;
  /** Refresh this long before expiry. Default 60 s. */
  refreshBeforeMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ServiceTokenClient {
  token(audience: string, tenantId: string): Promise<string>;
  /** `headers` provider for @11e/http createHttpClient. */
  headersFor(audience: string, tenantId: string): () => Promise<Record<string, string>>;
}

export function createServiceTokenClient(options: ServiceTokenClientOptions): ServiceTokenClient {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<string>>();
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;
  const margin = options.refreshBeforeMs ?? 60_000;

  async function fetchToken(
    audience: string,
    tenantId: string,
  ): Promise<{ token: string; expiresAt: number }> {
    const res = await doFetch(
      new URL(
        'internal/v1/service-tokens',
        options.webUrl.endsWith('/') ? options.webUrl : `${options.webUrl}/`,
      ),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-credential': options.credential },
        body: JSON.stringify({ audience, tenantId }),
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!res.ok) throw new Error(`service token for ${audience}: web answered ${res.status}`);
    const body = (await res.json()) as { token?: string; expiresAt?: string; expiresIn?: number };
    if (!body.token) throw new Error('service token response without token');
    const expiresAt = body.expiresAt ? Date.parse(body.expiresAt) : now() + (body.expiresIn ?? 300) * 1000;
    return { token: body.token, expiresAt };
  }

  async function token(audience: string, tenantId: string): Promise<string> {
    const key = `${audience}|${tenantId}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt - margin > now()) return hit.token;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = fetchToken(audience, tenantId)
      .then((t) => {
        cache.set(key, t);
        return t.token;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    token,
    headersFor: (audience, tenantId) => async () => ({
      authorization: `Bearer ${await token(audience, tenantId)}`,
    }),
  };
}
