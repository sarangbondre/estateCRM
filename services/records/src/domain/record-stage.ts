// Record axis (records LLD §4.10, R-10): forward moves by agents (skipping allowed), backward moves by
// Admin/Manager only, Verified requires a real photo (offers).
import { RecordsError } from './errors.js';

export const OFFER_STAGES = ['Captured', 'Enriched', 'Contacted', 'Verified', 'Qualified'] as const;
export const DEMAND_STAGES = ['Captured', 'Enriched', 'Verified', 'Qualified'] as const;
export type OfferStage = (typeof OFFER_STAGES)[number];
export type DemandStage = (typeof DEMAND_STAGES)[number];

export const MANAGER_ROLES: readonly string[] = ['Admin', 'Manager'];

export type StageDecision = { kind: 'noop' } | { kind: 'move'; from: string; to: string };

export function decideOfferStage(
  from: string,
  to: string,
  role: string,
  hasRealPhotos: boolean,
): StageDecision {
  const verified = OFFER_STAGES.indexOf('Verified');
  return decide(OFFER_STAGES, from, to, role, () => {
    // Skipping past Verified still needs what Verified needs.
    const crosses =
      OFFER_STAGES.indexOf(to as OfferStage) >= verified && OFFER_STAGES.indexOf(from as OfferStage) < verified;
    if (crosses && !hasRealPhotos) throw new RecordsError('verification-needs-real-photos');
  });
}

export function decideDemandStage(from: string, to: string, role: string): StageDecision {
  return decide(DEMAND_STAGES, from, to, role, () => undefined);
}

function decide(
  stages: readonly string[],
  from: string,
  to: string,
  role: string,
  forwardCheck: () => void,
): StageDecision {
  const f = stages.indexOf(from);
  const t = stages.indexOf(to);
  if (t < 0) throw new RecordsError('invalid-stage-transition', `unknown stage ${to}`);
  if (f === t) return { kind: 'noop' };
  if (t < f && !MANAGER_ROLES.includes(role)) {
    throw new RecordsError('invalid-stage-transition', 'backward moves need Admin or Manager');
  }
  if (t > f) forwardCheck();
  return { kind: 'move', from, to };
}

/** Automatic lift (confirmed call, visit, offer confirmed): never lowers the stage. */
export function liftOfferStage(current: string, atLeast: OfferStage): string {
  return OFFER_STAGES.indexOf(current as OfferStage) >= OFFER_STAGES.indexOf(atLeast) ? current : atLeast;
}
