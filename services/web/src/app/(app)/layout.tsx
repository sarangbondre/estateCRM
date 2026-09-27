import type { ReactNode } from 'react';
import { AppShell } from '@/ui/shell/AppShell';
import { currentUser } from '@/server/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await currentUser();
  return <AppShell me={me}>{children}</AppShell>;
}
