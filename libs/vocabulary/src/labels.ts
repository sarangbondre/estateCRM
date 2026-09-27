/**
 * Generated display labels (BRD §4.2 "Display labels"). Labels are generated from stored fields,
 * never stored, and never used for filtering.
 */
import {
  DISPLAY_LABEL_TABLE,
  PROPERTY_DEAL_TYPES,
  type DealType,
  type DisplayLabelKey,
  type Market,
  type PropertyDealType,
  type RecordScope,
  type Segment,
  type Side,
} from './release-v0.6.js';

/**
 * Sale with a blank (unknown) market: not a row of the BRD table (see README "Assumptions").
 * Supply drops the market prefix ("For Sale"); Demand reads like Sale, Any ("Wants to Buy").
 */
export const SALE_MARKET_UNKNOWN_ROW = {
  key: 'sale_market_unknown',
  dealType: 'Sale, market blank',
  supplyLabel: 'For Sale',
  demandLabel: 'Wants to Buy',
  supplyParties: 'Seller and Buyer',
  demandParties: 'Buyer',
} as const;

export type LabelRowKey = DisplayLabelKey | typeof SALE_MARKET_UNKNOWN_ROW.key;

export interface DisplayLabel {
  readonly dealType: PropertyDealType;
  /** e.g. "For Rent", "Wants to Buy, New Project". */
  readonly text: string;
  /** Parties column of the table, e.g. "Landlord and Tenant". */
  readonly parties: string;
  /** Which table row produced the label. */
  readonly row: LabelRowKey;
}

export interface LabelInput {
  readonly recordScope: RecordScope | null;
  readonly side: Side | null;
  readonly dealType: DealType;
  /** Used for Sale only; ignored for other deal types. */
  readonly market?: Market | null | undefined;
  /** Used for Lease only (Rent for Residential). */
  readonly segment?: Segment | null | undefined;
}

const ROWS = new Map(DISPLAY_LABEL_TABLE.map((row) => [row.key, row]));

function row(key: DisplayLabelKey): (typeof DISPLAY_LABEL_TABLE)[number] {
  return ROWS.get(key) as (typeof DISPLAY_LABEL_TABLE)[number];
}

function isPropertyDealType(dealType: DealType): dealType is PropertyDealType {
  return (PROPERTY_DEAL_TYPES as readonly DealType[]).includes(dealType);
}

function tableKey(dealType: PropertyDealType, market: Market | null, segment: Segment | null) {
  switch (dealType) {
    case 'Sale':
      if (market === 'Primary') return 'sale_primary';
      if (market === 'Secondary') return 'sale_secondary';
      if (market === 'Any') return 'sale_any';
      return SALE_MARKET_UNKNOWN_ROW.key;
    case 'Lease':
      return segment === 'Residential' ? 'lease_residential' : 'lease_other';
    case 'JV':
      return 'jv';
    case 'Pagdi':
      return 'pagdi';
  }
}

/**
 * The label for one deal type of a record, or null when the BRD table gives none:
 * record_scope is not Property, side is None or blank, the deal type is not a Property deal type,
 * or the combination has an empty cell (Sale, Any on a Supply record).
 */
export function displayLabel(input: LabelInput): DisplayLabel | null {
  const { recordScope, side, dealType } = input;
  if (recordScope !== 'Property' || (side !== 'Supply' && side !== 'Demand')) return null;
  if (!isPropertyDealType(dealType)) return null;

  const key = tableKey(dealType, input.market ?? null, input.segment ?? null);
  if (key === SALE_MARKET_UNKNOWN_ROW.key) {
    const r = SALE_MARKET_UNKNOWN_ROW;
    return side === 'Supply'
      ? { dealType, text: r.supplyLabel, parties: r.supplyParties, row: key }
      : { dealType, text: r.demandLabel, parties: r.demandParties, row: key };
  }
  const r = row(key);
  const text = side === 'Supply' ? r.supplyLabel : r.demandLabel;
  return text === null ? null : { dealType, text, parties: r.parties, row: key };
}

export interface LabelClassification {
  readonly recordScope: RecordScope | null;
  readonly side: Side | null;
  readonly dealTypes: readonly DealType[];
  readonly market?: Market | null | undefined;
  readonly segment?: Segment | null | undefined;
}

/**
 * One label per deal type of a record (Sale|Lease gives two), in stored order. Deal types with no
 * label are skipped. Market applies to the Sale label only; segment to the Lease label only.
 */
export function displayLabels(c: LabelClassification): readonly DisplayLabel[] {
  return c.dealTypes.flatMap((dealType) => {
    const label = displayLabel({
      recordScope: c.recordScope,
      side: c.side,
      dealType,
      market: c.market,
      segment: c.segment,
    });
    return label === null ? [] : [label];
  });
}
