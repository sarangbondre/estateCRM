// Publication ceiling (BRD §4.6, PRD §4.6, LLD §4.1). Pure: computeXCeiling(inputs) → { ceiling, reasons }.
// Every failing condition adds its reason; the lowest cap decides the ceiling.
import { minLevel, rank } from './levels.js';
import type { DemandFacts, Level, OfferFacts, ProjectFacts } from './types.js';

export const REASON_CODES = [
  'commercial_closed',
  'commercial_inactive',
  'retired_unwilling',
  'life_expired',
  'life_stale',
  'life_paused',
  'outside_launch_area',
  'not_verified',
  'no_real_photos',
  'project_rera_missing',
  'agent_rera_missing',
  'demand_not_sourcing',
  'demand_exited',
  'project_no_live_configuration',
  'merged',
  'voided',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_MESSAGES: Record<ReasonCode, string> = {
  commercial_closed: 'The offer is Closed.',
  commercial_inactive: 'The offer is Inactive (retired).',
  retired_unwilling: 'The source is unwilling: this offer is never published.',
  life_expired: 'The offer has Expired on the life curve; reconfirm it first.',
  life_stale: 'The offer is Stale: Anonymous at most until it is reconfirmed.',
  life_paused: 'The life curve is Paused.',
  outside_launch_area: 'The property is outside the launch area.',
  not_verified:
    'Not verified yet (record stage below Verified, or the classification is incomplete): Anonymous at most.',
  no_real_photos: 'No real photo is selected and processed: Anonymous at most.',
  project_rera_missing: 'The project RERA number is missing (required for Sale, Primary).',
  agent_rera_missing: 'The 11 Estates MahaRERA agent number is not set (Settings).',
  demand_not_sourcing: 'The demand is not in Sourcing (or is already matched).',
  demand_exited: 'The demand has exited.',
  project_no_live_configuration: 'No configuration offer of this project can be published.',
  merged: 'Merged into another record: never published.',
  voided: 'Voided in records: never published.',
};

/** Reasons that make a subject never publishable (409 subject-not-publishable instead of level-above-ceiling). */
export const NEVER_PUBLISHABLE: readonly ReasonCode[] = ['retired_unwilling', 'merged', 'voided'];

export interface CeilingResult {
  ceiling: Level;
  reasons: ReasonCode[];
}

export interface CeilingPolicy {
  /**
   * Production: the MahaRERA agent number is mandatory before anything is served (BRD §4.6, R14).
   * Pilot (questionnaire A7): publishing is allowed without it; items show "MahaRERA registration pending".
   */
  agentNumberRequired: boolean;
}

class Acc {
  readonly reasons: ReasonCode[] = [];
  constructor(public ceiling: Level = 'Public') {}
  cap(level: Level, reason: ReasonCode) {
    this.ceiling = minLevel(this.ceiling, level);
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
  }
  result(): CeilingResult {
    return { ceiling: this.ceiling, reasons: this.reasons };
  }
}

export interface OfferCeilingInput {
  offer: OfferFacts;
  agentNumberSet: boolean;
  /** RERA number of the offer's project (Sale/Primary configurations), null when missing or no project. */
  projectReraNumber: string | null;
  /** Selected photos that are real and processed (status ready). */
  readyRealSelectedPhotos: number;
  /** Current level: decides Stale (A-L1). */
  currentLevel: Level;
  /** The generated label and segment resolve (the public shape needs both). */
  classifiable: boolean;
}

export function computeOfferCeiling(input: OfferCeilingInput, policy: CeilingPolicy): CeilingResult {
  const o = input.offer;
  const acc = new Acc();
  if (policy.agentNumberRequired && !input.agentNumberSet) acc.cap('Private', 'agent_rera_missing');
  if (o.commercialStatus === 'Closed') acc.cap('Private', 'commercial_closed');
  if (o.commercialStatus === 'Inactive') {
    acc.cap('Private', 'commercial_inactive');
    if (o.retiredReason === 'unwilling') acc.cap('Private', 'retired_unwilling');
  } else if (o.retiredReason === 'unwilling') {
    // Unwilling is permanent even if a later status event arrives first (never publishable, US-18).
    acc.cap('Private', 'retired_unwilling');
  }
  if (o.voidedReason) acc.cap('Private', 'voided');
  if (o.mergedIntoId) acc.cap('Private', 'merged');
  if (o.lifeStage === 'Expired') acc.cap('Private', 'life_expired');
  if (o.lifeStage === 'Paused') acc.cap('Private', 'life_paused');
  if (o.outsideLaunchArea) acc.cap('Private', 'outside_launch_area');
  if (o.dealType === 'Sale' && o.market === 'Primary' && !input.projectReraNumber)
    acc.cap('Private', 'project_rera_missing');
  if (o.lifeStage === 'Stale')
    acc.cap(rank(input.currentLevel) >= rank('Anonymous') ? 'Anonymous' : 'Private', 'life_stale');
  if (!input.classifiable) acc.cap('Private', 'not_verified');
  if (o.recordStage !== 'Verified' && o.recordStage !== 'Qualified') acc.cap('Anonymous', 'not_verified');
  if (!o.hasRealPhotos || input.readyRealSelectedPhotos === 0) acc.cap('Anonymous', 'no_real_photos');
  return acc.result();
}

export interface ProjectCeilingInput {
  project: ProjectFacts;
  agentNumberSet: boolean;
  /** Ceilings of the project's configuration offers. */
  configurationCeilings: readonly Level[];
}

/** Projects: Private or Public only (A-L3). */
export function computeProjectCeiling(input: ProjectCeilingInput, policy: CeilingPolicy): CeilingResult {
  const acc = new Acc();
  if (policy.agentNumberRequired && !input.agentNumberSet) acc.cap('Private', 'agent_rera_missing');
  if (!input.project.reraNumber) acc.cap('Private', 'project_rera_missing');
  if (!input.configurationCeilings.some((c) => rank(c) >= rank('Anonymous')))
    acc.cap('Private', 'project_no_live_configuration');
  return acc.result();
}

export interface DemandCeilingInput {
  demand: DemandFacts;
  agentNumberSet: boolean;
}

/** Demand posts: Private or Anonymous only. */
export function computeDemandCeiling(input: DemandCeilingInput, policy: CeilingPolicy): CeilingResult {
  const d = input.demand;
  const acc = new Acc('Anonymous');
  if (policy.agentNumberRequired && !input.agentNumberSet) acc.cap('Private', 'agent_rera_missing');
  if (d.voidedReason) acc.cap('Private', 'voided');
  if (d.mergedIntoId) acc.cap('Private', 'merged');
  if (d.status !== 'Sourcing' || d.matched) acc.cap('Private', 'demand_not_sourcing');
  if (d.exitType) acc.cap('Private', 'demand_exited');
  if (d.lifeStage === 'Stale') acc.cap('Private', 'life_stale');
  if (d.lifeStage === 'Expired') acc.cap('Private', 'life_expired');
  if (d.lifeStage === 'Paused') acc.cap('Private', 'life_paused');
  return acc.result();
}

/** Reasons that cap at Anonymous at most (the rest cap at Private). life_stale may do either; not_verified too. */
const ANONYMOUS_CAPS: readonly ReasonCode[] = ['not_verified', 'no_real_photos', 'life_stale'];

/** The reasons that keep a subject below `requested` (for choosing between 409 and 422 rera-missing). */
export function reasonsBelow(reasons: readonly ReasonCode[], requested: Level): ReasonCode[] {
  if (requested === 'Public') return [...reasons];
  return reasons.filter((r) => !ANONYMOUS_CAPS.includes(r));
}
