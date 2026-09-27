'use client';
// Side panel (D-9, prototype panelView): My queue, records, tables, dashboards, desks. Escape closes it; focus moves to
// its heading when it opens and back to the page when it closes.
import { useEffect, useRef } from 'react';
import { panelFor } from '../cards/registry';
import { Icon } from './Icon';
import { useShell } from './ShellProvider';

export function SidePanel() {
  const shell = useShell();
  const { panel } = shell;
  const heading = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!panel) return;
    returnTo.current ??= document.activeElement;
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shell.closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, shell]);

  useEffect(() => {
    if (panel) return;
    const el = returnTo.current;
    returnTo.current = null;
    if (el instanceof HTMLElement) el.focus();
  }, [panel]);

  if (!panel) return null;
  const Panel = panelFor(panel.kind);
  return (
    <aside className="panel" aria-labelledby="panel-title">
      <div className="panel-h">
        <h2 id="panel-title" ref={heading} tabIndex={-1}>
          {panel.title}
        </h2>
        <button type="button" className="ibtn" onClick={shell.closePanel} aria-label="Close panel">
          <Icon name="close" />
        </button>
      </div>
      <div className="panel-b">
        <Panel
          key={`${panel.kind}:${JSON.stringify(panel.props ?? {})}`}
          props={panel.props ?? {}}
          shell={shell}
        />
      </div>
    </aside>
  );
}
