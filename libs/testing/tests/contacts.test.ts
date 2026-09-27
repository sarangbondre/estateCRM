import { describe, expect, it } from 'vitest';
import {
  MAX_PEOPLE,
  PII_COLUMNS,
  SYNTHETIC_PHONE_CAPACITY,
  anonymisedPhone,
  findPhoneLikeNumbers,
  generate,
  isSyntheticEmail,
  isSyntheticPhone,
  syntheticPerson,
  syntheticPhone,
  type ExtractorRow,
} from '../src/index.js';

/** Indian mobile validation as intake applies it: +91 and 10 digits starting 6–9. */
const INDIAN_MOBILE_E164 = /^\+91[6-9]\d{9}$/;

function phonesOf(row: ExtractorRow): string[] {
  const out: string[] = [];
  for (const column of ['phones', 'whatsapp_phone', 'sender_phone'] as const) {
    const value = row[column];
    if (typeof value === 'string') out.push(...value.split('|'));
  }
  return out;
}

/** Text cells, without the 12-hex id columns (an id can contain a run of ten digits). */
function textCells(row: ExtractorRow): string[] {
  const ids = ['record_id', 'parent_record_id', 'possible_repeat_of'];
  return Object.entries(row)
    .filter(([column]) => !ids.includes(column))
    .map(([, value]) => value)
    .filter((v): v is string => typeof v === 'string');
}

describe('synthetic phone scheme', () => {
  it('produces valid Indian mobiles of the reserved-looking L000NNNNNN shape', () => {
    for (const n of [0, 1, 2, 999_999, 1_000_000, 2_500_000, SYNTHETIC_PHONE_CAPACITY - 1]) {
      const phone = syntheticPhone(n);
      expect(phone).toMatch(INDIAN_MOBILE_E164);
      expect(phone).toMatch(/^\+91[6-9]000\d{6}$/);
      expect(isSyntheticPhone(phone)).toBe(true);
    }
    expect(() => syntheticPhone(SYNTHETIC_PHONE_CAPACITY)).toThrow(RangeError);
  });

  it('is a bijection over a large block (no two indexes share a number)', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 200_000; n += 1) seen.add(syntheticPhone(n * 20));
    expect(seen.size).toBe(200_000);
  });

  it('recognises written variants and rejects ordinary numbers', () => {
    for (const variant of [
      '+919000123456',
      '+91 90001 23456',
      '91-9000-123456',
      '09000123456',
      '9000123456',
      '+9100000123456',
    ]) {
      expect(isSyntheticPhone(variant)).toBe(true);
    }
    for (const other of ['+919820012345', '9876543210', '+917001234567', '12345', '+91 22 2345 6789', '']) {
      expect(isSyntheticPhone(other)).toBe(false);
    }
  });

  it('anonymised phones are never valid Indian mobiles but are recognised', () => {
    const phone = anonymisedPhone(123);
    expect(phone).toMatch(/^\+9100000\d{6}$/);
    expect(phone).not.toMatch(INDIAN_MOBILE_E164);
    expect(isSyntheticPhone(phone)).toBe(true);
  });

  it('finds phone-like numbers in text', () => {
    expect(findPhoneLikeNumbers('Call 90001 23456 or +91 9876543210, flat 12, Rs 3,25,00,000')).toEqual([
      '90001 23456',
      '+91 9876543210',
    ]);
  });
});

describe('synthetic people', () => {
  it('are a pure function of the index', () => {
    expect(syntheticPerson(42)).toEqual(syntheticPerson(42));
    expect(syntheticPerson(42).phones[0]).not.toBe(syntheticPerson(43).phones[0]);
    expect(() => syntheticPerson(MAX_PEOPLE)).toThrow(RangeError);
  });

  it('second phones never collide with first phones', () => {
    const firsts = new Set<string>();
    const seconds: string[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      const p = syntheticPerson(i);
      firsts.add(p.phones[0] as string);
      if (p.phones[1] !== undefined) seconds.push(p.phones[1]);
    }
    expect(seconds.length).toBeGreaterThan(0);
    expect(seconds.filter((s) => firsts.has(s))).toEqual([]);
  });

  it('emails use only reserved example domains', () => {
    for (let i = 0; i < 1_000; i += 1) {
      expect(isSyntheticEmail(syntheticPerson(i).email)).toBe(true);
      expect(syntheticPerson(i, true).email).toMatch(/^u[0-9a-f]{10}@example\.invalid$/);
    }
    expect(isSyntheticEmail('someone@gmail.com')).toBe(false);
    expect(isSyntheticEmail('someone@example.com.evil.io')).toBe(false);
  });
});

describe('generated datasets contain synthetic contacts only', () => {
  const records = generate({ rows: 20_000, seed: 21, whatsappRate: 0.2, invalidPhoneRate: 0.01 });

  it('every phone column value is synthetic (except injected invalid-phone warnings)', () => {
    const bad = records
      .filter((r) => r.meta.warning === null)
      .flatMap((r) => phonesOf(r.row))
      .filter((p) => !isSyntheticPhone(p));
    expect(bad).toEqual([]);
    expect(records.some((r) => r.row.sender_phone !== null)).toBe(true);
  });

  it('every email is at an example domain', () => {
    const emails = records.flatMap((r) => (typeof r.row.emails === 'string' ? r.row.emails.split('|') : []));
    expect(emails.length).toBeGreaterThan(100);
    expect(emails.filter((e) => !isSyntheticEmail(e))).toEqual([]);
  });

  it('no phone-like number anywhere in any text cell is non-synthetic', () => {
    const bad = records
      .flatMap((r) => textCells(r.row).flatMap(findPhoneLikeNumbers))
      .filter((p) => !isSyntheticPhone(p));
    expect(bad).toEqual([]);
  });

  it('no email-like text anywhere is outside the example domains', () => {
    const bad = records
      .flatMap((r) => textCells(r.row).flatMap((t) => t.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []))
      .filter((e) => !isSyntheticEmail(e));
    expect(bad).toEqual([]);
  });

  it('anonymised datasets use the intake anonymised forms in every PII column', () => {
    const anon = generate({ rows: 3_000, seed: 3, anonymised: true, whatsappRate: 0.3 });
    for (const { row } of anon) {
      for (const phone of phonesOf(row)) expect(phone).toMatch(/^\+9100000\d{6}$/);
      if (typeof row.emails === 'string') expect(row.emails).toMatch(/@example\.invalid$/);
      if (typeof row.other_contact === 'string') expect(row.other_contact).toMatch(/^contact-[0-9a-f]{8}$/);
      for (const column of PII_COLUMNS) {
        const value = row[column];
        if (typeof value === 'string') {
          expect(findPhoneLikeNumbers(value).every((p) => /^\+9100000\d{6}$/.test(p))).toBe(true);
        }
      }
    }
  });
});
