import type { Metadata } from 'next';
import { runtime } from '@/main';
import { SignInBox } from '@/ui/auth/SignInBox';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

const REASONS: Record<string, string> = {
  'not-invited': 'This Google account has not been invited. Ask your Admin for an invitation.',
  'user-deactivated': 'This account is deactivated. Ask your Admin if you need access again.',
  'session-expired': 'Your session ended. Sign in again.',
  'auth-failed': 'Sign-in did not complete. Try again.',
  'google-unavailable': 'Google sign-in is not available right now. Try again later.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const reason = typeof sp['reason'] === 'string' ? sp['reason'] : undefined;
  const nextParam = sp['next'];
  const next =
    typeof nextParam === 'string' && nextParam.startsWith('/') && !nextParam.startsWith('//')
      ? nextParam
      : '/';
  let localEmail: boolean;
  try {
    localEmail = runtime().config.localEmailSignIn;
  } catch {
    localEmail = false;
  }
  const message = sp['sent']
    ? 'If that address belongs to an invited user, a sign-in link is on its way (local mail catcher: http://127.0.0.1:54324).'
    : reason
      ? (REASONS[reason] ?? REASONS['auth-failed'])
      : undefined;
  return (
    <main className="login">
      <SignInBox message={message} next={next} localEmail={localEmail} />
    </main>
  );
}
