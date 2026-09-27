/**
 * Synthetic people and contacts. Never real personal data:
 *
 * - **Phones** use one fixed pattern: Indian mobile `L000NNNNNN` where the lead digit L is 9, 8, 7 or 6
 *   and is followed by three zeros, then six digits (E.164 `+91L000NNNNNN`). They pass Indian-mobile
 *   validation (10 digits, first digit 6–9) but are recognisable by `isSyntheticPhone`.
 *   Capacity 4,000,000 numbers. **Never dial or message them**: the pattern is a test convention,
 *   not a reserved range, so a real subscriber may hold a number of this shape.
 * - **Anonymised phones** (pilot anonymise switch, intake LLD §4.9): `+9100000` + 6 digits, which is
 *   never a valid Indian mobile. Also accepted by `isSyntheticPhone`.
 * - **Emails** only at `example.com` / `example.in` (RFC 2606 reserved names), and `example.invalid`
 *   for anonymised rows.
 * - **Names** are first × last combinations of two fixed generic lists.
 *
 * Person #i is the same in every dataset (independent of the seed), so two uploads generated with
 * different seeds share people, which exercises phone-based person dedup.
 */
import { FIRST_NAMES, LAST_NAMES, companyName } from './catalog.js';
import { hash32 } from './rng.js';

const LEAD_DIGITS = ['9', '8', '7', '6'] as const;
const BLOCK = 1_000_000;
/** Capacity of the synthetic phone scheme. */
export const SYNTHETIC_PHONE_CAPACITY = LEAD_DIGITS.length * BLOCK;
/** Max people so that a second phone (index + MAX_PEOPLE) never collides with a first phone. */
export const MAX_PEOPLE = SYNTHETIC_PHONE_CAPACITY / 2;

/** E.164 synthetic mobile for phone index n (0 ≤ n < 4,000,000). Bijective. */
export function syntheticPhone(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= SYNTHETIC_PHONE_CAPACITY) {
    throw new RangeError(`phone index ${n} outside 0..${SYNTHETIC_PHONE_CAPACITY - 1}`);
  }
  const lead = LEAD_DIGITS[Math.floor(n / BLOCK)] as string;
  // 7919 is coprime with 10^6, so this permutes 0..999999 (numbers do not look sequential).
  const local = ((n % BLOCK) * 7919 + 271828) % BLOCK;
  return `+91${lead}000${String(local).padStart(6, '0')}`;
}

/** Anonymised-style phone (intake anonymise switch): `+9100000` + 6 digits. */
export function anonymisedPhone(n: number): string {
  return `+9100000${String((n * 7919 + 314159) % BLOCK).padStart(6, '0')}`;
}

const SYNTHETIC_NATIONAL = /^[6-9]000\d{6}$/;
const ANONYMISED_E164 = /^\+9100000\d{6}$/;

/**
 * True when `value` is a phone of the synthetic scheme, in any common written form:
 * `+919000123456`, `+91 90001 23456`, `91-9000-123456`, `09000123456`, `9000123456`,
 * or the anonymised form `+9100000123456`.
 */
export function isSyntheticPhone(value: string): boolean {
  const compact = value.replace(/[\s\-().]/g, '');
  if (ANONYMISED_E164.test(compact)) return true;
  let digits = compact;
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return SYNTHETIC_NATIONAL.test(digits);
}

export const SYNTHETIC_EMAIL_DOMAINS = ['example.com', 'example.in', 'example.invalid'] as const;

/** True when the address is at one of the reserved example domains. */
export function isSyntheticEmail(value: string): boolean {
  const at = value.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = value.slice(at + 1).toLowerCase();
  return (SYNTHETIC_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

/**
 * Finds every Indian-mobile-looking number in free text (10 digits starting 6–9, optionally
 * with +91 / 91 / 0 prefix and spaces or dashes). Used by tests and pilot tooling to assert that
 * no non-synthetic number is present.
 */
export function findPhoneLikeNumbers(text: string): string[] {
  const matches = text.match(/\+9100000\d{6}|(?<!\d)(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}(?!\d)/g);
  return matches ?? [];
}

export interface SyntheticPerson {
  readonly index: number;
  readonly name: string;
  /** E.164, 1 or 2 numbers. */
  readonly phones: readonly string[];
  readonly email: string;
  /** Broker / agency style people carry a company. */
  readonly company: string | null;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '.');
}

/** Person #index (0 ≤ index < MAX_PEOPLE). Pure function of the index. */
export function syntheticPerson(index: number, anonymised = false): SyntheticPerson {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PEOPLE) {
    throw new RangeError(`person index ${index} outside 0..${MAX_PEOPLE - 1}`);
  }
  const h = hash32(`person:${index}`);
  const first = FIRST_NAMES[h % FIRST_NAMES.length] as string;
  const last = LAST_NAMES[Math.floor(h / FIRST_NAMES.length) % LAST_NAMES.length] as string;
  const name = `${first} ${last}`;
  const twoPhones = h % 5 === 0;
  const company = h % 10 < 4 ? companyName(h >>> 8) : null;
  if (anonymised) {
    // Anonymised values have 6 free digits only, so anonymised people carry one phone.
    const phones = [anonymisedPhone(index)];
    const hex = (hash32(`email:${index}`).toString(16) + h.toString(16)).padStart(10, '0').slice(0, 10);
    return { index, name, phones, email: `u${hex}@example.invalid`, company };
  }
  const phones = [syntheticPhone(index)];
  if (twoPhones) phones.push(syntheticPhone(index + MAX_PEOPLE));
  const domain = h % 3 === 0 ? 'example.in' : 'example.com';
  return { index, name, phones, email: `${slug(name)}${index}@${domain}`, company };
}

/** Consistent fake "other contact" value (anonymised form per intake LLD §4.9). */
export function anonymisedOtherContact(index: number): string {
  return `contact-${hash32(`other:${index}`).toString(16).padStart(8, '0')}`;
}

/** How a phone is written inside ad text (national, spaced, +91). */
export function phoneInText(e164: string, style: number): string {
  const national = e164.startsWith('+91') ? e164.slice(3) : e164;
  if (e164.startsWith('+9100000')) return e164;
  switch (style % 4) {
    case 0:
      return national;
    case 1:
      return `${national.slice(0, 5)} ${national.slice(5)}`;
    case 2:
      return `+91 ${national}`;
    default:
      return `${national.slice(0, 5)}-${national.slice(5)}`;
  }
}
