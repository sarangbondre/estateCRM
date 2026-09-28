// Pilot anonymise-on-import (CR-006 Z-9, LLD §4.9). Pure: the keyed hash (HMAC-SHA256 with the tenant's
// anonymisation key) is injected. The same input always gives the same fake in every upload, so phone-based person
// dedup in records keeps working. Phones become `+9100000nnnnnn` (never a valid Indian mobile), names come from fixed
// generic lists, e-mails `u<10 hex>@example.invalid`, other contacts `contact-<8 hex>`. Free-text columns go through the
// redaction detectors and each detected contact is replaced by its consistent fake. company_name, rera_number and all
// non-contact columns are kept.
import { redact } from '@11e/redaction';
import type { Detection } from '@11e/redaction';
import { phone as toE164 } from './cells.js';

/** kind + normalised value → hex digest (HMAC-SHA256 with the tenant key). */
export type KeyedHash = (input: string) => string;

const FIRST = [
  'Aarav',
  'Vivaan',
  'Aditya',
  'Vihaan',
  'Arjun',
  'Sai',
  'Reyansh',
  'Ishaan',
  'Kabir',
  'Anaya',
  'Diya',
  'Saanvi',
  'Aadhya',
  'Kiara',
  'Myra',
  'Ira',
  'Meera',
  'Riya',
  'Tara',
  'Neel',
];
const LAST = ['Rao', 'Iyer', 'Kulkarni', 'Deshpande', 'Menon', 'Pillai', 'Joshi', 'Kapoor', 'Mehta', 'Shah', 'Patil', 'Naik', 'Gupta', 'Verma', 'Bose', 'Sen', 'Reddy', 'Chauhan', 'Bhat', 'Kamath']; // prettier-ignore

/** Columns whose whole value is one kind of contact. */
const CONTACT_COLUMNS: Readonly<Record<string, 'phones' | 'phone' | 'name' | 'emails' | 'other'>> = {
  contact_name: 'name',
  sender_name: 'name',
  phones: 'phones',
  whatsapp_phone: 'phone',
  sender_phone: 'phone',
  emails: 'emails',
  other_contact: 'other',
};

/** Free-text columns scanned with the redaction detectors. */
const TEXT_COLUMNS = new Set([
  'raw_text',
  'text_variants',
  'side_evidence',
  'business_description',
  'extractor_notes',
  'location_text',
  'landmark',
  'enquiry_message',
  'free_text',
  'crm_notes',
  'review_reason',
  'features',
]);

export class Anonymiser {
  constructor(private readonly hash: KeyedHash) {}

  phone(raw: string): string {
    const key = toE164(raw) ?? raw.replace(/\D/g, '');
    const n = parseInt(this.hash(`phone:${key}`).slice(0, 12), 16) % 1_000_000;
    return `+9100000${String(n).padStart(6, '0')}`;
  }

  /**
   * A phone column value: unreadable values are not turned into valid-looking fakes (validation must still flag them
   * as invalid-phone); they become `contact-<hex>` like other contacts.
   */
  phoneCell(raw: string): string {
    return toE164(raw) ? this.phone(raw) : this.other(raw);
  }

  name(raw: string): string {
    const h = this.hash(`name:${raw.trim().toLowerCase().replace(/\s+/g, ' ')}`);
    return `${FIRST[parseInt(h.slice(0, 8), 16) % FIRST.length]} ${LAST[parseInt(h.slice(8, 16), 16) % LAST.length]}`;
  }

  email(raw: string): string {
    return `u${this.hash(`email:${raw.trim().toLowerCase()}`).slice(0, 10)}@example.invalid`;
  }

  other(raw: string): string {
    return `contact-${this.hash(`other:${raw.trim().toLowerCase()}`).slice(0, 8)}`;
  }

  /** Replaces every detected contact in free text by its consistent fake. */
  text(raw: string): string {
    return redact(raw, {
      kinds: ['PHONE', 'EMAIL', 'URL', 'NAME', 'ID'],
      replacer: (d: Detection) => {
        switch (d.kind) {
          case 'PHONE':
            return this.phone(d.value);
          case 'EMAIL':
            return this.email(
              d.value
                .replace(/\s*(\[at\]|\(at\)|\{at\}| at )\s*/gi, '@')
                .replace(/\s*(\[dot\]| dot )\s*/gi, '.'),
            );
          case 'NAME':
            return this.name(d.value);
          default:
            return this.other(d.value);
        }
      },
    }).text;
  }

  /** One cell of a column mapped to `target` (null = unmapped column, kept as is). */
  cell(target: string | null, value: string | null): string | null {
    if (value === null || value.trim() === '') return value;
    // an unmapped column may still hold contacts: scan it like free text
    if (target === null) return this.text(value);
    const kind = CONTACT_COLUMNS[target];
    const list = (fn: (s: string) => string) =>
      value
        .split('|')
        .map((p) => (p.trim() ? fn(p.trim()) : p))
        .join('|');
    switch (kind) {
      case 'phones':
        return list((p) => this.phoneCell(p));
      case 'phone':
        return this.phoneCell(value);
      case 'name':
        return this.name(value);
      case 'emails':
        return list((e) => this.email(e));
      case 'other':
        return this.other(value);
      default:
        return TEXT_COLUMNS.has(target) ? this.text(value) : value;
    }
  }

  /**
   * One row. Contacts found in the contact columns are also replaced wherever they appear verbatim in the row's
   * free text (the detectors miss names without a cue, e.g. "Contact: Acme Realty, Farhan More, …").
   */
  row(targets: readonly (string | null)[], cells: readonly (string | null)[]): (string | null)[] {
    const known: [string, string][] = [];
    cells.forEach((v, i) => {
      const kind = CONTACT_COLUMNS[targets[i] ?? ''];
      if (!v || !kind) return;
      for (const part of kind === 'phones' || kind === 'emails' ? v.split('|') : [v]) {
        const p = part.trim();
        if (p.length < 3) continue;
        const fake =
          kind === 'name'
            ? this.name(p)
            : kind === 'emails'
              ? this.email(p)
              : kind === 'other'
                ? this.other(p)
                : this.phoneCell(p);
        known.push([p, fake]);
      }
    });
    known.sort((a, b) => b[0].length - a[0].length);
    return cells.map((v, i) => {
      const target = targets[i] ?? null;
      if (v === null || (target !== null && CONTACT_COLUMNS[target])) return this.cell(target, v);
      if (target !== null && !TEXT_COLUMNS.has(target)) return v;
      let text = v;
      for (const [orig, fake] of known) text = replaceLiteral(text, orig, fake);
      return this.cell(target, text);
    });
  }
}

function replaceLiteral(text: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), () => replacement);
}
