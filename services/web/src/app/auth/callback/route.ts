// GET /auth/callback?code=…: PKCE code exchange → session cookies → invited-user check (web LLD §4.1 step 2).
import { runtime } from '@/main';
import { completeSignIn, redirect, safeNext, sessionFor } from '@/server/auth-flow';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'));
  const { client, setCookies } = sessionFor(req);
  if (!code) return redirect(`${runtime().config.appOrigin}/sign-in?reason=auth-failed`, setCookies);
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data.session)
    return redirect(`${runtime().config.appOrigin}/sign-in?reason=auth-failed`, setCookies);
  return completeSignIn(client, setCookies, data.session.access_token, next);
}
