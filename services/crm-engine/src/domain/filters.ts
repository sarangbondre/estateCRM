// Hard filters (LLD §4.1, PRD §4.5, BRD §7), evaluated in order; the first failure decides the outcome.
// Outcomes: pass; skip (never a candidate); exclude (recorded with a reason, e.g. "Available too late", AS-S5).
import { matchKey } from '@11e/vocabulary';
import { availabilityPeriod } from './dates.js';
import { demandAcceptsNew, demandIsMatchable, offerIsMatchable } from './matchable.js';
import type {
  DemandMx,
  ExclusionReason,
  FilterCheck,
  HardFilterName,
  IsoDate,
  MatchFlag,
  OfferMx,
} from './types.js';

export type FilterOutcome =
  | { kind: 'pass'; checks: FilterCheck[]; flags: MatchFlag[] }
  | { kind: 'skip'; failed: HardFilterName; checks: FilterCheck[] }
  | {
      kind: 'exclude';
      reason: ExclusionReason;
      failed: HardFilterName;
      checks: FilterCheck[];
      availableFrom: IsoDate | null;
    };

/** Deal tags a client can state that the offer carries (filter 7). Offer value blank → compatible. */
export const STATED_DEAL_TAGS = [
  'tenancy_status',
  'sale_mode',
  'possession_status',
  'tenure',
  'agreement_form',
  'is_jodi',
] as const;
type StatedDealTag = (typeof STATED_DEAL_TAGS)[number];

/** statedTags keys arrive as snake_case or camelCase; normalise to snake_case. */
export function normaliseTagKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

export function statedTag(tags: Readonly<Record<string, string>>, key: string): string | undefined {
  for (const [k, v] of Object.entries(tags)) if (normaliseTagKey(k) === key && v.trim() !== '') return v;
  return undefined;
}

const TRUE_VALUES = new Set(['true', 'yes', 'y', '1']);
const FALSE_VALUES = new Set(['false', 'no', 'n', '0']);

function offerTagValue(o: OfferMx, tag: StatedDealTag): string | null {
  switch (tag) {
    case 'tenancy_status':
      return o.tenancyStatus;
    case 'sale_mode':
      return o.saleMode;
    case 'possession_status':
      return o.possessionStatus;
    case 'tenure':
      return o.tenure;
    case 'agreement_form':
      return o.agreementForm;
    case 'is_jodi':
      return o.isJodi === null ? null : String(o.isJodi);
  }
}

function tagsEqual(tag: StatedDealTag, stated: string, offered: string): boolean {
  if (tag === 'is_jodi') {
    const s = matchKey(stated);
    const want = TRUE_VALUES.has(s) ? true : FALSE_VALUES.has(s) ? false : undefined;
    return want === undefined || String(want) === offered;
  }
  return matchKey(stated) === matchKey(offered);
}

/** Residential BHK band (CR-011 item 3): an offer's BHK may differ from the demand's by at most this much. */
export const BHK_BAND = 1;

type BhkSides = Pick<OfferMx, 'bhkMin' | 'bhkMax'>;

/**
 * Distance in BHK between an offer's and a demand's BHK ranges (0 when they overlap). A range with one end blank is
 * that single value; `null` when either side has no BHK (unknown BHK is never filtered, and the factor is not
 * applicable). A demand for "2 or 3 BHK" is the range 2–3, so its band is 1–4.
 */
export function bhkGap(o: BhkSides, d: BhkSides): number | null {
  const oMin = o.bhkMin ?? o.bhkMax;
  const oMax = o.bhkMax ?? o.bhkMin;
  const dMin = d.bhkMin ?? d.bhkMax;
  const dMax = d.bhkMax ?? d.bhkMin;
  if (oMin === null || oMax === null || dMin === null || dMax === null) return null;
  return oMax < dMin ? dMin - oMax : oMin > dMax ? oMin - dMax : 0;
}

const bhkText = (min: number | null, max: number | null) =>
  min !== null && max !== null && min !== max ? `${min}–${max}` : String(max ?? min);

export interface FilterOptions {
  /** A new suggestion is being considered: a Stale demand accepts none (exclusion `demand_stale`). */
  requireAcceptsNew?: boolean;
}

/**
 * Runs filters 1–9 for one (offer, demand) pair. Liveness (row 3) is reported as a skip for a dead demand and for a
 * closed/voided/merged offer; an Expired or Inactive offer that passes 4–9 is an exclusion (`offer_expired` /
 * `offer_inactive`); a Stale demand with a new pair is an exclusion `demand_stale` when `requireAcceptsNew` is set.
 */
