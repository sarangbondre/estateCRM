// web's HTTP app: its own contract operations (contracts/openapi/web.yaml) on the libs/http service factory, with
// web's security schemes. The gateway (every other /v1 route) is added by the proxy (WEB-03).
import spec from '@11e/contracts/openapi/web.json' with { type: 'json' };
import type { operations } from '@11e/contracts/web';
import { checkDbReady } from '@11e/db';
import type { Kysely } from '@11e/db';
import { createService } from '@11e/http';
import type { OpenApiDoc, Service } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { EnvironmentInfo, Sessions } from '../../application/sessions';
import type { Tokens } from '../../application/tokens';
import { roleCatalogue } from '../../domain/roles';
import type { RateLimiter, TokenSigner } from '../../application/ports';
import { EXPECTED_MIGRATION } from '../../config';
import type { WebDb } from '../db/schema';
import { cookieSession } from '../supabase';
import type { SupabaseSettings } from '../supabase';
import { registerGateway } from './proxy';
import type { GatewayRouteDeps } from './proxy';
import { limit, mapped, securityMiddleware, staffOf } from './security';

export interface ApiDeps {
  db: Kysely<WebDb> | null;
  obs: Observability;
  sessions: Sessions;
  tokens: Tokens;
  signer: TokenSigner;
  supabase: SupabaseSettings;
  appOrigin: string;
  cronSecret: string;
  environment: EnvironmentInfo;
  /** Extra readiness checks (downstream circuit states, WEB-03). */
  readyChecks?: () => Record<string, string>;
  /** Token buckets (api on every own call, service_token per caller). */
  limiter?: RateLimiter;
  /** The gateway for every other /v1 route and /p/{token} (WEB-03). */
  gateway?: GatewayRouteDeps;
}

export type WebService = Service<operations>;

export function buildApi(deps: ApiDeps): WebService {
  const svc = createService<operations>({
    service: 'web',
    spec: spec as unknown as OpenApiDoc,
    ready: async () => {
      const checks: Record<string, string> = {};
      let ok = true;
      if (deps.db) {
        const r = await checkDbReady(deps.db, EXPECTED_MIGRATION);
        checks['db'] = r.ok ? 'ok' : (r.reason ?? 'down');
        ok &&= r.ok;
      }
      checks['signingKey'] = deps.signer.ready() ? 'ok' : 'not loaded';
      if (!deps.signer.ready()) {
        try {
          await deps.signer.jwks();
          checks['signingKey'] = 'ok';
        } catch {
          ok = false;
        }
      }
      Object.assign(checks, deps.readyChecks?.() ?? {});
      return { ok, checks };
    },
    middleware: [deps.obs.middleware],
    operationMiddleware: [securityMiddleware({ ...deps })],
    onRequestEnd: deps.obs.onRequestEnd,
    onError: deps.obs.onError,
  });

  svc.op(
    'getMe',
    mapped(async (c) => c.json(deps.sessions.me(staffOf(c), deps.environment))),
  );

  svc.op(
    'signOut',
    mapped(async (c) => {
      const staff = staffOf(c);
      // Revoke the refresh token and clear the session cookies (bearer-only callers have none to clear).
      const { client, setCookies } = cookieSession(deps.supabase, c.req.header('cookie') ?? null);
      await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
      deps.tokens.evictUser(staff.userId);
      await deps.sessions.recordSignOut(staff, c.get('correlationId'));
      const res = c.body(null, 204);
      for (const sc of setCookies) res.headers.append('set-cookie', sc);
      return res;
    }),
  );

  svc.op(
    'listRoles',
    mapped(async (c) => c.json({ items: roleCatalogue() })),
  );

  svc.op(
    'getJwks',
    mapped(async (c) => {
      const jwks = await deps.tokens.jwks();
      c.header('cache-control', 'public, max-age=600');
      return c.json(jwks);
    }),
  );

  svc.op(
    'mintServiceToken',
    mapped(async (c, { body }) => {
      const client = await deps.tokens.authenticateClient(c.req.header('x-service-credential'));
      c.set('principal', { kind: 'service', caller: client.name, tenantId: body.tenantId });
      await limit(c, deps.limiter, NIL_TENANT, client.name, 'service_token');
      const minted = await deps.tokens.mintFor(client, body.audience, body.tenantId);
      return c.json({ token: minted.token, expiresAt: minted.expiresAt.toISOString() });
    }),
  );

  if (deps.gateway) registerGateway(svc.app, deps.gateway);
  return svc;
}

const NIL_TENANT = '00000000-0000-0000-0000-000000000000';
