// Service tokens (conventions §4, R-2; web LLD §4.2). web is the only issuer. Pure: claims and policy only; signing is
// an adapter (jose, ES256).
import type { RoleCode } from './roles';

export const SERVICES = ['intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight'] as const;
export type ServiceName = (typeof SERVICES)[number];
export const isServiceName = (v: unknown): v is ServiceName => SERVICES.includes(v as ServiceName);

export const ISSUER = 'web';
export const TOKEN_TTL_SEC = 300;
/** User-context tokens are cached per (user, audience) for 4 minutes (1 minute before they expire). */
export const USER_TOKEN_CACHE_MS = 240_000;

/**
 * Allowed caller → audience pairs for service-to-service tokens (web contract mintServiceToken): listings→records,
 * journeys→records, insight→records, records→intake, crm-engine→records, and every service→records (vocabulary).
 */
export const ALLOWED_AUDIENCES: Record<ServiceName, readonly ServiceName[]> = {
  intake: ['records'],
  records: ['intake'],
  journeys: ['records'],
  'crm-engine': ['records'],
  listings: ['records'],
  insight: ['records'],
};

export function audienceAllowed(
  caller: ServiceName,
  audience: ServiceName,
  clientAudiences: readonly string[],
): boolean {
  return ALLOWED_AUDIENCES[caller].includes(audience) && clientAudiences.includes(audience);
}

/** Claims of a user-context token (proxied calls). The same values go into X-User-Id / X-User-Role / X-Tenant-Id. */
export interface UserTokenClaims {
  iss: typeof ISSUER;
  sub: 'web';
  aud: ServiceName;
  tid: string;
  uid: string;
  role: RoleCode;
  dop: boolean;
}

/** Claims of a service-to-service token: no `uid` (libs/auth rejects a uid where a service token is required). */
export interface ServiceTokenClaims {
  iss: typeof ISSUER;
  sub: ServiceName;
  aud: ServiceName;
  tid: string;
}

export function userTokenClaims(p: {
  audience: ServiceName;
  tenantId: string;
  userId: string;
  role: RoleCode;
  isDataOperator: boolean;
}): UserTokenClaims {
  return {
    iss: ISSUER,
    sub: 'web',
    aud: p.audience,
    tid: p.tenantId,
    uid: p.userId,
    role: p.role,
    dop: p.isDataOperator,
  };
}

export function serviceTokenClaims(
  caller: ServiceName,
  audience: ServiceName,
  tenantId: string,
): ServiceTokenClaims {
  return { iss: ISSUER, sub: caller, aud: audience, tid: tenantId };
}

/** Signing-key rotation (every 90 days): the old key stays in JWKS as `previous` for 1 hour. */
export const KEY_ROTATION_DAYS = 90;
export const PREVIOUS_KEY_GRACE_MS = 3600_000;

/** 'next': published in JWKS before it signs (rotation step 1). */
export type SigningKeyStatus = 'next' | 'active' | 'previous' | 'retired';

export function rotationDue(activatedAt: Date, now: Date): boolean {
  return now.getTime() - activatedAt.getTime() >= KEY_ROTATION_DAYS * 86_400_000;
}
