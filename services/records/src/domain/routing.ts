// Ingestion routing (records LLD §4.2 table, CR-006 Z-8): record_scope and side decide what a row becomes;
// the extractor's route_to is kept as a suggestion only.

export type Route =
  | { kind: 'supply' }
  | { kind: 'demand' }
  | { kind: 'unrouted' }
  | { kind: 'desk'; desk: 'business' | 'capital' | 'archive' | 'watchlist'; withProperty: boolean }
  | { kind: 'network' };

export function routeRow(row: {
  recordScope: string | null | undefined;
  side: string | null | undefined;
  includesProperty?: string | null | undefined;
}): Route {
  const scope = row.recordScope ?? 'Property';
  switch (scope) {
    case 'Property':
      if (row.side === 'Supply') return { kind: 'supply' };
      if (row.side === 'Demand') return { kind: 'demand' };
      return { kind: 'unrouted' };
    case 'Business':
      return { kind: 'desk', desk: 'business', withProperty: row.includesProperty === 'Yes' && row.side === 'Supply' };
    case 'Capital':
      return { kind: 'desk', desk: 'capital', withProperty: false };
    case 'Equipment':
      return { kind: 'desk', desk: 'archive', withProperty: false };
    case 'Market Participant':
      return { kind: 'network' };
    case 'Market Signal':
      return { kind: 'desk', desk: 'watchlist', withProperty: false };
    default:
      return { kind: 'unrouted' };
  }
}

/** The price and deal-tag facts of a row, as the extractor gives them (one set for all deal types). */
export interface RowPrices {
  market: string | null;
  salePriceInrMin: number | null;
  salePriceInrMax: number | null;
  saleRateInr: number | null;
  saleRateUnit: string | null;
  rentMonthlyInrMin: number | null;
  rentMonthlyInrMax: number | null;
  rentRatePsf: number | null;
  depositInr: number | null;
  depositMonths: number | null;
  currentRentInr: number | null;
  yieldPct: number | null;
}

export type OfferPrices = RowPrices;

const NONE: OfferPrices = {
  market: null,
  salePriceInrMin: null,
  salePriceInrMax: null,
  saleRateInr: null,
  saleRateUnit: null,
  rentMonthlyInrMin: null,
  rentMonthlyInrMax: null,
  rentRatePsf: null,
  depositInr: null,
  depositMonths: null,
  currentRentInr: null,
  yieldPct: null,
};

/**
 * OfferSplitter: one offer per property deal type (Sale|Lease → 2 offers). Sale gets the sale fields, market and the
 * current rent/yield (pre-leased); Lease gets rent and deposit; Pagdi gets the premium as its sale price plus the
 * nominal rent; JV carries no price.
 */
export function splitOfferPrices(dealTypes: readonly string[], p: RowPrices): { dealType: string; prices: OfferPrices }[] {
  const sale = {
    salePriceInrMin: p.salePriceInrMin,
    salePriceInrMax: p.salePriceInrMax,
    saleRateInr: p.saleRateInr,
    saleRateUnit: p.saleRateUnit,
  };
  const rent = {
    rentMonthlyInrMin: p.rentMonthlyInrMin,
    rentMonthlyInrMax: p.rentMonthlyInrMax,
    rentRatePsf: p.rentRatePsf,
    depositInr: p.depositInr,
    depositMonths: p.depositMonths,
  };
  const out: { dealType: string; prices: OfferPrices }[] = [];
  for (const dealType of dealTypes) {
    if (out.some((o) => o.dealType === dealType)) continue;
    switch (dealType) {
      case 'Sale':
        out.push({
          dealType,
          prices: { ...NONE, ...sale, market: p.market, currentRentInr: p.currentRentInr, yieldPct: p.yieldPct },
        });
        break;
      case 'Lease':
        out.push({ dealType, prices: { ...NONE, ...rent } });
        break;
      case 'Pagdi':
        out.push({ dealType, prices: { ...NONE, ...sale, ...rent } });
        break;
      case 'JV':
        out.push({ dealType, prices: { ...NONE } });
        break;
      default:
        break; // non-property deal types never become offers
    }
  }
  return out;
}
