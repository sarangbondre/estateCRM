// Rules classifier for free text (LLD §4.7 step 5, §4.12): side phrases (with the phrase as side_evidence), scope cues,
// deal type, property type, BHK, area (→ sq ft) and price (L / lakh / Cr / k → INR) extractors. Side is inferred last
// (BRD order). Pure and deterministic; the model only sees what these rules leave blank.
import { canonicalValue, segmentOfPropertyType } from '@11e/vocabulary';
import type { DealType, PropertyType, RecordScope, Segment, Side } from '@11e/vocabulary';

export interface TextClassification {
  recordScope: RecordScope | null;
  dealTypes: DealType[];
  segment: Segment | null;
  propertyTypes: PropertyType[];
  side: Side | null;
  sideEvidence: string | null;
  bhkMin: number | null;
  bhkMax: number | null;
  areaSqftMin: number | null;
  areaSqftMax: number | null;
  salePriceInrMin: number | null;
  salePriceInrMax: number | null;
  rentMonthlyInrMin: number | null;
  rentMonthlyInrMax: number | null;
  furnishing: string | null;
  tenancyStatus: string | null;
  saleMode: string | null;
}

const DEMAND_PHRASES = [
  'looking for',
  'required',
  'requirement',
  'wanted',
  'want to buy',
  'want to rent',
  'wants',
  'need',
  'needed',
  'buyer',
  'tenant wanted',
  'seeking',
];
const SUPPLY_PHRASES = [
  'available',
  'for sale',
  'on rent',
  'for rent',
  'to let',
  'on lease',
  'for lease',
  'lease out',
  'resale',
  'selling',
  'sale',
  'auction',
];

const SCOPE_CUES: readonly (readonly [RecordScope, RegExp])[] = [
  [
    'Market Signal',
    /\b(tender|public notice|title notice|redevelopment (?:proposal|upcoming)|land policy)\b/i,
  ],
  ['Capital', /\b(loan book|funding|investor|equity|debt|finance required)\b/i],
  ['Equipment', /\b(machinery|machines?|equipment|generator|forklift)\b/i],
  [
    'Business',
    /\b(running business|business for sale|franchise|restaurant business|running (?:hotel|restaurant|school))\b/i,
  ],
  ['Market Participant', /\b(broker services|brokerage services|consultancy|architects?|pmc services)\b/i],
];

const DEAL_CUES: readonly (readonly [DealType, RegExp])[] = [
  ['Sale', /\b(sale|sell|selling|resale|buy|purchase|outright|auction)\b/i],
  ['Lease', /\b(rent|rental|lease|leave and licen[cs]e|l\s*&\s*l|to let)\b/i],
  ['JV', /\b(jv|joint venture|joint development|redevelopment|development rights)\b/i],
  ['Pagdi', /\b(pagdi|pagadi|pagri)\b/i],
];

/** Words → property type (canonical names are matched as well). */
const TYPE_WORDS: readonly (readonly [RegExp, PropertyType])[] = [
  [/\b(\d+(?:\.5)?\s*bhk|flats?|apartments?)\b/i, 'Apartment'],
  [/\b(1\s*rk|studio)\b/i, 'Studio'],
  [/\bpenthouses?\b/i, 'Penthouse'],
  [/\b(villas?)\b/i, 'Villa'],
  [/\bbungalows?\b/i, 'Bungalow'],
  [/\brow ?houses?\b/i, 'Row House'],
  [/\bfarm ?houses?\b/i, 'Farmhouse'],
  [/\b(offices?|office space)\b/i, 'Office'],
  [/\bshowrooms?\b/i, 'Showroom'],
  [/\bshops?\b/i, 'Shop'],
  [/\bco-?working\b/i, 'Coworking'],
  [/\bhotels?\b/i, 'Hotel'],
  [/\bwarehouses?|godowns?\b/i, 'Warehouse'],
  [/\bgalas?\b/i, 'Gala'],
  [/\bsheds?\b/i, 'Shed'],
  [/\bfactor(?:y|ies)\b/i, 'Factory'],
  [/\bagricultural land|farm land\b/i, 'Agricultural Land'],
  [/\bplots?\b/i, 'Plot'],
  [/\bland\b/i, 'Land Parcel'],
  [/\bcommercial space|commercial premises\b/i, 'Commercial Space'],
];

