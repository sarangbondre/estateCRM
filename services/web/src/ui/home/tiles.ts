// Today tiles per role (PRD §5.3, C-01), computed from the journeys queue summary (GET /v1/queues/me). Pure.
import type { operations as Journeys } from '@11e/contracts/journeys';
import type { Ok } from '../lib/contract';
import type { RoleCode } from '../shell/types';

export type MyQueue = Ok<Journeys['getMyQueue']>;
export type Section = MyQueue['sections'][number]['section'];

export interface Tile {
  label: string;
  count: number | undefined;
  /** What clicking sends to the composer ("/queue", a question, …). */
  action: string;
}

const count = (q: MyQueue | undefined, ...sections: Section[]) =>
  q ? q.sections.filter((s) => sections.includes(s.section)).reduce((n, s) => n + s.count, 0) : undefined;
const overdue = (q: MyQueue | undefined, ...sections: Section[]) =>
  q
    ? q.sections.filter((s) => sections.includes(s.section)).reduce((n, s) => n + (s.overdue ?? 0), 0)
    : undefined;

export function tilesFor(role: RoleCode, q: MyQueue | undefined): Tile[] {
  switch (role) {
    case 'Demand agent':
      return [
        { label: 'to contact', count: count(q, 'to_contact'), action: '/queue' },
        { label: 'reconfirm due', count: count(q, 'reconfirm_due'), action: '/queue' },
        { label: 'demands with matches to confirm', count: count(q, 'open_matches'), action: '/matches' },
        {
          label: 'follow-ups overdue',
          count: overdue(q, 'deals_follow_up', 'proposals_out'),
          action: '/queue',
        },
      ];
    case 'Supply agent':
      return [
        { label: 'Must call (24 h)', count: count(q, 'must_call'), action: '/queue' },
        {
          label: 'Should call today',
          count:
            q?.sections.find((s) => s.section === 'should_call')?.plannedToday ?? count(q, 'should_call'),
          action: '/queue',
        },
        { label: 'sourcing requests', count: count(q, 'sourcing_requests'), action: '/queue' },
        { label: 'Watchlist tasks', count: count(q, 'watchlist_tasks'), action: '/desks' },
      ];
    case 'Data operator':
      return [];
    default:
      return [
        { label: 'supply Must call open', count: count(q, 'must_call'), action: '/queue' },
        { label: 'demands to reconfirm', count: count(q, 'reconfirm_due'), action: '/queue' },
        { label: 'open matches', count: count(q, 'open_matches'), action: '/matches' },
        { label: 'deals to follow up', count: count(q, 'deals_follow_up'), action: '/queue' },
      ];
  }
}

export function suggestionsFor(role: RoleCode): string[] {
  switch (role) {
    case 'Demand agent':
      return ['/add demand', 'Which demands have matches to confirm?', 'Show demands in sourcing'];
    case 'Supply agent':
      return [
        '/add supply',
        'Which Public offers turned Stale this week?',
        'Show sourcing requests due this week',
      ];
    case 'Data operator':
      return ['/upload', '/review', 'How many rows are waiting for review?'];
    default:
      return ['How are we doing?', 'Which Public offers turned Stale this week?', 'Show demands in sourcing'];
  }
}
