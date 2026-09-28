// Call outcomes and the 3-attempt rule (C-08, US-12 AC3, A-37; LLD §4.4).
import { addDays } from './dates.js';
import type { IsoDate } from './dates.js';
import type { SubjectType } from './lifecurve.js';

export const CALL_OUTCOMES = ['confirmed', 'no_answer', 'already_gone', 'unwilling'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** Demands only take confirmed / no_answer; already_gone and unwilling go through the exit (400 outcome-not-allowed). */
export function outcomeAllowed(subject: SubjectType, outcome: CallOutcome): boolean {
  return subject === 'offer' || outcome === 'confirmed' || outcome === 'no_answer';
}

export interface AttemptState {
  /** consecutive unanswered calls on the queue item */
  itemAttempts: number;
  /** consecutive unanswered calls to the person (person_state), null when no person was named */
  personConsecutive: number | null;
}

export interface AttemptResult {
  itemAttempts: number;
  personConsecutive: number | null;
  /** attempt number recorded on the call (1-based) */
  attemptNo: number;
  /** 3rd consecutive no-answer → unreachable */
  unreachable: boolean;
}

/** "Consecutive" is counted per queue item and per person; any answered call resets both (LLD §4.4). */
export function applyOutcome(state: AttemptState, outcome: CallOutcome, maxAttempts: number): AttemptResult {
  if (outcome !== 'no_answer') {
    return {
      itemAttempts: 0,
      personConsecutive: state.personConsecutive === null ? null : 0,
      attemptNo: state.itemAttempts + 1,
      unreachable: false,
    };
  }
  const itemAttempts = state.itemAttempts + 1;
  const personConsecutive = state.personConsecutive === null ? null : state.personConsecutive + 1;
  const worst = Math.max(itemAttempts, personConsecutive ?? 0);
  return { itemAttempts, personConsecutive, attemptNo: itemAttempts, unreachable: worst >= maxAttempts };
}

/** No answer: the given date, else the next working day (Sundays skipped). */
export function rescheduleDate(given: IsoDate | null | undefined, today: IsoDate): IsoDate {
  if (given && given > today) return given;
  let next = addDays(today, 1);
  if (new Date(`${next}T00:00:00Z`).getUTCDay() === 0) next = addDays(next, 1);
  return next;
}