const UNIT_TO_SQFT: Record<string, number> = {
  sqft: 1,
  sqm: 10.7639,
  sqyd: 9,
  acre: 43_560,
  gunta: 1_089,
  bigha: 27_000,
};

function unitKey(u: string): string | undefined {
  const s = u.toLowerCase().replace(/[\s.]/g, '');
  if (/^(sq(uare)?f(ee)?t|sqft|sft|ft2|sqfeet)$/.test(s)) return 'sqft';
  if (/^(sq(uare)?m(t|tr|etre|eter|eters|etres)?|sqm|m2)$/.test(s)) return 'sqm';
  if (/^(sq(uare)?y(ar)?d(s)?|sqyd|sqyds)$/.test(s)) return 'sqyd';
  if (/^acres?$/.test(s)) return 'acre';
  if (/^(gunt(h)?as?)$/.test(s)) return 'gunta';
  if (/^bighas?$/.test(s)) return 'bigha';
  return undefined;
}

const num = (s: string) => Number(s.replace(/,/g, ''));

export function extractBhk(text: string): { min: number; max: number } | null {
  if (/\b1\s*rk\b/i.test(text)) return { min: 0.5, max: 0.5 };
  const m = /\b(\d(?:\.5)?)\s*(?:(?:-|to|\/|or)\s*(\d(?:\.5)?)\s*)?bhk\b/i.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

export function extractArea(text: string): { min: number; max: number } | null {
  const re =
    /(\d[\d,]*(?:\.\d+)?)\s*(?:(?:-|to)\s*(\d[\d,]*(?:\.\d+)?)\s*)?(sq\.?\s*(?:ft|feet|mt|mtr|m|yd|yds|yards?|metres?|meters?)\.?|sqft|sft|sqm|sqyd|acres?|gunt?has?|bighas?)/i;
  const m = re.exec(text);
  if (!m) return null;
  const unit = unitKey(m[3] ?? '');
  if (!unit) return null;
  const f = UNIT_TO_SQFT[unit] as number;
  const a = Math.round(num(m[1] as string) * f);
  const b = m[2] ? Math.round(num(m[2]) * f) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function amount(value: string, unit: string | undefined): number | null {
  const v = num(value);
  if (!Number.isFinite(v)) return null;
  const u = (unit ?? '').toLowerCase().replace(/\./g, '');
  if (/^(cr|crs|crore|crores)$/.test(u)) return Math.round(v * 10_000_000);
  if (/^(l|lac|lacs|lakh|lakhs)$/.test(u)) return Math.round(v * 100_000);
  if (/^(k|thousand)$/.test(u)) return Math.round(v * 1_000);
  return v >= 1_000 ? Math.round(v) : null;
}

/** Prices: "1.8 Cr", "45L", "Rs 72,00,000", "1.2-1.5 Cr"; rent when "rent"/"pm"/"per month" is near. */
export function extractPrice(text: string): { kind: 'sale' | 'rent'; min: number; max: number } | null {
  const re =
    /(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?)\s*(cr(?:ores?|s)?|l(?:akhs?|acs?)?|k|thousand)?\.?\s*(?:(?:-|to)\s*(\d[\d,]*(?:\.\d+)?)\s*(cr(?:ores?|s)?|l(?:akhs?|acs?)?|k|thousand)?)?(?![\d\w])/gi;
  for (const m of text.matchAll(re)) {
    const unit1 = m[2];
    const unit2 = m[4] ?? unit1;
    const hasCurrency = /rs|inr|₹/i.test(m[0]);
    if (!unit1 && !unit2 && !hasCurrency) continue;
    const a = amount(m[1] as string, unit1 ?? unit2);
    const b = m[3] ? amount(m[3], unit2) : a;
    if (a === null || b === null) continue;
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 20).toLowerCase();
    const before = text.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0).toLowerCase();
    const rent = /\b(p\.?m\.?|per month|\/\s*month|monthly|pm)\b/.test(after) || /\brent\b/.test(before);
    return { kind: rent ? 'rent' : 'sale', min: Math.min(a, b), max: Math.max(a, b) };
  }
  return null;
}

