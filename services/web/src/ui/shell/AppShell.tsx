'use client';
// Chat-first layout (PRD §5.2, prototype render): sidebar | conversation | side panel. Registers the cards and panels.
import type { ReactNode } from 'react';
import '../cards/all';
import { Icon } from './Icon';
import { NotificationBell } from './NotificationBell';
import { ShellProvider, useShell } from './ShellProvider';
import { SidePanel } from './SidePanel';
import { Sidebar } from './Sidebar';
import type { Me } from './types';

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  return (
    <ShellProvider me={me}>
      <Layout>{children}</Layout>
    </ShellProvider>
  );
}

function Layout({ children }: { children: ReactNode }) {
  const shell = useShell();
  const { me } = shell;
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Sidebar />
      <main className="main" id="main" tabIndex={-1}>
        <div className="topbar">
          <button
            type="button"
            className="ibtn menu-btn"
            aria-label="Menu"
            aria-expanded={shell.sideOpen}
            aria-controls="sidebar"
            onClick={() => shell.setSideOpen(!shell.sideOpen)}
          >
            <Icon name="menu" />
          </button>
          <h1>{shell.current?.title ?? '11estates CRM'}</h1>
          {me.environment.pilot && (
            <span className="proto" role="note">
              Pilot: sample / anonymised data only
            </span>
          )}
          <span style={{ marginLeft: me.environment.pilot ? 0 : 'auto' }}>
            <NotificationBell />
          </span>
        </div>
        {children}
      </main>
      <SidePanel />
      {shell.toastMessage && (
        <div className="toast" role="status">
          {shell.toastMessage}
        </div>
      )}
    </div>
  );
}
