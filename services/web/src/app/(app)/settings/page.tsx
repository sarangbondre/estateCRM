// Settings page (WEB-08, PRD §5.5): a thin server page; the tabbed view is a client component. `?tab=` deep-links a tab.
import type { Metadata } from 'next';
import { SettingsView } from '@/ui/settings/SettingsView';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { tab } = await searchParams;
  return (
    <div className="scroll">
      <SettingsView {...(typeof tab === 'string' ? { initialTab: tab } : {})} />
    </div>
  );
}
