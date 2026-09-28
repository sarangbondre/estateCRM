// Pure rules behind My queue (P-01) and the journeys cards C-08, C-09, C-11, C-13…C-17 (PRD §4.1–4.4, §5.4;
// docs/04-lld/journeys.md §4). No React, no I/O: section/team/label/action mapping, call-outcome payloads and the
// next-call date rules, qualification, sourcing, proposal, site-visit, deal, exit and retire request building.
import type { components, operations } from '@11e/contracts/journeys';
import type { Body } from '../../lib/contract';
import { date, relative } from '../../lib/format';

type J = components['schemas'];
export type QueueItem = J['QueueItem'];
export type QueueSection = QueueItem['section'];
export type QueueReason = QueueItem['reason'];
export type QueueSectionSummary = J['QueueSectionSummary'];
export type Team = 'supply' | 'demand';
export type Role = 'Admin' | 'Manager' | 'Demand agent' | 'Supply agent' | 'Data operator';
export type Tone = 'plain' | 'good' | 'warn' | 'bad';

// ---------------------------------------------------------------------------------------------------------------
// Roles (x-roles of each operation; services re-check)

export const ROLES = {
  queueOfOthers: ['Admin', 'Manager'],
  reassign: ['Admin', 'Manager'],
  logCall: ['Admin', 'Manager', 'Demand agent', 'Supply agent'],
  patchOffer: ['Admin', 'Manager', 'Supply agent', 'Demand agent'],
  qualify: ['Admin', 'Manager', 'Demand agent'],
  exit: ['Admin', 'Manager', 'Demand agent'],
  sourcing: ['Admin', 'Manager', 'Demand agent'],
  demandPost: ['Admin', 'Manager', 'Demand agent'],
  proposal: ['Admin', 'Manager', 'Demand agent'],
  siteVisit: ['Admin', 'Manager', 'Demand agent', 'Supply agent'],
  openDeal: ['Admin', 'Manager', 'Demand agent'],
  updateDeal: ['Admin', 'Manager', 'Demand agent'],
  dealFollowUp: ['Admin', 'Manager', 'Demand agent', 'Supply agent'],
  cancelDeal: ['Admin', 'Manager', 'Demand agent'],
  retire: ['Admin', 'Manager', 'Supply agent'],
} as const satisfies Record<string, readonly Role[]>;

export const allowed = (role: string | null | undefined, roles: readonly string[]): boolean =>
  !!role && roles.includes(role);

// ---------------------------------------------------------------------------------------------------------------
// Dates (IST calendar days; contract dates are YYYY-MM-DD)