export function evaluateHardFilters(o: OfferMx, d: DemandMx, options: FilterOptions = {}): FilterOutcome {
  const checks: FilterCheck[] = [];
  const flags: MatchFlag[] = [];
  const fail = (filter: HardFilterName, detail?: string): FilterOutcome => {
    checks.push({ filter, passed: false, ...(detail ? { detail } : {}) });
    return { kind: 'skip', failed: filter, checks };
  };
  const ok = (filter: HardFilterName, detail?: string) =>
    checks.push({ filter, passed: true, ...(detail ? { detail } : {}) });

  // 1. side / scope: the projection holds only Property offers (Supply) and demands (Demand).
  ok('side', 'Offer (Supply) vs Demand');
  ok('record_scope', 'Property');

  // 2. launch area (CR-006 Z-7)
  if (o.outsideLaunchArea || d.outsideLaunchArea)
    return fail(
      'launch_area',
      o.outsideLaunchArea ? 'offer outside the launch area' : 'demand outside the launch area',
    );
  ok('launch_area');

  // 3. liveness — terminal states that are never candidates
  if (o.voided || o.mergedInto !== null || o.commercialStatus === 'Closed')
    return fail('offer_live', o.voided ? 'offer voided' : o.mergedInto ? 'offer merged' : 'offer Closed');
  if (!demandIsMatchable(d))
    return fail(
      'demand_live',
      d.exitType
        ? `demand exited (${d.exitType})`
        : d.commercialStatus === 'Closed'
          ? 'demand Closed'
          : `demand ${d.lifeStage}`,
    );
  const offerDead: ExclusionReason | null = offerIsMatchable(o)
    ? null
    : o.lifeStage === 'Expired'
      ? 'offer_expired'
      : 'offer_inactive';

  // 4. deal type
  if (!d.dealTypes.includes(o.dealType))
    return fail('deal_type', `${o.dealType} not in ${d.dealTypes.join(', ')}`);
  ok('deal_type', o.dealType);

  // 5. market (Sale only). Demand Any or blank (JB-1) matches Primary and Secondary; offer blank → compatible + flag.
  if (o.dealType === 'Sale') {
    const want = d.market && d.market !== 'Any' ? d.market : null;
    if (!o.market) {
      flags.push('market_unknown');
      ok('market', 'offer market unknown: compatible');
    } else if (want && want !== o.market) {
      return fail('market', `${o.market} vs ${want}`);
    } else ok('market', o.market);
  } else ok('market', 'not a Sale');

  // 6. segment and property type
  if (!o.segment || !d.segment || o.segment !== d.segment)
    return fail('segment', `${o.segment ?? 'unknown'} vs ${d.segment ?? 'unknown'}`);
  ok('segment', o.segment);
  if (
    o.propertyTypes.length &&
    d.propertyTypes.length &&
    !o.propertyTypes.some((t) => d.propertyTypes.includes(t))
  )
    return fail('property_type', `${o.propertyTypes.join(', ')} vs ${d.propertyTypes.join(', ')}`);
  // Residential BHK within ±1 of the demand (CR-011 item 3). Reported under property_type: the contract's filter list
  // has no BHK entry. Like a property type mismatch, it is a skip (never a candidate), not a recorded exclusion.
  if (o.segment === 'Residential') {
    const gap = bhkGap(o, d);
    if (gap !== null && gap > BHK_BAND)
      return fail(
        'property_type',
        `${bhkText(o.bhkMin, o.bhkMax)} BHK vs ${bhkText(d.bhkMin, d.bhkMax)} BHK (±${BHK_BAND} allowed)`,
      );
  }
  ok('property_type');

  // 7. stated deal tags
  for (const tag of STATED_DEAL_TAGS) {
    const stated = statedTag(d.statedTags, tag);
    if (stated === undefined) continue;
    const offered = offerTagValue(o, tag);
    if (offered !== null && !tagsEqual(tag, stated, offered))
      return fail('stated_tags', `${tag}: ${offered} vs ${stated}`);
  }
  ok('stated_tags');

  // 8. micromarket overlap (hierarchy counts: Chakala is inside Andheri East)
  const expanded = new Set(d.mmExpanded);
  if (!o.mmPath.some((k) => expanded.has(k)))
    return fail('micromarket', `${o.locality ?? o.micromarket ?? 'unknown'} not in the demand's area`);
  ok('micromarket', o.locality ?? o.micromarket ?? undefined);

  // 9. possession window: period start ≤ move_in_by (moveInFrom is soft, JB-7)
  const period = availabilityPeriod(o.possessionDateRaw, o.possessionStatus);
  if (d.moveInBy && period && period.from > d.moveInBy) {
    checks.push({
      filter: 'possession_window',
      passed: false,
      detail: `Available from ${period.from}, demand needs by ${d.moveInBy}`,
    });
    return {
      kind: 'exclude',
      reason: 'available_too_late',
      failed: 'possession_window',
      checks,
      availableFrom: period.from,
    };
  }
  ok('possession_window', period ? `available from ${period.from}` : 'available now');

  if (offerDead) {
    checks.push({
      filter: 'offer_live',
      passed: false,
      detail: offerDead === 'offer_expired' ? 'offer Expired' : 'offer Inactive',
    });
    return {
      kind: 'exclude',
      reason: offerDead,
      failed: 'offer_live',
      checks,
      availableFrom: period?.from ?? null,
    };
  }
  ok('offer_live', o.lifeStage);
  if (options.requireAcceptsNew && !demandAcceptsNew(d)) {
    checks.push({
      filter: 'demand_live',
      passed: false,
      detail: `demand ${d.lifeStage}: no new suggestions`,
    });
    return {
      kind: 'exclude',
      reason: 'demand_stale',
      failed: 'demand_live',
      checks,
      availableFrom: period?.from ?? null,
    };
  }
  ok('demand_live', d.lifeStage);
  return { kind: 'pass', checks, flags };
}
