// Next.js proxy (formerly middleware): refreshes the Supabase session cookie on page navigations and sends visitors
// without a session to the sign-in page. API routes authenticate in the gateway (src/adapters/http) instead.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const SUPABASE_URL = (
  process.env['SUPABASE_URL'] ??
  process.env['NEXT_PUBLIC_SUPABASE_URL'] ??
  'http://127.0.0.1:54321'
).replace(/\/$/, '');
const SUPABASE_ANON_KEY =
  process.env['SUPABASE_ANON_KEY'] ?? process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '';

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  if (!SUPABASE_ANON_KEY) return response;
  const secure = request.nextUrl.protocol === 'https:';
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookieOptions: { httpOnly: true, sameSite: 'lax', secure, path: '/' },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list)
          response.cookies.set(name, value, {
            ...options,
            httpOnly: true,
            sameSite: 'lax',
            secure,
            path: '/',
          });
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = '';
    if (request.nextUrl.pathname !== '/') url.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Pages only: not the API, auth routes, sign-in, static files or the public proposal page.
  matcher: ['/((?!v1/|internal/|health/|\\.well-known/|auth/|sign-in|p/|_next/|icon\\.svg|favicon\\.ico).*)'],
};