/** Today's calendar date in India. */
export function todayIst(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Next working day after `day` (Monday–Saturday; Sunday is skipped). */
export function nextWorkingDay(day: string): string {
  let next = addDays(day, 1);
  if (new Date(`${next}T00:00:00Z`).getUTCDay() === 0) next = addDays(next, 1);
  return next;
}

const isDate = (v: string | null | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A `datetime-local` value ("2026-10-01T15:30") read as India time → ISO 8601 with offset. */
export function istDateTimeToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(local);
  return m ? `${m[1]}T${m[2]}:${m[3]}:00+05:30` : null;
}

/** Parses a money / number field ("" → null, "8,50,000" → 850000). */
export function amount(v: string): number | null {
  const s = v.replace(/[,\s₹]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

// ---------------------------------------------------------------------------------------------------------------
// My queue (P-01): sections, teams, labels, actions

interface SectionMeta {
  label: string;
  team: Team;
  order: number;
}

export const SECTIONS: Record<QueueSection, SectionMeta> = {
  must_call: { label: 'Must call', team: 'supply', order: 1 },
  should_call: { label: 'Should call (planned today)', team: 'supply', order: 2 },
  sourcing_requests: { label: 'Sourcing requests', team: 'supply', order: 3 },
  watchlist_tasks: { label: 'Watchlist tasks', team: 'supply', order: 4 },
  to_contact: { label: 'To contact', team: 'demand', order: 10 },
  to_qualify: { label: 'To qualify', team: 'demand', order: 11 },
  reconfirm_due: { label: 'Reconfirm due', team: 'demand', order: 12 },
  needs_sourcing: { label: 'Needs sourcing', team: 'demand', order: 13 },
  in_sourcing: { label: 'In sourcing', team: 'demand', order: 14 },
  sourcing_requests_open: { label: 'Sourcing requests open', team: 'demand', order: 15 },
  open_matches: { label: 'Open matches to confirm', team: 'demand', order: 16 },
  proposals_out: { label: 'Proposals out (awaiting feedback)', team: 'demand', order: 17 },
  site_visits_this_week: { label: 'Site visits this week', team: 'demand', order: 18 },
  deals_follow_up: { label: 'In process: follow-up due', team: 'demand', order: 19 },
  dormant_revisits: { label: 'Dormant revisits due', team: 'demand', order: 20 },
};

const humanise = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' ');

/** Label, team and order of a section; unknown sections (newer contract) still render. */
export function sectionMeta(section: string, team?: string): SectionMeta {
  const known = SECTIONS[section as QueueSection] as SectionMeta | undefined;
  if (known) return known;
  return { label: humanise(section), team: team === 'supply' ? 'supply' : 'demand', order: 99 };
}

export const TEAM_LABEL: Record<Team, string> = { supply: 'Supply calls', demand: 'Demand' };

/** Summary sections grouped by team (supply first), each team's sections in PRD order. */
export function groupSections(sections: readonly QueueSectionSummary[]): { team: Team; sections: QueueSectionSummary[] }[] {
  const out: { team: Team; sections: QueueSectionSummary[] }[] = [];
  for (const team of ['supply', 'demand'] as const) {
    const s = sections
      .filter((x) => sectionMeta(x.section, x.team).team === team)
      .sort((a, b) => sectionMeta(a.section).order - sectionMeta(b.section).order);
    if (s.length) out.push({ team, sections: s });
  }
  return out;
}

/** Header chip tone: red when something is overdue, amber when there is work, plain otherwise. */
export function sectionTone(s: Pick<QueueSectionSummary, 'count' | 'overdue'>): Tone {
  if ((s.overdue ?? 0) > 0) return 'bad';
  return s.count > 0 ? 'warn' : 'plain';
}

export const REASON_LABEL: Record<QueueReason, string> = {
  enquiry: 'Enquiry',
  match: 'New match',
  sourced_for: 'Sourced for a demand',
  new_capture: 'New capture',
  reconfirm: 'Reconfirm',
  stale_public: 'Stale Public listing',
  request_price_sheet: 'Request price sheet',
  srq: 'Sourcing request',
  watchlist: 'Watchlist task',
  first_contact: 'First contact',
  qualify: 'Qualify',
  open_matches: 'Matches to confirm',
  no_matches: 'No matches: source supply',
  proposal_feedback: 'Proposal feedback',
  visit: 'Site visit',
  follow_up: 'Deal follow-up',
  revisit: 'Dormant revisit',
  unreachable: 'Unreachable after 3 attempts',
};

export const reasonLabel = (r: string): string => REASON_LABEL[r as QueueReason] ?? humanise(r);

export type ActionKind =
  | 'call-outcome'
  | 'qualify'
  | 'matches'
  | 'sourcing'
  | 'add-supply'
  | 'proposal'
  | 'site-visit'
  | 'deal';

export interface ItemAction {
  kind: ActionKind;
  label: string;
  props: Record<string, string>;
}

/** Reasons whose next step is a call (C-08). */
const CALL_REASONS = new Set<string>([
  'enquiry',
  'match',
  'sourced_for',
  'new_capture',
  'reconfirm',
  'stale_public',
  'request_price_sheet',
  'first_contact',
  'unreachable',
  'revisit',
]);

/** Reason → action for demand-linked work; used also as the fallback per section. */
const REASON_ACTION: Partial<Record<string, { kind: ActionKind; label: string }>> = {
  qualify: { kind: 'qualify', label: 'Qualify' },
  open_matches: { kind: 'matches', label: 'Matches' },
  no_matches: { kind: 'sourcing', label: 'Source supply' },
  proposal_feedback: { kind: 'proposal', label: 'Feedback' },
  visit: { kind: 'site-visit', label: 'Visit outcome' },
  follow_up: { kind: 'deal', label: 'Follow up' },
};

const SECTION_FALLBACK: Partial<Record<string, string>> = {
  to_qualify: 'qualify',
  open_matches: 'open_matches',
  in_sourcing: 'open_matches',
  needs_sourcing: 'no_matches',
  proposals_out: 'proposal_feedback',
  site_visits_this_week: 'visit',
  deals_follow_up: 'follow_up',
};

/** The demand a queue item is about (code for demand items, else the linked demand id), if any. */
export function demandRef(item: Pick<QueueItem, 'subjectType' | 'subjectCode' | 'demandId'>): string | null {
  if (item.subjectType === 'demand') return item.subjectCode || item.demandId || null;
  return item.demandId ?? null;
}

/** The action button of a queue item (P-01 → C-07…C-15), or null when the item only opens its record. */
export function actionFor(
  item: Pick<QueueItem, 'section' | 'reason' | 'subjectType' | 'subjectCode' | 'demandId'>,
): ItemAction | null {
  const isCallSubject = item.subjectType === 'offer' || item.subjectType === 'demand';
  if (CALL_REASONS.has(item.reason) && isCallSubject && /^(INV|DEM)-/i.test(item.subjectCode)) {
    return { kind: 'call-outcome', label: 'Log call', props: { code: item.subjectCode } };
  }
  if (item.reason === 'srq') {
    return item.demandId ? { kind: 'add-supply', label: 'Add supply', props: { demand: item.demandId } } : null;
  }
  const byReason = REASON_ACTION[item.reason] ?? REASON_ACTION[SECTION_FALLBACK[item.section] ?? ''];
  if (!byReason) return null;
  const demand = demandRef(item);
  return demand ? { ...byReason, props: { demand } } : null;
}

/** The due / overdue chip of a queue item. */
export function dueChip(
  item: Pick<QueueItem, 'overdue' | 'dueAt' | 'nextCallDate'>,
  now: number = Date.now(),
): { tone: Tone; text: string } | null {
  if (item.overdue) return { tone: 'bad', text: item.dueAt ? `overdue · due ${relative(item.dueAt, now)}` : 'overdue' };
  if (item.dueAt) {
    const soon = Date.parse(item.dueAt) - now < 86_400_000;
    return { tone: soon ? 'warn' : 'plain', text: `due ${relative(item.dueAt, now)}` };
  }
  if (item.nextCallDate) return { tone: 'plain', text: `next call ${date(item.nextCallDate)}` };
  return null;
}

/** Bulk reassign body (≤ 100 items, C-19). */
export function buildReassign(
  queueItemIds: readonly string[],
  assigneeUserId: string | null,
): { body: Body<operations['reassignQueueItems']> } | { errors: string[] } {
  const ids = [...new Set(queueItemIds)];
  const errors: string[] = [];
  if (!ids.length) errors.push('Select at least one item.');
  if (ids.length > 100) errors.push('Reassign at most 100 items at a time.');
  if (!assigneeUserId) errors.push('Choose who gets the items.');
  return errors.length ? { errors } : { body: { queueItemIds: ids, assigneeUserId: assigneeUserId as string } };
}

// ---------------------------------------------------------------------------------------------------------------
// C-08 Call outcome

export type CallOutcome = J['CallCreate']['outcome'];
export type CallSubject = 'offer' | 'demand';

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  confirmed: 'Confirmed',
  no_answer: 'No answer',
  already_gone: 'Already gone',
  unwilling: 'Unwilling',
};

/** Offers take all four outcomes; demands only Confirmed / No answer (400 outcome-not-allowed otherwise: use exit). */
export function outcomesFor(subject: CallSubject): CallOutcome[] {
  return subject === 'offer' ? ['confirmed', 'no_answer', 'already_gone', 'unwilling'] : ['confirmed', 'no_answer'];
}

export function subjectOfCode(code: string): CallSubject | null {
  if (/^INV-/i.test(code)) return 'offer';
  if (/^DEM-/i.test(code)) return 'demand';
  return null;
}

/** Which outcomes allow a next call date: retiring outcomes close the offer, so no next call. */
export const takesNextCallDate = (o: CallOutcome): boolean => o === 'confirmed' || o === 'no_answer';

/**
 * Prefill for the next call date: No answer is rescheduled to the next working day (journeys does the same when the
 * date is left empty); Confirmed has none (the life curve decides the next reconfirm).
 */
export function defaultNextCallDate(outcome: CallOutcome, today: string): string | null {
  return outcome === 'no_answer' ? nextWorkingDay(today) : null;
}

/** What each outcome does (shown on the card before saving). */
export function outcomeEffect(outcome: CallOutcome, subject: CallSubject, attempts = 0): string {
  switch (outcome) {
    case 'confirmed':
      return subject === 'offer'
        ? 'The life curve resets to day 0 and the item leaves your queue. An Inactive offer is reactivated.'
        : 'The life curve resets to day 0. A New demand moves to Contacted (then To qualify); a Dormant demand is reactivated.';
    case 'no_answer':
      return `Attempt ${Math.min(attempts + 1, 3)} of 3. The item is rescheduled; the 3rd no answer in a row marks the person unreachable.`;
    case 'already_gone':
      return 'The offer becomes Inactive and is unpublished; a known price is kept as market data. Matched demands are notified.';
    case 'unwilling':
      return 'The offer becomes Inactive: kept for matching intelligence and never published.';
  }
}

export interface CallInput {
  subjectType: CallSubject;
  subjectId: string;
  queueItemId?: string | null;
  outcome: CallOutcome;
  channel?: 'call' | 'meeting';
  nextCallDate?: string | null;
  notes?: string | null;
  availableNow?: boolean | null;
  knownPriceInr?: number | null;
}

/**
 * POST /v1/calls body (logCall). Rules: the outcome must fit the subject; a next call date only for Confirmed (today or
 * later) and No answer (after today; empty = next working day, set by journeys); `availableNow` only on a Confirmed
 * offer; `knownPriceInr` only when an offer is Already gone (price → market data).
 */
export function buildCallBody(
  input: CallInput,
  today: string,
): { body: Body<operations['logCall']> } | { errors: string[] } {
  const errors: string[] = [];
  if (!outcomesFor(input.subjectType).includes(input.outcome))
    errors.push(`${OUTCOME_LABEL[input.outcome]} is not an outcome for a ${input.subjectType}; use Exit instead.`);
  const next = takesNextCallDate(input.outcome) ? text(input.nextCallDate) : null;
  if (next !== null) {
    if (!isDate(next)) errors.push('Next call date is not a date.');
    else if (input.outcome === 'no_answer' && next <= today) errors.push('Reschedule the next call to a later day.');
    else if (next < today) errors.push('Next call date is in the past.');
  }
  const notes = text(input.notes);
  if (notes && notes.length > 2000) errors.push('Notes are limited to 2,000 characters.');
  if (errors.length) return { errors };
  return {
    body: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      channel: input.channel ?? 'call',
      ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
      ...(next ? { nextCallDate: next } : {}),
      ...(notes ? { notes } : {}),
      ...(input.subjectType === 'offer' && input.outcome === 'confirmed' && input.availableNow
        ? { availableNow: true }
        : {}),
      ...(input.subjectType === 'offer' && input.outcome === 'already_gone' && input.knownPriceInr != null
        ? { knownPriceInr: input.knownPriceInr }
        : {}),
    },
  };
}

