// PRD Appendix A (13 chat questions) with the expected plan for each and a check of the answer against the seeded
// read model (tests/seed.ts). Used by the query tests (INS-03) and the M7 benchmark (INS-06).
import type { Op, QueryPlan } from '../src/domain/plans/types.js';
import type { Seeded } from './seed.js';

export interface BenchmarkCase {
  id: string;
  question: string;
  /** The plan a correct planner produces (canonical values). */
  expected: QueryPlan & { exportRequested?: boolean };
  /** Checks the query rows (QueryResult.rows) against the seeded answer. */
  check: (rows: Record<string, unknown>[], seeded: Seeded, rowCount: number) => boolean;
}

const f = (field: string, op: Op, value?: unknown) =>
  value === undefined ? { field, op } : { field, op, value };

const ACTIVE = ['Upcoming', 'Available', 'Matched', 'In proposal', 'Site visit', 'In process'];

export const APPENDIX_A: BenchmarkCase[] = [
  {
    id: 'Q1',
    question: 'How many active 2BHK lease offers are there in Andheri West?',
    expected: {
      planId: 'count_offers',
      templateVersion: 1,
      filters: [f('deal_type', 'eq', 'Lease'), f('bhk', 'eq', 2), f('location', 'eq', 'Andheri West'), f('commercial_status', 'in', ACTIVE)],
    },
    check: (rows, s) => rows[0]?.['count'] === s.expected['q1'],
  },
  {
    id: 'Q2',
    question: 'Show resale 3BHK offers in Powai under ₹3 Cr that are Fresh.',
    expected: {
      planId: 'list_offers',
      templateVersion: 1,
      filters: [
        f('deal_type', 'eq', 'Sale'),
        f('market', 'eq', 'Secondary'),
        f('bhk', 'eq', 3),
        f('location', 'eq', 'Powai'),
        f('sale_price_inr', 'lte', 30_000_000),
        f('life_stage', 'eq', 'Fresh'),
      ],
    },
    check: (rows, s) => rows.length === s.expected['q2'],
  },
  {
    id: 'Q3',
    question: 'Which micromarkets have more open demand than matching supply for commercial lease (deal_type Lease, segment Commercial)?',
    expected: { planId: 'supply_demand_gap', templateVersion: 1, filters: [f('deal_type', 'eq', 'Lease'), f('segment', 'eq', 'Commercial')] },
    check: (rows, s) => rows[0]?.['micromarket'] === s.expected['q3_top'],
  },
  {
    id: 'Q4',
    question: 'What was the average closed rent for offices in Marol this quarter?',
    expected: {
      planId: 'closed_price_stats',
      templateVersion: 1,
      filters: [f('deal_type', 'eq', 'Lease'), f('property_type', 'eq', 'Office'), f('location', 'eq', 'Marol')],
      period: { preset: 'this_quarter' },
    },
    check: (rows, s) => rows[0]?.['avg_rent_monthly_inr'] === s.expected['q4_avg'],
  },
  {
    id: 'Q5',
    question: 'List my follow-ups overdue today.',
    expected: { planId: 'list_my_followups', templateVersion: 1, filters: [f('follow_up_date', 'lte', 'today')], me: true },
    check: (rows, s) => rows.length === s.expected['q5'],
  },
  {
    id: 'Q6',
    question: 'Which Public offers turned Stale this week?',
    expected: {
      planId: 'list_offers',
      templateVersion: 1,
      filters: [f('publication_level', 'eq', 'Public'), f('life_stage', 'eq', 'Stale')],
      period: { preset: 'this_week', field: 'life_stage_since' },
    },
    check: (rows, s) => rows.length === s.expected['q6'],
  },
  {
    id: 'Q7',
    question: 'Show demands in Sourcing for more than 7 days.',
    expected: {
      planId: 'list_demands',
      templateVersion: 1,
      filters: [f('commercial_status', 'eq', 'Sourcing'), f('days_in_sourcing', 'gte', 7)],
    },
    check: (rows, s) => rows.length === s.expected['q7'],
  },
  {
    id: 'Q8',
    question: 'Which source type gave us the most qualified demand last month?',
    expected: { planId: 'source_quality', templateVersion: 1, period: { preset: 'last_month', field: 'qualified_at' } },
    check: (rows, s) => rows[0]?.['source_type'] === s.expected['q8_top'],
  },
  {
    id: 'Q9',
    question: 'Give me all industrial galas for lease in Bhiwandi as an Excel file.',
    expected: {
      planId: 'list_offers',
      templateVersion: 1,
      filters: [f('deal_type', 'eq', 'Lease'), f('segment', 'eq', 'Industrial'), f('property_type', 'eq', 'Gala'), f('location', 'eq', 'Bhiwandi')],
      exportRequested: true,
    },
    check: (rows, s) => rows.length === s.expected['q9'],
  },
  {
    id: 'Q10',
    question: 'How many offers did each supply agent verify this week?',
    expected: {
      planId: 'agent_activity',
      templateVersion: 1,
      filters: [f('metric', 'eq', 'offer_verified')],
      groupBy: ['owner_user_id'],
      period: { preset: 'this_week' },
    },
    check: (rows, s) => rows.find((r) => r['owner_user_id'] === s.supplyAgentA)?.['sum_n'] === s.expected['q10_a'],
  },
  {
    id: 'Q11',
    question: 'Show bundles suggested for office demand above 5,000 sq ft.',
    expected: {
      planId: 'list_bundles',
      templateVersion: 1,
      filters: [f('status', 'eq', 'Suggested'), f('demand_property_type', 'eq', 'Office'), f('demand_area_sqft', 'gte', 5000)],
    },
    check: (rows, s) => rows.length === s.expected['q11'],
  },
  {
    id: 'Q12',
    question: 'Which Upcoming offers become available in the next 60 days?',
    expected: {
      planId: 'list_offers',
      templateVersion: 1,
      filters: [f('commercial_status', 'eq', 'Upcoming')],
      period: { preset: 'next_60_days', field: 'available_from' },
    },
    check: (rows, s) => rows.length === s.expected['q12'],
  },
  {
    id: 'Q13',
    question: 'Can you help me match the requirements for an industrial area of 4,000 sq ft?',
    expected: { planId: 'list_offers', templateVersion: 1, filters: [f('segment', 'eq', 'Industrial'), f('area_sqft', 'eq', 4000)] },
    check: (rows, s) => rows.length === s.expected['q13'],
  },
];
