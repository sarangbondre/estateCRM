// Sign-in route helpers (web LLD §4.1): Google OAuth with PKCE via Supabase Auth; only invited users get in.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { uuidv7 } from 'uuidv7';
import { runtime } from '@/main';
import { cookieSession } from '@/adapters/supabase';
import { WebError } from '@/domain/errors';

export function safeNext(value: string | null | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

export function redirect(to: string, setCookies: string[] = [], status = 303): Response {
  const headers = new Headers({ location: to, 'cache-control': 'no-store' });
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(null, { status, headers });
}

export function sessionFor(req: Request): { client: SupabaseClient; setCookies: string[] } {
  return cookieSession(runtime().supabase, req.headers.get('cookie'));
}

/** After Supabase created a session: activate the invited user or refuse (and drop the session). */
export async function completeSignIn(
  client: SupabaseClient,
  setCookies: string[],
  accessToken: string,
  next: string,
): Promise<Response> {
  const rt = runtime();
  try {
    await rt.sessions.completeSignIn(accessToken, uuidv7());
    return redirect(`${rt.config.appOrigin}${next}`, setCookies);
  } catch (err) {
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    const reason =
      err instanceof WebError && ['not-invited', 'user-deactivated'].includes(err.code)
        ? err.code
        : 'auth-failed';
    return redirect(`${rt.config.appOrigin}/sign-in?reason=${reason}`, setCookies);
  }
}
