// The signed-in user for server-rendered pages: Supabase session cookie → Sessions.authenticate → the /v1/me view.
// Anything else sends the browser to the sign-in page (proxy.ts refreshes cookies on navigation).
import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { runtime } from '@/main';
import { WebError } from '@/domain/errors';
import type { Me } from '@/ui/shell/types';

export async function currentUser(): Promise<Me> {
  const rt = runtime();
  const store = await cookies();
  const client = createServerClient(rt.supabase.url, rt.supabase.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      // Server components can't set cookies; proxy.ts refreshes the session before rendering.
      setAll: () => undefined,
    },
  });
  const { data } = await client.auth.getSession();
  let reason = 'session-expired';
  if (data.session) {
    try {
      const staff = await rt.sessions.authenticate(data.session.access_token);
      return rt.sessions.me(staff, rt.environment) as Me;
    } catch (err) {
      if (err instanceof WebError) reason = err.code;
      else throw err;
    }
  }
  redirect(
    `/sign-in?reason=${encodeURIComponent(reason === 'unauthenticated' ? 'session-expired' : reason)}`,
  );
}
