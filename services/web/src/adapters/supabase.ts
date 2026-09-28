// Supabase Auth adapters (web LLD §4.1, §4.8): access-token verification against the Auth JWKS (local, cached 10
// min), the admin API (service-role key, web only) and cookie sessions via @supabase/ssr (httpOnly, SameSite=Lax).
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthProvider, VerifiedAccessToken } from '../application/ports';
import { WebError } from '../domain/errors';

export interface SupabaseSettings {
  url: string;
  anonKey: string;
  serviceRoleKey: string | undefined;
  /** Secure cookies except on plain-http local development. */
  secureCookies: boolean;
}

export class SupabaseAuthProvider implements AuthProvider {
  private readonly jwks;
  private adminClient: SupabaseClient | null = null;

  constructor(private readonly s: SupabaseSettings) {
    this.jwks = createRemoteJWKSet(new URL(`${s.url}/auth/v1/.well-known/jwks.json`), {
      cacheMaxAge: 10 * 60_000,
      cooldownDuration: 30_000,
      timeoutDuration: 2000,
    });
  }

  async verifyAccessToken(token: string): Promise<VerifiedAccessToken | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: `${this.s.url}/auth/v1`,
        audience: 'authenticated',
        clockTolerance: 5,
        requiredClaims: ['sub', 'exp'],
      });
      return {
        userId: String(payload.sub),
        email: typeof payload['email'] === 'string' ? payload['email'] : null,
        expiresAt: new Date((payload.exp ?? 0) * 1000),
      };
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_JOSE_GENERIC' || (err as Error).name === 'TypeError') {
        throw new WebError('dependency-unavailable', 'auth keys unavailable', 30);
      }
      return null;
    }
  }

  private admin(): SupabaseClient {
    if (!this.s.serviceRoleKey)
      throw new WebError('dependency-unavailable', 'SUPABASE_SERVICE_ROLE_KEY is not set');
    this.adminClient ??= createClient(this.s.url, this.s.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return this.adminClient;
  }

  async inviteUserByEmail(email: string, redirectTo: string): Promise<{ userId: string }> {
    const { data, error } = await this.admin().auth.admin.inviteUserByEmail(email, { redirectTo });
    if (error || !data.user) {
      if (error?.status === 422 || /already/i.test(error?.message ?? '')) throw new WebError('user-exists');
      throw new WebError('dependency-unavailable', 'Supabase Auth invite failed', 30);
    }
    return { userId: data.user.id };
  }

  async deleteUser(userId: string): Promise<void> {
    const { error } = await this.admin().auth.admin.deleteUser(userId);
    if (error && error.status !== 404)
      throw new WebError('dependency-unavailable', 'Supabase Auth delete failed', 30);
  }

  async setBlocked(userId: string, blocked: boolean): Promise<void> {
    const { error } = await this.admin().auth.admin.updateUserById(userId, {
      ban_duration: blocked ? '876000h' : 'none',
    });
    if (error && error.status !== 404)
      throw new WebError('dependency-unavailable', 'Supabase Auth update failed', 30);
  }
}

/** A request-scoped Supabase client over the request's cookies; cookies it sets are collected for the response. */
export function cookieSession(s: SupabaseSettings, cookieHeader: string | null) {
  const setCookies: string[] = [];
  const client = createServerClient(s.url, s.anonKey, {
    cookieOptions: { httpOnly: true, sameSite: 'lax', secure: s.secureCookies, path: '/' },
    cookies: {
      getAll: () =>
        parseCookieHeader(cookieHeader ?? '').map((c) => ({ name: c.name, value: c.value ?? '' })),
      setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
        for (const c of list)
          setCookies.push(
            serializeCookieHeader(c.name, c.value, {
              ...c.options,
              httpOnly: true,
              sameSite: 'lax',
              secure: s.secureCookies,
              path: '/',
            }),
          );
      },
    },
  });
  return { client, setCookies };
}

/** The access token of the request: `Authorization: Bearer` or the session cookie (refreshed when near expiry). */
export async function accessTokenOf(
  s: SupabaseSettings,
  headers: Headers,
): Promise<{ token: string | null; setCookies: string[]; fromCookie: boolean }> {
  const auth = headers.get('authorization');
  const m = auth ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(auth) : null;
  if (m?.[1]) return { token: m[1], setCookies: [], fromCookie: false };
  const cookie = headers.get('cookie');
  if (!cookie || !cookie.includes('-auth-token')) return { token: null, setCookies: [], fromCookie: false };
  const { client, setCookies } = cookieSession(s, cookie);
  const { data } = await client.auth.getSession();
  return { token: data.session?.access_token ?? null, setCookies, fromCookie: true };
}
