// listings cards (C-12 publication). Registered by ../all.ts.
import { defineCard } from '../registry';
import type { AnyCard, AnyPanel } from '../registry';
import PublicationCard from './PublicationCard';

export const cards: Record<string, AnyCard> = {
  publication: defineCard(PublicationCard),
};
export const panels: Record<string, AnyPanel> = {};