function phraseIn(text: string, phrases: readonly string[]): string | null {
  const lower = text.toLowerCase();
  let best: { i: number; p: string } | null = null;
  for (const p of phrases) {
    const m = new RegExp(`\\b${p.replace(/ /g, '\\s+')}\\b`, 'i').exec(lower);
    if (m && (best === null || m.index < best.i)) best = { i: m.index, p: m[0] };
  }
  return best?.p ?? null;
}

/** Demand cues win over supply cues ("required on rent" is a demand). */
export function extractSide(text: string): { side: Side; evidence: string } | null {
  const demand = phraseIn(text, DEMAND_PHRASES);
  if (demand) return { side: 'Demand', evidence: demand };
  const supply = phraseIn(text, SUPPLY_PHRASES);
  return supply ? { side: 'Supply', evidence: supply } : null;
}

export function extractScope(text: string): RecordScope | null {
  for (const [scope, re] of SCOPE_CUES) if (re.test(text)) return scope;
  return null;
}

export function extractPropertyType(text: string): PropertyType | null {
  for (const [re, type] of TYPE_WORDS) if (re.test(text)) return type;
  return null;
}

export function classifyText(text: string | null | undefined): TextClassification {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  const empty: TextClassification = {
    recordScope: null,
    dealTypes: [],
    segment: null,
    propertyTypes: [],
    side: null,
    sideEvidence: null,
    bhkMin: null,
    bhkMax: null,
    areaSqftMin: null,
    areaSqftMax: null,
    salePriceInrMin: null,
    salePriceInrMax: null,
    rentMonthlyInrMin: null,
    rentMonthlyInrMax: null,
    furnishing: null,
    tenancyStatus: null,
    saleMode: null,
  };
  if (!s) return empty;
  const out = { ...empty };
  const propertyType = extractPropertyType(s);
  const bhk = extractBhk(s);
  const area = extractArea(s);
  out.recordScope = extractScope(s) ?? (propertyType || bhk || area ? 'Property' : null);
  out.dealTypes = DEAL_CUES.filter(([, re]) => re.test(s)).map(([d]) => d);
  if (out.recordScope === 'Property' && propertyType) {
    out.propertyTypes = [propertyType];
    out.segment = segmentOfPropertyType(propertyType);
  }
  if (bhk) [out.bhkMin, out.bhkMax] = [bhk.min, bhk.max];
  if (area) [out.areaSqftMin, out.areaSqftMax] = [area.min, area.max];
  const price = extractPrice(s);
  if (price?.kind === 'sale') [out.salePriceInrMin, out.salePriceInrMax] = [price.min, price.max];
  if (price?.kind === 'rent') [out.rentMonthlyInrMin, out.rentMonthlyInrMax] = [price.min, price.max];
  const furnishing = /\b(semi[\s-]?furnished|unfurnished|fully furnished|furnished|bare shell)\b/i.exec(
    s,
  )?.[1];
  if (furnishing) {
    const f = furnishing.toLowerCase().replace(/-/g, ' ').replace('fully ', '');
    out.furnishing = canonicalValue('furnishing', f) ?? null;
  }
  if (/\bpre-?leased|tenanted\b/i.test(s)) out.tenancyStatus = 'Tenanted';
  if (/\bauction\b/i.test(s)) out.saleMode = 'Auction';
  if (out.recordScope === 'Market Participant' || out.recordScope === 'Market Signal') {
    out.side = 'None';
    out.dealTypes = [];
  } else {
    const side = extractSide(s);
    if (side) [out.side, out.sideEvidence] = [side.side, side.evidence];
  }
  return out;
}
