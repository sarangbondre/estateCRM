import type { Metadata } from 'next';
import { SignInBox } from '@/ui/auth/SignInBox';

export const metadata: Metadata = { title: 'Sign in' };

const REASONS: Record<string, string> = {
  'not-invited': 'This Google account has not been invited. Ask your Admin for an invitation.',
  'user-deactivated': 'This account is deactivated. Ask your Admin if you need access again.',
  'session-expired': 'Your session ended. Sign in again.',
  'auth-failed': 'Sign-in did not complete. Try again.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const reason = typeof sp['reason'] === 'string' ? sp['reason'] : undefined;
  const next =
    typeof sp['next'] === 'string' && sp['next'].startsWith('/') && !sp['next'].startsWith('//')
      ? sp['next']
      : '/';
  return (
    <main className="login">
      <SignInBox message={reason ? (REASONS[reason] ?? REASONS['auth-failed']) : undefined} next={next} />
    </main>
  );
}
