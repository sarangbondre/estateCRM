'use client';
// DELETE /v1/me/session (web contract signOut): revokes the Supabase session and clears cookies, then back to sign-in.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { call } from '../lib/api';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="sbtn small muted"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await call('DELETE', '/v1/me/session');
        } catch {
          /* already signed out: continue to the sign-in page */
        }
        try {
          sessionStorage.clear();
        } catch {
          /* storage disabled */
        }
        router.replace('/sign-in');
      }}
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
