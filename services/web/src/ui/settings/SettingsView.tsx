'use client';
// Settings page view (WEB-08; PRD §5.5 page catalogue, §2.3 role matrix, US-34/US-35/US-37; prototype settingsView):
// tabs gated by role (Admin everything; Manager capacities plus read-only reference), deep-linkable via `?tab=`.
import { useState } from 'react';
import type { ComponentType } from 'react';
import Link from 'next/link';
import { Tabs } from '../cards/common';
import { useShell } from '../shell/ShellProvider';
import { canEdit, canOpenSettings, resolveTab, visibleTabs } from './logic';
import type { TabSlug } from './logic';
import { UsersTab } from './UsersTab';
import { CapacitiesTab } from './CapacitiesTab';
import { LifeCurveTab, MatchWeightsTab, QueueWeightsTab } from './WeightsTabs';
import { MicromarketsTab } from './MicromarketsTab';
import { VocabularyTab } from './VocabularyTab';
import { PublicationTab } from './PublicationTab';
import { ApiKeysTab } from './ApiKeysTab';
import { AuditTab } from './AuditTab';
import type { TabProps } from './types';

export type { TabProps };


const VIEWS: Record<TabSlug, ComponentType<TabProps>> = {
  users: UsersTab,
  capacities: CapacitiesTab,
  'life-curve': LifeCurveTab,
  'queue-weights': QueueWeightsTab,
  'match-weights': MatchWeightsTab,
  micromarkets: MicromarketsTab,
  vocabulary: VocabularyTab,
  publication: PublicationTab,
  'api-keys': ApiKeysTab,
  audit: AuditTab,
};

export function SettingsView({ initialTab }: { initialTab?: string }) {
  const shell = useShell();
  const role = shell.me.role;
  const [slug, setSlug] = useState<TabSlug | null>(() => resolveTab(initialTab, role));

  if (!canOpenSettings(role) || !slug) {
    return (
      <div className="settings">
        <h2>Settings</h2>
        <p className="muted" role="status">
          Settings are not available for your role ({role}). Ask an Admin if something needs changing.
        </p>
        <Link className="btn" href="/" style={{ alignSelf: 'flex-start' }}>
          ‹ Back to chat
        </Link>
      </div>
    );
  }

  const tabs = visibleTabs(role);
  const labels = tabs.map((t) => t.label);
  const current = tabs.find((t) => t.slug === slug) ?? tabs[0]!;
  const View = VIEWS[current.slug];

  const choose = (label: string) => {
    const next = tabs.find((t) => t.label === label);
    if (!next) return;
    setSlug(next.slug);
    try {
      window.history.replaceState(null, '', `?tab=${next.slug}`);
    } catch {
      /* history unavailable: the tab still switches */
    }
  };

  return (
    <div className="settings">
      <h2>Settings</h2>
      <div className="card">
        <div style={{ padding: '0 8px' }}>
          <Tabs tabs={labels} value={current.label} onChange={choose} label="Settings sections" />
        </div>
        <div className="card-b" role="tabpanel" aria-label={current.label}>
          <View key={current.slug} shell={shell} editable={canEdit(current.slug, role)} />
        </div>
      </div>
      <Link className="btn" href="/" style={{ alignSelf: 'flex-start' }}>
        ‹ Back to chat
      </Link>
    </div>
  );
}
