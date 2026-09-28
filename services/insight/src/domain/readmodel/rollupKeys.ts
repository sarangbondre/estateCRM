// Dimension tuples of the rollups (LLD §3.2). A row that is not counted (a stub, voided or merged away) has no tuple:
// the projector moves −1 from the old tuple and +1 to the new one whenever they differ.
import type { DemandRow, OfferRow } from './rows.js';

export interface OfferDims {
  segment: string | null;
  deal_type: string | null;
  market: string | null;
  property_type_primary: string | null;
  micromarket: string | null;
  owner_user_id: string | null;
  source_type: string | null;
  life_stage: string | null;
  commercial_status: string | null;
  record_stage: string | null;
  publication_level: string | null;
  outside_launch_area: boolean;
  sale_mode: string | null;
  tenancy_status: string | null;
}

export interface DemandDims {
  segment: string | null;
  deal_type_primary: string | null;
  market: string | null;
  property_type_primary: string | null;
  micromarket: string | null;
  owner_user_id: string | null;
  source_type: string | null;
  life_stage: string | null;
  commercial_status: string | null;
  record_stage: string | null;
  exit_type: string | null;
  outside_launch_area: boolean;
}

export const OFFER_DIMS: readonly (keyof OfferDims)[] = [
  'segment',
  'deal_type',
  'market',
  'property_type_primary',
  'micromarket',
  'owner_user_id',
  'source_type',
  'life_stage',
  'commercial_status',
  'record_stage',
  'publication_level',
  'outside_launch_area',
  'sale_mode',
  'tenancy_status',
];

export const DEMAND_DIMS: readonly (keyof DemandDims)[] = [
  'segment',
  'deal_type_primary',
  'market',
  'property_type_primary',
  'micromarket',
  'owner_user_id',
  'source_type',
  'life_stage',
  'commercial_status',
  'record_stage',
  'exit_type',
  'outside_launch_area',
];

/** An offer counts once it is known (offer.created applied) and while it is neither voided nor merged away. */
export function offerCounted(row: Pick<OfferRow, 'code' | 'void_reason' | 'merged_into_id'> | undefined): boolean {
  return !!row && row.code !== null && row.void_reason === null && row.merged_into_id === null;
}

export function demandCounted(row: Pick<DemandRow, 'code' | 'void_reason' | 'merged_into_id'> | undefined): boolean {
  return !!row && row.code !== null && row.void_reason === null && row.merged_into_id === null;
}

export function offerDims(row: OfferRow | undefined): OfferDims | null {
  if (!row || !offerCounted(row)) return null;
  return {
    segment: row.segment,
    deal_type: row.deal_type,
    market: row.market,
    property_type_primary: row.property_type_primary,
    micromarket: row.micromarket,
    owner_user_id: row.owner_user_id,
    source_type: row.source_type,
    life_stage: row.life_stage,
    commercial_status: row.commercial_status,
    record_stage: row.record_stage,
    publication_level: row.publication_level,
    outside_launch_area: row.outside_launch_area,
    sale_mode: row.sale_mode,
    tenancy_status: row.tenancy_status,
  };
}

export function demandDims(row: DemandRow | undefined): DemandDims | null {
  if (!row || !demandCounted(row)) return null;
  return {
    segment: row.segment,
    deal_type_primary: row.deal_type_primary,
    market: row.market,
    property_type_primary: row.property_type_primary,
    micromarket: row.micromarkets[0] ?? null,
    owner_user_id: row.owner_user_id,
    source_type: row.source_type,
    life_stage: row.life_stage,
    commercial_status: row.commercial_status,
    record_stage: row.record_stage,
    exit_type: row.exit_type,
    outside_launch_area: row.outside_launch_area,
  };
}

/** Stable text key of a tuple (the adapter hashes it into dims_hash). */
export function dimsKey(dims: object): string {
  return JSON.stringify(Object.entries(dims).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface RollupDelta<D> {
  dims: D;
  delta: 1 | -1;
}

/** The −1/+1 moves between the tuple before and after a change (none when unchanged). */
export function rollupMoves<D extends object>(before: D | null, after: D | null): RollupDelta<D>[] {
  if (before && after && dimsKey(before) === dimsKey(after)) return [];
  const out: RollupDelta<D>[] = [];
  if (before) out.push({ dims: before, delta: -1 });
  if (after) out.push({ dims: after, delta: 1 });
  return out;
}

/** Daily-fact dimensions (LLD §3.2 rm_daily_fact). Absent dimensions are null. */
export interface FactDims {
  segment: string | null;
  deal_type: string | null;
  market: string | null;
  source_type: string | null;
  owner_user_id: string | null;
  micromarket: string | null;
  reason: string | null;
}

export function factDims(partial: Partial<FactDims>): FactDims {
  return {
    segment: partial.segment ?? null,
    deal_type: partial.deal_type ?? null,
    market: partial.market ?? null,
    source_type: partial.source_type ?? null,
    owner_user_id: partial.owner_user_id ?? null,
    micromarket: partial.micromarket ?? null,
    reason: partial.reason ?? null,
  };
}
