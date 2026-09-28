// Derived property/offer facts.

/** Floor band shown instead of the exact floor (PRD A-43): thirds of the building height. */
export function floorBand(floorNo: number | null, totalFloors: number | null): 'Low' | 'Mid' | 'High' | null {
  if (floorNo === null || totalFloors === null || totalFloors <= 0) return null;
  const ratio = Math.max(0, floorNo) / totalFloors;
  if (ratio <= 1 / 3) return 'Low';
  if (ratio <= 2 / 3) return 'Mid';
  return 'High';
}

/** First day of a `YYYY` / `YYYY-MM` / `YYYY-MM-DD` possession date (sort/filter column). */
export function possessionDateStart(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!m) return null;
  return `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`;
}

/** Offer price fields, grouped: the fields `offer.price_changed.v1` reports. */
export const PRICE_FIELDS = [
  'sale_price_inr_min',
  'sale_price_inr_max',
  'rent_monthly_inr_min',
  'rent_monthly_inr_max',
  'deposit_inr',
  'current_rent_inr',
  'unit_count',
] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

/** The comparable asking price of an offer for its deal type (sale price, or monthly rent for Lease). */
export function askingPrice(o: {
  deal_type: string;
  sale_price_inr_min: number | null;
  sale_price_inr_max: number | null;
  rent_monthly_inr_min: number | null;
  rent_monthly_inr_max: number | null;
}): number | null {
  if (o.deal_type === 'Lease') return o.rent_monthly_inr_min ?? o.rent_monthly_inr_max;
  return o.sale_price_inr_min ?? o.sale_price_inr_max;
}

/** Price gap between two sources, in % of the existing price (PRD A-39: a gap is > 5%). */
export function priceGapPct(existing: number | null, other: number | null): number | null {
  if (existing === null || other === null || existing <= 0) return null;
  return Math.round((Math.abs(other - existing) / existing) * 10000) / 100;
}

export const PRICE_GAP_THRESHOLD_PCT = 5;
