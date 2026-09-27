// records cards and panels (C-06 quick add, C-07 add supply, P-02…P-05 record panels + property, P-08 desks, C-21 desk
// item; PRD §5.4). Registered by ../all.ts.
import type { AnyCard, AnyPanel } from '../registry';
import { defineCard, definePanel } from '../registry';
import { QuickAddCard } from './QuickAddCard';
import { AddSupplyCard } from './AddSupplyCard';
import { OfferPanel } from './OfferPanel';
import { DemandPanel } from './DemandPanel';
import { PersonPanel } from './PersonPanel';
import { ProjectPanel } from './ProjectPanel';
import { PropertyPanel } from './PropertyPanel';
import { DesksPanel } from './DesksPanel';
import { DeskItemPanel } from './DeskItemPanel';

export const cards: Record<string, AnyCard> = {
  'quick-add': defineCard(QuickAddCard),
  'add-supply': defineCard(AddSupplyCard),
};

export const panels: Record<string, AnyPanel> = {
  offer: definePanel(OfferPanel),
  demand: definePanel(DemandPanel),
  person: definePanel(PersonPanel),
  project: definePanel(ProjectPanel),
  property: definePanel(PropertyPanel),
  desks: definePanel(DesksPanel),
  'desk-item': definePanel(DeskItemPanel),
};
