import { ciAlt, ci } from './regex-util.js';
import { spansOf, type Span } from './span.js';

/** Words that introduce a unit, shop, plot or land-parcel identifier. */
const UNIT_WORDS = [
  'flat',
  'flt',
  'apt',
  'apartment',
  'unit',
  'shop',
  'office',
  'off.',
  'gala',
  'godown',
  'room',
  'rm',
  'plot',
  'bungalow',
  'villa',
  'row house',
  'rowhouse',
  'showroom',
  'block',
  'door',
  'house',
  'survey',
  's. no',
  's.no',
  'sr. no',
  'sr.no',
  'cts',
  'gat',
  'hissa',
  'khasra',
  'khata',
  'property card',
  'premises',
  'industrial unit',
  'gala no',
];

/** Identifier after a unit word: "1203", "A-1203", "B/702", "405-B", "12/3", "G 12". */
const ID = String.raw`(?:[A-Z]{1,2}\s?[-/]?\s?)?\d{1,5}(?:\s?[-/]\s?[A-Z0-9]{1,4})*[A-JM-Z]?`;
/** The number is an area, price, count, floor or distance, not an identifier. */
const UNIT_PREFIXES = [
  'sq',
  'sft',
  'ft',
  'feet',
  'bhk',
  'acre',
  'guntha',
  'gunta',
  'bigha',
  'hect',
  'crore',
  'lakh',
  'lac',
];
const UNIT_WORDS_AFTER = [
  'rk',
  'cr',
  'floor',
  'floors',
  'storey',
  'storeys',
  'min',
  'mins',
  'km',
  'kms',
  'yr',
  'yrs',
  'year',
  'years',
  'months',
  'seater',
  'seats',
  'cars',
  'nos',
  'units',
  'shops',
  'flats',
  'offices',
  'rooms',
  'mtr',
  'm',
  'l',
  'k',
  'x',
  'am',
  'pm',
];
const NOT_ID_AFTER = String.raw`(?!\s*(?:${ciAlt(UNIT_PREFIXES)})|\s*(?:${ciAlt(UNIT_WORDS_AFTER)})\b|\s*[%+]|\s*\/-|[.,]\d|\s?[-–/]\s?\d)`;
const NO = String.raw`(?:${ciAlt(['no.', 'no', 'nos.', 'number', 'num'])}|#)`;

/** "Flat 1203", "Shop No. 5", "Office #405", "Survey No. 45/2", "Gala no: 12". */
const UNIT_KEYWORD = new RegExp(
  String.raw`\b(?:${ciAlt(UNIT_WORDS)})\b\.?\s*(?:${NO}\s*)?[:.\-]{0,3}\s*(?<v>${ID})\b${NOT_ID_AFTER}`,
  'gdu',
);
/** Bare "No. 12" / "No 7-B". */
const UNIT_NO = new RegExp(String.raw`(?<![\w])${NO}\s*[:.\-]{0,3}\s*(?<v>${ID})\b${NOT_ID_AFTER}`, 'gdu');
/** "A Wing", "B-wing 702", "Wing C", "Wing B 702". */
const WING = new RegExp(
  String.raw`\b(?:[A-Z]\s?-?\s?${ci('wing')}|${ci('wing')}\s*[:\-]?\s*[A-Z])\b(?:\s*[,/-]?\s*(?:${ciAlt(['flat', 'unit', 'office', 'shop'])}\s*)?(?:${NO}\s*)?\d{1,4}\b${NOT_ID_AFTER})?`,
  'gu',
);
/** Letter-dash-number: "A-1203", "B/702", "G-12". Road, state and phase codes are excluded. */
const LETTER_DASH = new RegExp(
  String.raw`(?<![\w/-])(?!(?:NH|SH|MH|GJ|DL|KA|UP|NA|TP|FP|PH|RK|EL|GF|UG|LG|IT|SEZ)\b)(?<v>[A-Z]{1,2}\s?[-/]\s?\d{1,4}[A-Z]?)\b(?![-/]\d)${NOT_ID_AFTER}`,
  'gdu',
);
/** Address-leading unit number: "1203, Sai Krupa CHS", "302, A Wing". */
const LEADING_NUMBER = new RegExp(
  String.raw`(?<![\w.,/-])(?<v>\d{1,4}[A-Z]?)\s*,\s*(?=[A-Z]\s?-?\s?${ci('wing')}\b|(?:[A-Z][a-z]+\s+){1,3}(?:CHS|Society|Soc|Tower|Towers|Heights|Apartment|Apartments|Apts|Bldg|Building|Plaza|Chambers|Complex|Residency|Enclave|Arcade|Centre|Center|Bhavan|Bhawan|Niwas|Nivas|Sadan|Park|Mansion|Court|Palace|Estate|House)\b)`,
  'gdu',
);

export function detectUnits(text: string): Span[] {
  return [
    ...spansOf(text, UNIT_KEYWORD, 'UNIT'),
    ...spansOf(text, UNIT_NO, 'UNIT'),
    ...spansOf(text, WING, 'UNIT'),
    ...spansOf(text, LETTER_DASH, 'UNIT'),
    ...spansOf(text, LEADING_NUMBER, 'UNIT'),
  ];
}
