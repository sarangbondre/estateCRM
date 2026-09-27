// Display labels are generated from stored fields on read (BRD §4.2, records LLD §4.1); never stored or filterable.
import { displayLabel, displayLabels } from '@11e/vocabulary';
import type { DealType, Market, Segment } from '@11e/vocabulary';

/** Offer (Supply) label for its single deal type, e.g. "For Rent", "Resale, For Sale". */
export function offerLabel(dealType: string, market: string | null, segment: string | null): string {
  const l = displayLabel({
    recordScope: 'Property',
    side: 'Supply',
    dealType: dealType as DealType,
    market: market as Market | null,
    segment: segment as Segment | null,
  });
  // No BRD cell (e.g. a non-property deal type): the deal type itself is the most honest label.
  return l?.text ?? dealType;
}

/** Demand label: one per deal type ("Wants to Buy, New Project"), joined with " / " for multi-deal demands. */
export function demandLabel(dealTypes: readonly string[], market: string | null, segment: string | null): string {
  const labels = displayLabels({
    recordScope: 'Property',
    side: 'Demand',
    dealTypes: dealTypes as DealType[],
    market: market as Market | null,
    segment: segment as Segment | null,
  });
  if (labels.length) return labels.map((l: { text: string }) => l.text).join(' / ');
  return dealTypes.length ? `Wants ${dealTypes.join(' / ')}` : 'Wants';
}
