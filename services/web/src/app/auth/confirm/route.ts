// GET /auth/confirm?token_hash=…&type=invite|magiclink|email: e-mail links (Supabase invite e-mail template with
// {{ .TokenHash }}, and the local-only e-mail sign-in) → session → invited-user check.
import type { EmailOtpType } from '@supabase/supabase-js';
import { runtime } from '@/main';
import { completeSignIn, redirect, safeNext, sessionFor } from '@/server/auth-flow';

export const dynamic = 'force-dynamic';
const TYPES = new Set(['invite', 'magiclink', 'email', 'signup']);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') ?? '';
  const next = safeNext(url.searchParams.get('next'));
  const { client, setCookies } = sessionFor(req);
  if (!tokenHash || !TYPES.has(type))
    return redirect(`${runtime().config.appOrigin}/sign-in?reason=auth-failed`, setCookies);
  const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType });
  if (error || !data.session)
    return redirect(`${runtime().config.appOrigin}/sign-in?reason=auth-failed`, setCookies);
  return completeSignIn(client, setCookies, data.session.access_token, next);
}
