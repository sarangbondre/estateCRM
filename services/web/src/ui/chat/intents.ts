// Intent → cards / side panel (PRD §5.4 catalogue). Pure mapping; the cards themselves load live state and act only
// when a person clicks (R-CHAT-1). Role gating here only hides what the user can't do; services re-check.
import type { Intent } from '../lib/intent';
import type { CardSpec, Me, PanelSpec } from '../shell/types';

export interface IntentResult {
  text?: string;
  cards: Omit<CardSpec, 'id'>[];
  panel?: PanelSpec;
}

export interface IntentContext {
  me: Me;
  conversationId: string;
}

const card = (kind: string, props: Record<string, unknown> = {}): Omit<CardSpec, 'id'> => ({ kind, props });

/** Side panel for a record code (P-02…P-05, desk items C-21). */
export function panelForCode(code: string): PanelSpec | null {
  const prefix = code.split('-')[0];
  switch (prefix) {
    case 'INV':
      return { kind: 'offer', title: code, props: { code } };
    case 'DEM':
      return { kind: 'demand', title: code, props: { code } };
    case 'PER':
      return { kind: 'person', title: code, props: { code } };
    case 'PRJ':
      return { kind: 'project', title: code, props: { code } };
    case 'PRP':
      return { kind: 'property', title: code, props: { code } };
    case 'BIZ':
    case 'CAP':
    case 'EQP':
    case 'WCH':
      return { kind: 'desk-item', title: code, props: { code } };
    default:
      return null;
  }
}

export function resolveIntent(intent: Intent, ctx: IntentContext): IntentResult {
  switch (intent.kind) {
    case 'queue':
      return {
        text: 'Your queue is open in the side panel.',
        cards: [],
        panel: { kind: 'queue', title: 'My queue' },
      };
    case 'desks':
      return {
        text: 'Desks and Watchlist are open in the side panel.',
        cards: [],
        panel: { kind: 'desks', title: 'Desks & Watchlist' },
      };
    case 'dashboard':
      return { cards: [card('dashboard-summary')], panel: { kind: 'dashboards', title: 'Dashboards' } };
    case 'quick-add':
      return {
        cards: [card('quick-add', { side: intent.side, ...(intent.text ? { text: intent.text } : {}) })],
      };
    case 'add-supply':
      return { cards: [card('add-supply', intent.demand ? { demand: intent.demand } : {})] };
    case 'matches':
      return { cards: [card('matches', intent.demand ? { demand: intent.demand } : {})] };
    case 'upload':
      return { cards: [card('upload')] };
    case 'review':
      return { cards: [card('review')] };
    case 'exports':
      return { cards: [card('exports')] };
    case 'open': {
      const panel = panelForCode(intent.code);
      if (intent.code.startsWith('UPL-')) return { cards: [card('upload', { upload: intent.code })] };
      if (intent.code.startsWith('EXP-')) return { cards: [card('exports', { export: intent.code })] };
      if (!panel)
        return {
          cards: [card('answer', { question: `open ${intent.code}`, conversationId: ctx.conversationId })],
        };
      return { text: `${intent.code} is open in the side panel.`, cards: [], panel };
    }
    case 'publish':
      return { cards: [card('publication', { offer: intent.code })] };
    case 'qualify':
      return { cards: [card('qualify', { demand: intent.code })] };
    case 'call':
      return { cards: [card('call-outcome', { code: intent.code, note: intent.text })] };
    case 'sourcing':
      return { cards: [card('sourcing', { demand: intent.code })] };
    case 'proposal':
      return { cards: [card('proposal', { demand: intent.code })] };
    case 'visit':
      return { cards: [card('site-visit', intent.code ? { demand: intent.code } : {})] };
    case 'deal':
      return {
        cards: [card('deal', { demand: intent.demand, ...(intent.offer ? { offer: intent.offer } : {}) })],
      };
    case 'exit':
      return { cards: [card('exit', { demand: intent.code, note: intent.text })] };
    case 'retire':
      return { cards: [card('retire', { offer: intent.code })] };
    case 'ask':
      return { cards: [card('answer', { question: intent.text, conversationId: ctx.conversationId })] };
  }
}
