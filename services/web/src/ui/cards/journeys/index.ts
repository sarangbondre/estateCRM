// journeys cards and panels (P-01 My queue, C-08, C-09, C-11, C-13…C-17). Registered by ../all.ts.
import { defineCard, definePanel } from '../registry';
import type { AnyCard, AnyPanel } from '../registry';
import CallOutcomeCard from './CallOutcomeCard';
import DealCard from './DealCard';
import ExitCard from './ExitCard';
import ProposalCard from './ProposalCard';
import QualifyCard from './QualifyCard';
import QueuePanel from './QueuePanel';
import RetireCard from './RetireCard';
import SiteVisitCard from './SiteVisitCard';
import SourcingCard from './SourcingCard';

export const cards: Record<string, AnyCard> = {
  'call-outcome': defineCard(CallOutcomeCard),
  qualify: defineCard(QualifyCard),
  sourcing: defineCard(SourcingCard),
  proposal: defineCard(ProposalCard),
  'site-visit': defineCard(SiteVisitCard),
  deal: defineCard(DealCard),
  exit: defineCard(ExitCard),
  retire: defineCard(RetireCard),
};

export const panels: Record<string, AnyPanel> = {
  queue: definePanel(QueuePanel),
};
