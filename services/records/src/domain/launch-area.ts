// Outside-launch-area flag (records LLD §4.9, CR-006 Z-7, R-9).
import { norm } from './text.js';

export interface LocationFacts {
  city: string | null;
  /** extractor source_edition (e.g. "Mumbai"); only used when the city is blank (R-9). */
  sourceEdition?: string | null;
  /** The locality resolved to a micromarket node; its in_launch_area flag. Undefined when unresolved. */
  resolvedInLaunchArea?: boolean | undefined;
}

export interface LaunchAreaVerdict {
  outside: boolean;
  /** City blank and nothing else places the record: needs review "location unclear" (R-9). */
  locationUnclear: boolean;
}

export function launchAreaVerdict(facts: LocationFacts, enabledCities: ReadonlySet<string>): LaunchAreaVerdict {
  const city = norm(facts.city);
  if (city !== null) return { outside: !enabledCities.has(city), locationUnclear: false };
  if (norm(facts.sourceEdition) === 'mumbai') return { outside: false, locationUnclear: false };
  if (facts.resolvedInLaunchArea !== undefined) return { outside: !facts.resolvedInLaunchArea, locationUnclear: false };
  return { outside: false, locationUnclear: true };
}

/** A demand is outside only when every stated place is outside (unresolved places count as inside). */
export function demandOutside(places: readonly { inLaunchArea: boolean | undefined }[]): boolean {
  return places.length > 0 && places.every((p) => p.inLaunchArea === false);
}

export const LOCATION_UNCLEAR_REASON = 'location unclear';

/** Initial enabled list (LLD §4.9): Mumbai, Navi Mumbai, Thane and the MMR municipal areas. */
export const INITIAL_LAUNCH_CITIES: readonly string[] = [
  'Mumbai',
  'Navi Mumbai',
  'Thane',
  'Kalyan',
  'Dombivli',
  'Ulhasnagar',
  'Bhiwandi',
  'Ambernath',
  'Badlapur',
  'Mira Bhayandar',
  'Mira Road',
  'Bhayandar',
  'Vasai',
  'Virar',
  'Panvel',
  'Uran',
  'Karjat',
  'Khopoli',
  'Pen',
  'Alibag',
  'Matheran',
];
