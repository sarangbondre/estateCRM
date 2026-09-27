// Display labels ("For Rent", "Wants to Buy, Resale") from stored fields (BRD §4.2), for tables, grids and answers.
// Labels are generated for display only: never stored, never used as filter values. Pure (libs/vocabulary table).
import { displayLabel } from '@11e/vocabulary';
import type { DealType, Market, Segment } from '@11e/vocabulary';

export function labelFor(
  side: 'Supply' | 'Demand',
  dealType: string | null | undefined,
  market: string | null | undefined,
  segment: string | null | undefined,
): string | null {
  if (!dealType) return null;
  const l = displayLabel({
    recordScope: 'Property',
    side,
    dealType: dealType as DealType,
    market: (market ?? null) as Market | null,
    segment: (segment ?? null) as Segment | null,
  });
  return l?.text ?? null;
}
