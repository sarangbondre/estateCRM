// Generated display labels and headlines (BRD §4.2, LLD §4.7). Labels are generated from stored values with
// @11e/vocabulary on every projection build: never stored, never filtered on, never a legacy term.
import { canonicalValue, displayLabel, segmentOfPropertyType } from '@11e/vocabulary';
import type { DealType, Market, Segment } from '@11e/vocabulary';

const deal = (v: string | null | undefined): DealType | null =>
  v ? ((canonicalValue('deal_type', v) as DealType | undefined) ?? null) : null;
const market = (v: string | null | undefined): Market | null =>
  v ? ((canonicalValue('market', v) as Market | undefined) ?? null) : null;
const segment = (v: string | null | undefined): Segment | null =>
  v ? ((canonicalValue('segment', v) as Segment | undefined) ?? null) : null;

/**
 * The offer's segment: the stored value, else the segment implied by its first property type (vocabulary
 * PROPERTY_TYPES_BY_SEGMENT). Null when neither resolves; such an offer can't be served (the public shape needs it).
 */
export function resolvedSegment(stored: string | null, propertyTypes: readonly string[]): Segment | null {
  const s = segment(stored);
  if (s) return s;
  for (const t of propertyTypes) {
    const canonical = canonicalValue('property_type', t);
    const bySegment = canonical ? segmentOfPropertyType(canonical) : undefined;
    if (bySegment) return bySegment;
  }
  return null;
}

/** Supply label for an offer ("For Rent", "New Project, For Sale"; Sale with a blank market → "For Sale", A-L4). */
export function supplyLabel(
  dealType: string,
  marketValue: string | null,
  segmentValue: string | null,
): string | null {
  const d = deal(dealType);
  if (!d) return null;
  return (
    displayLabel({
      recordScope: 'Property',
      side: 'Supply',
      dealType: d,
      market: market(marketValue),
      segment: segment(segmentValue),
    })?.text ?? null
  );
}

/** Demand label(s) joined with " · " ("Wants to Buy · Wants to Rent"). */
export function demandLabel(
  dealTypes: readonly string[],
  marketValue: string | null,
  segmentValue: string | null,
): string | null {
  const labels: string[] = [];
  for (const raw of dealTypes) {
    const d = deal(raw);
    if (!d) continue;
    const text = displayLabel({
      recordScope: 'Property',
      side: 'Demand',
      dealType: d,
      market: market(marketValue),
      segment: segment(segmentValue),
    })?.text;
    if (text && !labels.includes(text)) labels.push(text);
  }
  return labels.length ? labels.join(' · ') : null;
}

const fmtBhk = (n: number) => (n === 0.5 ? '1 RK' : `${Number.isInteger(n) ? n : n.toFixed(1)} BHK`);

/** `[{bhk} BHK ]{propertyTypes joined " / "} · {label} · {locality ?? micromarket}` (LLD §4.7). */
export function headline(input: {
  bhkMin: number | null;
  bhkMax: number | null;
  propertyTypes: readonly string[];
  label: string;
  locality: string | null;
  micromarket: string | null;
}): string {
  const parts: string[] = [];
  let first = '';
  if (input.bhkMin !== null || input.bhkMax !== null) {
    const lo = input.bhkMin ?? input.bhkMax;
    const hi = input.bhkMax ?? input.bhkMin;
    if (lo !== null && hi !== null) {
      first = lo === hi ? fmtBhk(lo) : `${lo === 0.5 ? '1 RK' : lo}–${fmtBhk(hi)}`;
    }
  }
  const types = input.propertyTypes.join(' / ');
  const lead = [first, types].filter(Boolean).join(' ');
  if (lead) parts.push(lead);
  parts.push(input.label);
  const place = input.locality ?? input.micromarket;
  if (place) parts.push(place);
  return parts.join(' · ');
}
