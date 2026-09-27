// insight cards and panels (C-02/C-03 chat answers, C-20 + P-06 dashboards, P-07 table, exports). Registered by
// ../all.ts.
import { defineCard, definePanel } from '../registry';
import type { AnyCard, AnyPanel } from '../registry';
import AnswerCard from './AnswerCard';
import { DashboardsPanel, DashboardSummaryCard } from './Dashboards';
import ExportsCard from './ExportsCard';
import TablePanel from './TablePanel';

export const cards: Record<string, AnyCard> = {
  answer: defineCard(AnswerCard),
  'dashboard-summary': defineCard(DashboardSummaryCard),
  exports: defineCard(ExportsCard),
};
export const panels: Record<string, AnyPanel> = {
  table: definePanel(TablePanel),
  dashboards: definePanel(DashboardsPanel),
};
