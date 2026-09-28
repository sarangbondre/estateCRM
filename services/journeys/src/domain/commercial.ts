// Commercial axis (BRD §4.4, §6.1; LLD §4.2): derived from live engagements, so backward moves fall out naturally.
export const OFFER_STATUSES = [
  'Upcoming',
  'Available',
  'Matched',
  'In proposal',
  'Site visit',
  'In process',
  'Closed',
  'Inactive',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const DEMAND_STATUSES = [
  'New',
  'Contacted',
  'Active',
  'Sourcing',
  'Matched',
  'Proposal shared',
  'Site visit',
  'In process',
  'Closed',
] as const;
export type DemandStatus = (typeof DEMAND_STATUSES)[number];

export type ExitType = 'Lost' | 'Dormant' | 'Invalid';

export interface OfferEngagements {
  hasOpenDeal: boolean;
  /** Completed visit (outcome ≠ no-show) with a Confirmed match of a live demand that includes the offer. */
  hasCompletedVisit: boolean;
  /** Sent proposal with a live option (Confirmed match) that includes the offer. */
  hasSentProposal: boolean;
  hasConfirmedMatch: boolean;
  /** possession_status = Available From and available_from > today */
  isUpcoming: boolean;
}

/** Closed and Inactive are terminal until compensated (deal cancel, R-12 reactivation). */
export function deriveOfferStatus(current: OfferStatus | null, e: OfferEngagements): OfferStatus {
  if (current === 'Closed' || current === 'Inactive') return current;
  if (e.hasOpenDeal) return 'In process';
  if (e.hasCompletedVisit) return 'Site visit';
  if (e.hasSentProposal) return 'In proposal';
  if (e.hasConfirmedMatch) return 'Matched';
  if (e.isUpcoming) return 'Upcoming';
  return 'Available';
}

export interface DemandEngagements {
  hasOpenDeal: boolean;
  /** Completed visit (outcome ≠ client no-show) */
  hasCompletedVisit: boolean;
  hasSentProposal: boolean;
  hasConfirmedMatch: boolean;
  /** Open / In progress sourcing request */
  hasOpenSourcingRequest: boolean;
  qualified: boolean;
  contacted: boolean;
}

/** Closed is terminal until a deal cancel compensates it; exits are held separately (exit_type). */
export function deriveDemandStatus(current: DemandStatus | null, e: DemandEngagements): DemandStatus {
  if (current === 'Closed') return current;
  if (e.hasOpenDeal) return 'In process';
  if (e.hasCompletedVisit) return 'Site visit';
  if (e.hasSentProposal) return 'Proposal shared';
  if (e.hasConfirmedMatch) return 'Matched';
  if (e.hasOpenSourcingRequest) return 'Sourcing';
  if (e.qualified) return 'Active';
  if (e.contacted) return 'Contacted';
  return 'New';
}

/** Offer is "live" for engagements (visits, deals): not Closed/Inactive. */
export const isLiveOffer = (s: OfferStatus) => s !== 'Closed' && s !== 'Inactive';

/** Lost / Invalid exits and Closed freeze the curve; Dormant pauses it (LLD §4.2.4). */
export function exitCurveEffect(exit: ExitType): 'pause' | 'freeze' {
  return exit === 'Dormant' ? 'pause' : 'freeze';
}
