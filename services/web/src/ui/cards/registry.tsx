'use client';
// Card and panel registry: kind → component. Unknown kinds render a neutral "not available" card, so a conversation
// saved by a newer build still renders.
import type { ComponentType } from 'react';
import type { CardProps, PanelProps } from '../shell/types';
import { Card } from './Card';

export type AnyCard = ComponentType<CardProps>;
export type AnyPanel = ComponentType<PanelProps>;

export const defineCard = <P,>(c: ComponentType<CardProps<P>>): AnyCard => c as unknown as AnyCard;
export const definePanel = <P,>(c: ComponentType<PanelProps<P>>): AnyPanel => c as unknown as AnyPanel;

const cards = new Map<string, AnyCard>();
const panels = new Map<string, AnyPanel>();

export function registerCards(entries: Record<string, AnyCard>): void {
  for (const [k, v] of Object.entries(entries)) cards.set(k, v);
}
export function registerPanels(entries: Record<string, AnyPanel>): void {
  for (const [k, v] of Object.entries(entries)) panels.set(k, v);
}

export function cardFor(kind: string): AnyCard {
  return cards.get(kind) ?? Unavailable;
}
export function panelFor(kind: string): AnyPanel {
  return panels.get(kind) ?? UnavailablePanel;
}

function Unavailable({ spec }: CardProps) {
  return (
    <Card kicker={spec.kind.replace(/-/g, ' ')} title="Not available yet">
      <p className="small muted">This action is not available in this build.</p>
    </Card>
  );
}

function UnavailablePanel() {
  return <p className="small muted">This view is not available in this build.</p>;
}
