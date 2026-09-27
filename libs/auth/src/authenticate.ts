// Contract-driven authentication (F-11): for each operation, satisfy one of its OpenAPI security requirements,
// then enforce x-roles (staff) and x-callers (service tokens). Web is the token issuer (R-2); keys come from its JWKS.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import type { JSONWebKeySet, JWTPayload, JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Operation, ServiceContext, ServiceEnv } from '@11e/http';
import { HttpError, forbidden, unauthenticated } from '@11e/http';
import { STAFF_ROLES } from './principal.js';
import type {
  Principal,
  ServicePrincipal,
  StaffPrincipal,
  StaffRole,
  WebsitePrincipal,
} from './principal.js';
import { secretsEqual } from './secrets.js';

const SERVICES = new Set(['web', 'intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthOptions {
  /** This service's name = the token audience. */
  service: string;
  /** web's JWKS URL (`<web>/.well-known/jwks.json`), cached 10 min. */
  jwksUrl?: string;
  /** Alternative to jwksUrl (tests, or a pinned key set). */
  jwks?: JSONWebKeySet;
  issuer?: string;
  /** `X-Cron-Secret` value expected on scheduler routes. */
  cronSecret?: string;
  /** Resolves a website API key (listings). Return null when unknown or revoked. */
  verifyApiKey?: (key: string) => Promise<{ tenantId: string; keyId: string } | null>;
  clockToleranceSec?: number;
}

type Scheme = 'staffViaWeb' | 'serviceToken' | 'cronSecret' | 'websiteApiKey';

class AuthFailure extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export function authenticate(options: AuthOptions): MiddlewareHandler<ServiceEnv> {
  const issuer = options.issuer ?? 'web';
  let keys: JWTVerifyGetKey | undefined;
  const getKeys = (): JWTVerifyGetKey => {
    if (keys) return keys;
    if (options.jwks) keys = createLocalJWKSet(options.jwks);
    else if (options.jwksUrl) {
      keys = createRemoteJWKSet(new URL(options.jwksUrl), {
        cacheMaxAge: 10 * 60_000,
        cooldownDuration: 30_000,
      });
    } else throw new Error('auth: jwksUrl or jwks is required for bearer tokens');
    return keys;
  };

  const verifyBearer = async (c: ServiceContext): Promise<JWTPayload> => {
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    if (!m?.[1]) throw new AuthFailure(401, 'missing bearer token');
    try {
      const { payload } = await jwtVerify(m[1], getKeys(), {
        issuer,
        audience: options.service,
        algorithms: ['ES256'],
        clockTolerance: options.clockToleranceSec ?? 5,
        requiredClaims: ['exp', 'sub', 'tid'],
      });
      return payload;
    } catch {
      throw new AuthFailure(401, 'invalid token');
    }
  };

  const staff = (c: ServiceContext, claims: JWTPayload, op: Operation): StaffPrincipal => {
    const uid = claims['uid'];
    const role = claims['role'];
    const tid = claims['tid'];
    if (typeof uid !== 'string' || typeof tid !== 'string' || typeof role !== 'string') {
      throw new AuthFailure(401, 'not a user-context token');
    }
    if (!STAFF_ROLES.includes(role as StaffRole)) throw new AuthFailure(401, 'unknown role');
    // web sets these headers from the same claims; a mismatch means tampering or a bug (web LLD §4.2).
    if (
      c.req.header('x-user-id') !== uid ||
      c.req.header('x-user-role') !== role ||
      c.req.header('x-tenant-id') !== tid
    ) {
      throw new AuthFailure(401, 'user headers do not match the token');
    }
    const roles = ((op.raw['x-roles'] as string[] | undefined) ?? []).filter((r) =>
      STAFF_ROLES.includes(r as StaffRole),
    );
    if (roles.length && !roles.includes(role)) throw new AuthFailure(403, `role ${role} is not allowed`);
    const p: StaffPrincipal = {
      kind: 'staff',
      tenantId: tid,
      userId: uid,
      role: role as StaffRole,
      tokenId: String(claims.jti ?? ''),
    };
    if (claims['dop'] !== undefined) p.dop = claims['dop'];
    return p;
  };

  const service = (claims: JWTPayload, op: Operation): ServicePrincipal => {
    if (claims['uid'] !== undefined)
      throw new AuthFailure(401, 'user-context token where a service token is required');
    const caller = claims.sub ?? '';
    if (!SERVICES.has(caller)) throw new AuthFailure(401, 'unknown calling service');
    const callers = ((op.raw['x-callers'] as string[] | undefined) ?? []).filter((x) => SERVICES.has(x));
    if (callers.length && !callers.includes(caller))
      throw new AuthFailure(403, `caller ${caller} is not allowed`);
    return { kind: 'service', caller, tenantId: String(claims['tid']), tokenId: String(claims.jti ?? '') };
  };

  const trySchemes = async (c: ServiceContext, op: Operation, schemes: Scheme[]): Promise<Principal> => {
    const bearer = schemes.filter((s) => s === 'staffViaWeb' || s === 'serviceToken');
    if (bearer.length && c.req.header('authorization')) {
      const claims = await verifyBearer(c);
      if (typeof claims['tid'] !== 'string' || !UUID.test(claims['tid']))
        throw new AuthFailure(401, 'invalid tenant claim');
      const isUser = claims['uid'] !== undefined;
      if (isUser && bearer.includes('staffViaWeb')) return staff(c, claims, op);
      if (!isUser && bearer.includes('serviceToken')) return service(claims, op);
      throw new AuthFailure(
        403,
        isUser ? 'user tokens are not accepted here' : 'service tokens are not accepted here',
      );
    }
    if (schemes.includes('cronSecret') && c.req.header('x-cron-secret') !== undefined) {
      if (!secretsEqual(c.req.header('x-cron-secret'), options.cronSecret))
        throw new AuthFailure(401, 'invalid cron secret');
      return { kind: 'scheduler' };
    }
    if (schemes.includes('websiteApiKey') && c.req.header('x-api-key') !== undefined) {
      const found = options.verifyApiKey ? await options.verifyApiKey(c.req.header('x-api-key') ?? '') : null;
      if (!found) throw new AuthFailure(401, 'invalid api key');
      const p: WebsitePrincipal = { kind: 'website', tenantId: found.tenantId, keyId: found.keyId };
      return p;
    }
    throw new AuthFailure(401, 'credentials required');
  };

  return async (c, next) => {
    const op = c.get('operation');
    if (!op) throw new Error('auth: operation not resolved (register routes with svc.op)');
    if (!op.security.length) {
      c.set('principal', { kind: 'anonymous' } satisfies Principal);
      return next();
    }
    // Alternatives are ORed. Each requirement object here has exactly one scheme (all specs follow that).
    const schemes = op.security.flatMap((req) => Object.keys(req)) as Scheme[];
    try {
      c.set('principal', await trySchemes(c, op, schemes));
    } catch (err) {
      if (err instanceof AuthFailure)
        throw err.status === 401 ? unauthenticated(err.message) : forbidden(err.message);
      if (err instanceof HttpError) throw err;
      throw err;
    }
    return next();
  };
}
