// Authentication for web's own endpoints, driven by the contract's security schemes (web.yaml): staffSession
// (Supabase session cookie or bearer), serviceCredential (checked by the token-mint handler), cronSecret, none.
// Also the CSRF origin check for cookie-authenticated mutating requests (web LLD §4.1 e).
import type { MiddlewareHandler } from 'hono';
import { secretsEqual } from '@11e/auth';
import { HttpError } from '@11e/http';
import type { ServiceContext, ServiceEnv } from '@11e/http';
import type { Sessions, StaffContext } from '../../application/sessions';
import { WebError } from '../../domain/errors';
import { accessTokenOf } from '../supabase';
import type { SupabaseSettings } from '../supabase';

export interface StaffPrincipal {
  kind: 'staff';
  tenantId: string;
  userId: string;
  role: string;
  staff: StaffContext;
}

export function toHttpError(err: unknown): unknown {
  if (err instanceof WebError) {
    const headers: Record<string, string> = {};
    if (err.retryAfterSec !== undefined) headers['retry-after'] = String(err.retryAfterSec);
    return new HttpError(err.status, err.code, {
      ...(err.detail && err.detail !== err.code ? { detail: err.detail } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
  }
  return err;
}

/** Wraps a handler so WebError becomes an RFC 7807 HttpError. */
export function mapped<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw toHttpError(err);
    }
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface StaffAuthDeps {
  sessions: Sessions;
  supabase: SupabaseSettings;
  appOrigin: string;
}

/**
 * Resolves the signed-in staff member for a request: bearer or cookie session (refreshed when near expiry; new
 * cookies are added to the response), CSRF origin check for cookie sessions, then Sessions.authenticate.
 */
export async function authenticateStaff(c: ServiceContext, deps: StaffAuthDeps): Promise<StaffContext> {
  const { token, setCookies, fromCookie } = await accessTokenOf(deps.supabase, c.req.raw.headers);
  for (const sc of setCookies) c.header('set-cookie', sc, { append: true });
  if (fromCookie && MUTATING.has(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin !== deps.appOrigin) throw new WebError('origin-not-allowed');
  }
  const staff = await deps.sessions.authenticate(token);
  const p: StaffPrincipal = {
    kind: 'staff',
    tenantId: staff.tenantId,
    userId: staff.userId,
    role: staff.role,
    staff,
  };
  c.set('principal', p);
  return staff;
}

export function staffOf(c: ServiceContext): StaffContext {
  const p = c.get('principal') as StaffPrincipal | undefined;
  if (p?.kind !== 'staff') throw new HttpError(401, 'unauthenticated');
  return p.staff;
}

export function securityMiddleware(
  deps: StaffAuthDeps & { cronSecret: string },
): MiddlewareHandler<ServiceEnv> {
  return async (c, next) => {
    const op = c.get('operation');
    if (!op) throw new Error('security: operation not resolved');
    const schemes = op.security.flatMap((req) => Object.keys(req));
    try {
      if (!schemes.length) {
        c.set('principal', { kind: 'anonymous' });
      } else if (schemes.includes('staffSession')) {
        const staff = await authenticateStaff(c, deps);
        const roles = (op.raw['x-roles'] as string[] | undefined) ?? [];
        if (roles.length && !roles.includes(staff.role))
          throw new WebError('forbidden', `role ${staff.role} is not allowed`);
      } else if (schemes.includes('cronSecret')) {
        if (!secretsEqual(c.req.header('x-cron-secret'), deps.cronSecret))
          throw new WebError('unauthenticated');
        c.set('principal', { kind: 'scheduler' });
      } else if (schemes.includes('serviceCredential')) {
        // The token-mint handler resolves the credential (401 service-credential-invalid).
        c.set('principal', { kind: 'service-client' });
      } else {
        throw new WebError('unauthenticated');
      }
    } catch (err) {
      throw toHttpError(err);
    }
    await next();
  };
}
