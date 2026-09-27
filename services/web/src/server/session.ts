// The signed-in user for server-rendered pages. WEB-01: a local placeholder so the shell can be built and tested;
// WEB-02 replaces this with the Supabase session + web.users lookup.
import 'server-only';
import type { Me } from '@/ui/shell/types';

export async function currentUser(): Promise<Me> {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-000000000000',
    email: 'admin@example.com',
    displayName: 'Local Admin',
    role: 'Admin',
    isDataOperator: false,
    permissions: [],
    sessionIdleExpiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    environment: { name: 'local', pilot: true, vocabularyVersion: null },
  };
}
