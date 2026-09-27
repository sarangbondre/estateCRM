// POST /auth/email: LOCAL DEVELOPMENT ONLY (ENVIRONMENT_NAME=local). Sends a sign-in link through the local Supabase
// mail catcher, for existing (invited) users only, so the app can be used before Google OAuth is provisioned.
import { runtime } from '@/main';
import { redirect, safeNext, sessionFor } from '@/server/auth-flow';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const rt = runtime();
  if (!rt.config.localEmailSignIn) return new Response('not-found', { status: 404 });
  const origin = req.headers.get('origin');
  if (origin && origin !== rt.config.appOrigin) return new Response('origin-not-allowed', { status: 403 });
  const form = await req.formData().catch(() => new FormData());
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase();
  const next = safeNext(String(form.get('next') ?? '/'));
  const { client, setCookies } = sessionFor(req);
  if (email) {
    await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${rt.config.appOrigin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
  }
  // Same answer whether or not the address exists.
  return redirect(`${rt.config.appOrigin}/sign-in?sent=1`, setCookies);
}
