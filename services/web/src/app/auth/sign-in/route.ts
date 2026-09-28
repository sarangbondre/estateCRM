// POST /auth/sign-in: start "Sign in with Google" (Supabase Auth, PKCE; the verifier lives in an httpOnly cookie).
import { runtime } from '@/main';
import { redirect, safeNext, sessionFor } from '@/server/auth-flow';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const rt = runtime();
  const origin = req.headers.get('origin');
  if (origin && origin !== rt.config.appOrigin) return new Response('origin-not-allowed', { status: 403 });
  const form = await req.formData().catch(() => new FormData());
  const next = safeNext(String(form.get('next') ?? '/'));
  const { client, setCookies } = sessionFor(req);
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${rt.config.appOrigin}/auth/callback?next=${encodeURIComponent(next)}`,
      skipBrowserRedirect: true,
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error || !data.url)
    return redirect(`${rt.config.appOrigin}/sign-in?reason=google-unavailable`, setCookies);
  return redirect(data.url, setCookies);
}
