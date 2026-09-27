// crm-engine cards (C-10 matches and bundles). Registered by ../all.ts.
import { defineCard } from '../registry';
import type { AnyCard, AnyPanel } from '../registry';
import MatchesCard from './MatchesCard';

export const cards: Record<string, AnyCard> = {
  matches: defineCard(MatchesCard),
};
export const panels: Record<string, AnyPanel> = {};