/** The price field an offer uses for its deal type (Lease → monthly rent, otherwise sale price). */
export const priceFieldFor = (dealType: string | null | undefined): 'rentMonthlyInrMin' | 'salePriceInrMin' =>
  /lease|rent/i.test(dealType ?? '') ? 'rentMonthlyInrMin' : 'salePriceInrMin';

const norm = (v: unknown) => (v === undefined || v === '' ? null : v);

/** JSON Merge Patch with only the fields that changed (the card shows and sends nothing else). */
export function changedOnly<T extends Record<string, unknown>>(original: Partial<T>, edited: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(edited) as (keyof T)[]) {
    const next = norm(edited[key]);
    if (next !== norm(original[key])) out[key] = next as T[keyof T];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// C-09 Qualify

export type Checklist = J['Qualification'];
export const CHECKLIST: { key: Exclude<keyof Checklist, 'decisionMakerNote'>; label: string }[] = [
  { key: 'decisionMakerReached', label: 'Decision maker reached' },
  { key: 'budgetConfirmed', label: 'Budget confirmed' },
  { key: 'timingConfirmed', label: 'Timing confirmed' },
  { key: 'agreesToWork', label: 'Agrees to work with 11 Estates' },
];

export const canQualify = (c: Checklist): boolean => CHECKLIST.every(({ key }) => c[key] === true);

export function buildQualify(c: Checklist, notes?: string | null): Body<operations['qualifyDemand']> | null {
  if (!canQualify(c)) return null;
  const note = text(c.decisionMakerNote);
  const n = text(notes);
  return {
    checklist: {
      decisionMakerReached: true,
      budgetConfirmed: true,
      timingConfirmed: true,
      agreesToWork: true,
      ...(note ? { decisionMakerNote: note.slice(0, 200) } : {}),
    },
    ...(n ? { notes: n } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// C-11 Sourcing request

export const PRIORITIES = ['High', 'Normal', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export function buildSourcing(
  input: {
    demandId: string;
    assigneeUserId: string | null;
    dueDate: string | null;
    priority: string | null;
    postAnonymously: boolean;
    notes?: string | null;
  },
  today: string,
): { body: Body<operations['createSourcingRequest']> } | { errors: string[] } {
  const errors: string[] = [];
  if (!input.assigneeUserId) errors.push('Choose a supply agent.');
  if (!isDate(input.dueDate)) errors.push('Set a due date.');
  else if (input.dueDate < today) errors.push('The due date is in the past.');
  if (!PRIORITIES.includes(input.priority as Priority)) errors.push('Choose a priority.');
  if (errors.length) return { errors };
  const notes = text(input.notes);
  return {
    body: {
      demandId: input.demandId,
      assigneeUserId: input.assigneeUserId as string,
      dueDate: input.dueDate as string,
      priority: input.priority as Priority,
      postAnonymously: input.postAnonymously,
      ...(notes ? { notes } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// C-13 Proposal

export function buildProposal(
  demandId: string,
  matchIds: readonly string[],
  coverNote?: string | null,
): { body: Body<operations['createProposal']> } | { errors: string[] } {
  const ids = [...new Set(matchIds)];
  if (!ids.length) return { errors: ['Pick at least one confirmed match.'] };
  if (ids.length > 20) return { errors: ['A proposal holds at most 20 options.'] };
  const note = text(coverNote);
  return {
    body: {
      demandId,
      options: ids.map((matchId, i) => ({ matchId, position: i + 1 })),
      ...(note ? { coverNote: note } : {}),
    },
  };
}

export const SENT_CHANNELS = ['WhatsApp', 'Email', 'In person', 'Other'] as const;

/** Client verdicts on an option. "maybe" is shown (questionnaire C3) but journeys cannot record it yet (LLD G-13). */
export const FEEDBACK = [
  { value: 'liked', label: 'Liked' },
  { value: 'maybe', label: 'Maybe (not recorded yet)' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'visit_requested', label: 'Wants a site visit' },
] as const;
export type FeedbackChoice = (typeof FEEDBACK)[number]['value'];

export function buildFeedback(
  entries: readonly { position: number; feedback: FeedbackChoice | null; note?: string | null }[],
): { body: Body<operations['recordProposalFeedback']>; skipped: number[] } | { errors: string[] } {
  const recordable = entries.filter((e) => e.feedback && e.feedback !== 'maybe');
  const skipped = entries.filter((e) => e.feedback === 'maybe').map((e) => e.position);
  if (!recordable.length)
    return { errors: ['Give Liked, Rejected or Wants a site visit for at least one option ("Maybe" is not recorded yet).'] };
  return {
    body: {
      options: recordable.map((e) => {
        const note = text(e.note);
        return {
          position: e.position,
          feedback: e.feedback as 'liked' | 'rejected' | 'visit_requested',
          ...(note ? { note: note.slice(0, 500) } : {}),
        };
      }),
    },
    skipped,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// C-14 Site visit

export const VISIT_OUTCOMES = ['Interested', 'Shortlisted', 'Not interested', 'Client no-show', 'Owner no-show'] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

export function buildVisit(input: {
  demandId: string;
  offerIds: readonly string[];
  scheduledLocal: string;
  attendeeUserIds: readonly string[];
  notes?: string | null;
}): { body: Body<operations['scheduleSiteVisit']> } | { errors: string[] } {
  const errors: string[] = [];
  const offers = [...new Set(input.offerIds)];
  const attendees = [...new Set(input.attendeeUserIds)];
  const at = istDateTimeToIso(input.scheduledLocal);
  if (!offers.length) errors.push('Pick at least one offer.');
  if (offers.length > 10) errors.push('A visit covers at most 10 offers.');
  if (attendees.length > 10) errors.push('At most 10 attendees.');
  if (!at) errors.push('Set the date and time.');
  if (errors.length) return { errors };
  const notes = text(input.notes);
  return {
    body: {
      demandId: input.demandId,
      offerIds: offers,
      scheduledAt: at as string,
      ...(attendees.length ? { attendeeUserIds: attendees } : {}),
      ...(notes ? { notes } : {}),
    },
  };
}

/** Which life curves the outcome resets (US-24; no-shows spare the side that did not show). */
export function visitResetNote(outcome: VisitOutcome | null): string {
  if (outcome === 'Client no-show') return "The offers' life curves reset; the demand's does not (client no-show).";
  if (outcome === 'Owner no-show') return "The demand's life curve resets; the offers' do not (owner no-show).";
  return 'Recording the outcome resets both life curves: the demand and every visited offer.';
}

// ---------------------------------------------------------------------------------------------------------------
// C-15 Deal

export const DEAL_STAGES = ['Negotiation', 'Documentation', 'Stamp duty & registration', 'Closed'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** Stages a deal can move to: forward only (the current one included, to change terms without moving). */
export function stagesFrom(current: string): DealStage[] {
  const i = DEAL_STAGES.indexOf(current as DealStage);
  return i < 0 ? [] : DEAL_STAGES.slice(i);
}

/** Next action + follow-up date are required on every open-deal change (PRD C-15, US-25). */
export function followUpErrors(nextAction: string | null | undefined, followUpDate: string | null | undefined, today: string) {
  const errors: string[] = [];
  const action = text(nextAction);
  if (!action) errors.push('Next action is required.');
  else if (action.length > 300) errors.push('Next action is limited to 300 characters.');
  if (!isDate(followUpDate)) errors.push('Follow-up date is required.');
  else if (followUpDate < today) errors.push('The follow-up date cannot be in the past.');
  return errors;
}

export interface TermsInput {
  priceInr?: string;
  rentMonthlyInr?: string;
  depositInr?: string;
  leaseMonths?: string;
  lockInMonths?: string;
  rentFreeMonths?: string;
  otherTerms?: string;
}
type AgreedTerms = J['AgreedTerms'];

export function buildTerms(t: TermsInput): AgreedTerms {
  const out: AgreedTerms = {};
  const money = (k: 'priceInr' | 'rentMonthlyInr' | 'depositInr') => {
    const v = amount(t[k] ?? '');
    if (v !== null) out[k] = v;
  };
  money('priceInr');
  money('rentMonthlyInr');
  money('depositInr');
  const lease = amount(t.leaseMonths ?? '');
  if (lease !== null && lease >= 1) out.leaseMonths = lease;
  const lock = amount(t.lockInMonths ?? '');
  if (lock !== null) out.lockInMonths = lock;
  const free = Number((t.rentFreeMonths ?? '').trim());
  if ((t.rentFreeMonths ?? '').trim() !== '' && Number.isFinite(free) && free >= 0) out.rentFreeMonths = free;
  const other = text(t.otherTerms);
  if (other) out.otherTerms = other.slice(0, 1000);
  return out;
}

export function buildDealCreate(
  input: { demandId: string; offerId: string | null; matchId?: string | null; terms: TermsInput; nextAction: string; followUpDate: string },
  today: string,
): { body: Body<operations['openDeal']> } | { errors: string[] } {
  const errors = followUpErrors(input.nextAction, input.followUpDate, today);
  if (!input.offerId) errors.unshift('Choose the offer.');
  if (errors.length) return { errors };
  const terms = buildTerms(input.terms);
  return {
    body: {
      demandId: input.demandId,
      offerId: input.offerId as string,
      ...(input.matchId ? { matchId: input.matchId } : {}),
      ...(Object.keys(terms).length ? { agreedTerms: terms } : {}),
      nextAction: (text(input.nextAction) ?? '').slice(0, 300),
      followUpDate: input.followUpDate,
    },
  };
}

export function buildDealPatch(
  input: {
    currentStage: string;
    stage: string;
    nextAction: string;
    followUpDate: string;
    closingPriceInr?: string;
    isLease?: boolean;
    terms: TermsInput;
  },
  today: string,
): { body: Body<operations['updateDeal']> } | { errors: string[] } {
  const errors: string[] = [];
  if (!stagesFrom(input.currentStage).includes(input.stage as DealStage))
    errors.push(`A deal moves forward only; it cannot go from ${input.currentStage} to ${input.stage}.`);
  const closing = input.stage === 'Closed';
  const terms = buildTerms(input.terms);
  const price = amount(input.closingPriceInr ?? '');
  if (closing && price === null) errors.push('Closing price is required to close the deal.');
  if (closing && input.isLease && !terms.leaseMonths) errors.push('Lease months are required to close a lease.');
  const hasFollowUp = !!text(input.nextAction) || !!text(input.followUpDate);
  if (!closing || hasFollowUp) errors.push(...followUpErrors(input.nextAction, input.followUpDate, today));
  if (errors.length) return { errors };
  return {
    body: {
      ...(input.stage !== input.currentStage ? { stage: input.stage as DealStage } : {}),
      ...(Object.keys(terms).length ? { agreedTerms: terms } : {}),
      ...(text(input.nextAction) ? { nextAction: (text(input.nextAction) ?? '').slice(0, 300) } : {}),
      ...(isDate(input.followUpDate) ? { followUpDate: input.followUpDate } : {}),
      ...(closing && price !== null ? { closingPriceInr: price } : {}),
    },
  };
}

export const CANCEL_REASONS = [
  { value: 'token_refunded', label: 'Token refunded' },
  { value: 'loan_rejected', label: 'Loan rejected' },
  { value: 'landlord_withdrew', label: 'Landlord / seller withdrew' },
  { value: 'client_withdrew', label: 'Client withdrew' },
  { value: 'documentation_failed', label: 'Documentation failed' },
  { value: 'other', label: 'Other' },
] as const;

// ---------------------------------------------------------------------------------------------------------------
// C-16 Exit

export type ExitType = 'Lost' | 'Dormant' | 'Invalid';
type ExitReason = NonNullable<J['ExitRequest']['reasonCode']>;

export const EXIT_REASONS: Record<ExitType, { value: ExitReason; label: string }[]> = {
  Lost: [
    { value: 'closed_elsewhere', label: 'Closed elsewhere' },
    { value: 'withdrew', label: 'Client withdrew' },
    { value: 'other', label: 'Other' },
  ],
  Dormant: [
    { value: 'postponed', label: 'Postponed' },
    { value: 'life_curve_expired', label: 'Life curve expired' },
    { value: 'other', label: 'Other' },
  ],
  Invalid: [
    { value: 'unreachable', label: 'Unreachable after 3 attempts' },
    { value: 'broker_posing', label: 'Broker posing as a client' },
    { value: 'is_broker', label: 'Is a broker' },
    { value: 'fake_details', label: 'Fake details' },
    { value: 'other', label: 'Other' },
  ],
};

/** Dormant revisit default: today + 60 days (A-41). */
export const defaultRevisit = (today: string): string => addDays(today, 60);

/** Exit type suggested by the typed text ("client postponed…", "mark lost", "invalid…"). */
export function exitTypeFromText(note: string | null | undefined): ExitType | null {
  const t = (note ?? '').toLowerCase();
  if (/\b(invalid|fake|broker posing|is a broker|unreachable)\b/.test(t)) return 'Invalid';
  if (/\b(lost|signed elsewhere|closed elsewhere|went with|withdrew)\b/.test(t)) return 'Lost';
  if (/\b(postpone[sd]?|dormant|later|revisit|on hold|next (month|quarter|year))\b/.test(t)) return 'Dormant';
  return null;
}

export interface ExitInput {
  type: ExitType;
  reasonCode: string | null;
  reason?: string | null;
  competingTerms?: string | null;
  competingPrice?: string | null;
  revisitDate?: string | null;
  flagPerson?: boolean;
  personId?: string | null;
}

/**
 * POST /v1/demands/{id}/exit body. Lost: reason code required, competing terms/price optional (market data).
 * Dormant: revisit date after today (default +60). Invalid: reason code required; flagging needs the linked person.
 */
export function buildExit(input: ExitInput, today: string): { body: Body<operations['exitDemand']> } | { errors: string[] } {
  const errors: string[] = [];
  const codes = EXIT_REASONS[input.type].map((r) => r.value as string);
  if (input.reasonCode && !codes.includes(input.reasonCode)) errors.push('That reason does not fit this exit.');
  if ((input.type === 'Lost' || input.type === 'Invalid') && !input.reasonCode) errors.push('Choose a reason.');
  const revisit = input.type === 'Dormant' ? (text(input.revisitDate) ?? defaultRevisit(today)) : null;
  if (revisit !== null && (!isDate(revisit) || revisit <= today)) errors.push('The revisit date must be after today.');
  const flag = input.type === 'Invalid' && !!input.flagPerson;
  if (flag && !input.personId) errors.push('No person is linked to this demand, so it cannot be flagged.');
  const reason = text(input.reason);
  if (reason && reason.length > 500) errors.push('Reason is limited to 500 characters.');
  if (errors.length) return { errors };
  const terms = input.type === 'Lost' ? text(input.competingTerms) : null;
  const price = input.type === 'Lost' ? amount(input.competingPrice ?? '') : null;
  // flagPerson has a contract default (false) and is required in the generated type: always sent.
  const body: Body<operations['exitDemand']> = { type: input.type, flagPerson: flag };
  if (input.reasonCode) body.reasonCode = input.reasonCode as ExitReason;
  if (reason) body.reason = reason;
  if (terms) body.competingTerms = terms.slice(0, 500);
  if (price !== null) body.competingPriceInr = price;
  if (revisit) body.revisitDate = revisit;
  if (flag && input.personId) body.personId = input.personId;
  return { body };
}

/** Dormant: the demand's owner team can reactivate; Lost / Invalid is a Manager override (PRD §2.1). */
export function canReactivate(exitType: string | null | undefined, role: string | null | undefined): boolean {
  if (!exitType) return false;
  return exitType === 'Dormant' ? allowed(role, ROLES.exit) : allowed(role, ['Admin', 'Manager']);
}

export function exitEffect(type: ExitType): string {
  switch (type) {
    case 'Lost':
      return 'Competing terms are kept as market data. Matches are released and the offer owners notified.';
    case 'Dormant':
      return 'The life curve pauses until the revisit date and matches are released. On that date the demand returns to your queue.';
    case 'Invalid':
      return 'The demand drops out of every queue; a flagged person marks future records from them.';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// C-17 Close / retire offer

export const RETIRE_REASONS = [
  { value: 'already_gone', label: 'Already gone' },
  { value: 'unwilling', label: 'Owner unwilling' },
  { value: 'other', label: 'Other' },
] as const;
type RetireReason = (typeof RETIRE_REASONS)[number]['value'];

export function buildRetire(input: {
  reason: string | null;
  knownPrice?: string | null;
  note?: string | null;
}): { body: Body<operations['retireOffer']> } | { errors: string[] } {
  if (!RETIRE_REASONS.some((r) => r.value === input.reason)) return { errors: ['Choose why the offer is retired.'] };
  const price = amount(input.knownPrice ?? '');
  const note = text(input.note);
  return {
    body: {
      reason: input.reason as RetireReason,
      ...(price !== null ? { knownPriceInr: price } : {}),
      ...(note ? { note: note.slice(0, 1000) } : {}),
    },
  };
}

/** Offers in a terminal Commercial status cannot be retired (409 invalid-transition). */
export const canRetireStatus = (status: string | null | undefined): boolean =>
  !!status && status !== 'Closed' && status !== 'Inactive';
