// Deals (C-15, US-25, US-27, US-16; LLD §4.7): forward-only stage machine, mandatory follow-ups, lease renewals.
import { addMonths } from './dates.js';
import type { IsoDate } from './dates.js';

export const DEAL_STAGES = [
  'Negotiation',
  'Documentation',
  'Stamp duty & registration',
  'Closed',
  'Cancelled',
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
const FORWARD: readonly DealStage[] = ['Negotiation', 'Documentation', 'Stamp duty & registration', 'Closed'];

export const isOpenStage = (s: DealStage) => s !== 'Closed' && s !== 'Cancelled';

/** Forward only; skipping forward allowed; staying is a no-op (LLD §4.7). */
export function canMoveStage(from: DealStage, to: DealStage): boolean {
  if (!isOpenStage(from)) return false;
  const a = FORWARD.indexOf(from);
  const b = FORWARD.indexOf(to);
  return b >= 0 && b >= a;
}

/** nextAction + followUpDate ≥ today are required on every change while the deal is open (R13). */
export function followUpValid(nextAction: string | null | undefined, followUpDate: IsoDate | null | undefined, today: IsoDate) {
  return !!nextAction && nextAction.trim().length > 0 && !!followUpDate && followUpDate >= today;
}

export const isOverdue = (followUpDate: IsoDate | null, today: IsoDate) => !!followUpDate && followUpDate < today;

export interface LeaseRenewalPlan {
  leaseStartDate: IsoDate;
  leaseMonths: number;
  dueOn: IsoDate;
  availableFrom: IsoDate;
}

/**
 * 11-month leases: due at month 10, available from month 11 (US-16). Start = agreedTerms.leaseStartDate ?? close date.
 */
export function leaseRenewalPlan(
  dealType: string,
  leaseMonths: number | null | undefined,
  leaseStartDate: IsoDate | null | undefined,
  closedOn: IsoDate,
): LeaseRenewalPlan | null {
  if (dealType !== 'Lease' || leaseMonths !== 11) return null;
  const start = leaseStartDate ?? closedOn;
  return { leaseStartDate: start, leaseMonths, dueOn: addMonths(start, 10), availableFrom: addMonths(start, 11) };
}

/** Close requires closingPriceInr, and agreedTerms.leaseMonths for a Lease (400 closing-terms-required). */
export function closingTermsMissing(dealType: string, closingPriceInr: number | null | undefined, leaseMonths: number | null | undefined) {
  return closingPriceInr === null || closingPriceInr === undefined || (dealType === 'Lease' && !leaseMonths);
}
