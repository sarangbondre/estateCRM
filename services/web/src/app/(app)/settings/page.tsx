import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <div className="scroll">
      <div className="settings">
        <h2>Settings</h2>
        <p className="muted">
          Users, capacities, thresholds, weights, micromarkets, vocabulary, MahaRERA, API keys and the audit
          log.
        </p>
      </div>
    </div>
  );
}
