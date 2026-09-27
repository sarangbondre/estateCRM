import { describe, expect, it } from 'vitest';
import { containsContact, detect, hasResidualRisk, redact, restore } from '../src/index.js';
import { CLEAN_ADS, PII_ADS, type AdCase, type Pii } from './fixtures/ads.js';

const DEVANAGARI_ZERO = 0x0966;

/** ASCII digits, Devanagari digits read as ASCII, O/o read as zero, everything else dropped. */
function digitStream(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch >= '0' && ch <= '9') out += ch;
    else if (c >= DEVANAGARI_ZERO && c <= DEVANAGARI_ZERO + 9) out += String(c - DEVANAGARI_ZERO);
    else if (ch === 'O' || ch === 'o') out += '0';
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Describes how a PII value still shows in the output, or null when it is gone. */
function leak(out: string, pii: Pii): string | null {
  if (out.toLowerCase().includes(pii.value.toLowerCase())) return 'verbatim';
  const digits = digitStream(pii.value);
  if (digits.length >= 7) {
    // Strip separators from the output and look for the number's last 7 digits.
    const flat = digitStream(out.replace(/\[[A-Z]+_\d+\]/gu, ' '));
    if (flat.includes(digits.slice(-7))) return 'digits';
  }
  if (pii.kind === 'NAME') {
    for (const word of pii.value.split(/\s+/u)) {
      const w = word.replace(/\.$/u, '');
      if (w.length < 2) continue;
      if (new RegExp(`(^|[^\\p{L}])${escapeRe(w)}($|[^\\p{L}])`, 'iu').test(out)) return `word "${w}"`;
    }
  }
  if (pii.kind === 'UNIT') {
    for (const token of pii.value.match(/[A-Z]?\d+[A-Z]?/gu) ?? []) {
      if (new RegExp(`(^|[^\\w])${escapeRe(token)}($|[^\\w])`, 'u').test(out)) return `token "${token}"`;
    }
  }
  return null;
}

function failures(c: AdCase): string[] {
  const out = redact(c.text).text;
  const problems: string[] = [];
  for (const p of c.pii) {
    const how = leak(out, p);
    if (how !== null) problems.push(`${c.id} LEAK ${p.kind} (${how})\n  in:  ${c.text}\n  out: ${out}`);
  }
  for (const k of c.keep) {
    if (!out.includes(k)) problems.push(`${c.id} LOST "${k}"\n  in:  ${c.text}\n  out: ${out}`);
  }
  return problems;
}

describe('test set', () => {
  it('has at least 150 ads', () => {
    expect(PII_ADS.length + CLEAN_ADS.length).toBeGreaterThanOrEqual(150);
  });

  it('leaks nothing and keeps every listed non-PII token', () => {
    const problems = PII_ADS.flatMap(failures);
    expect(problems.join('\n')).toBe('');
  });

  it('leaves texts without personal data unchanged', () => {
    const changed = CLEAN_ADS.map((t) => [t, redact(t).text] as const).filter(([a, b]) => a !== b);
    expect(changed.map(([a, b]) => `in:  ${a}\nout: ${b}`).join('\n')).toBe('');
  });

  it('is idempotent: redacting the output again changes nothing', () => {
    for (const c of PII_ADS) {
      const once = redact(c.text).text;
      expect(redact(once).text, c.id).toBe(once);
      const angle = redact(c.text, { placeholderStyle: 'angle' }).text;
      expect(redact(angle, { placeholderStyle: 'angle' }).text, c.id).toBe(angle);
    }
  });

  it('passes the residual post-check for every PII ad without RERA ids or raw prices', () => {
    const uncertain = PII_ADS.filter((c) => redact(c.text).uncertain).map(
      (c) => `${c.id}: ${redact(c.text).text}`,
    );
    // "@ Rs 22/sqft" and "Contact @" keep an @; those correctly come back uncertain. Nothing else may.
    expect(uncertain.filter((u) => !u.includes('@'))).toEqual([]);
  });

  it('redacts 10,000 ads in well under 2 seconds', () => {
    const texts = Array.from({ length: 10_000 }, (_, i) => PII_ADS[i % PII_ADS.length]?.text ?? '');
    const t0 = performance.now();
    for (const t of texts) redact(t);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('redact', () => {
  it('numbers placeholders per kind and reuses them for the same value', () => {
    const r = redact('Call Sanjay 90000 01234 or 90000-01234, else Priya 80000 05678');
    expect(r.text).toBe('Call [NAME_1] [PHONE_1] or [PHONE_1], else [NAME_2] [PHONE_2]');
    expect(r.counts).toEqual({ PHONE: 3, EMAIL: 0, URL: 0, NAME: 2, UNIT: 0, ID: 0 });
    expect(r.uncertain).toBe(false);
  });

  it('supports the insight angle-bracket style', () => {
    expect(redact('owner Priya 80000 05678', { placeholderStyle: 'angle' }).text).toBe(
      'owner ⟨NAME_1⟩ ⟨PHONE_1⟩',
    );
  });

  it('keeps the mapping in memory and restores it', () => {
    const r = redact('Contact Sanjay at 90000 01234, flat 1203');
    expect(r.mapping.get('[PHONE_1]')).toBe('90000 01234');
    expect(r.mapping.get('[NAME_1]')).toBe('Sanjay');
    expect(r.mapping.get('[UNIT_1]')).toBe('1203');
    expect(restore('Open [UNIT_1] for [NAME_1] ([PHONE_1]); [PHONE_9] unknown', r.mapping)).toBe(
      'Open 1203 for Sanjay (90000 01234); [PHONE_9] unknown',
    );
    // A Map serialises to {} so accidental logging of the result does not leak values.
    expect(JSON.stringify(r)).not.toContain('90000');
  });

  it('continues numbering after placeholders already in the text', () => {
    expect(redact('[PHONE_1] and 90000 01234').text).toBe('[PHONE_1] and [PHONE_2]');
  });

  it('filters kinds', () => {
    const r = redact('Flat 1203, Sanjay 90000 01234', { kinds: ['PHONE'] });
    expect(r.text).toBe('Flat 1203, Sanjay [PHONE_1]');
  });

  it('never masks allow-listed terms as names', () => {
    expect(redact('Contact Rustomjee 90000 01234').text).toBe('Contact [NAME_1] [PHONE_1]');
    expect(redact('Contact Rustomjee 90000 01234', { allowTerms: ['Rustomjee'] }).text).toBe(
      'Contact Rustomjee [PHONE_1]',
    );
  });

  it('lets a replacer insert consistent fakes (intake anonymise)', () => {
    const r = redact('Sanjay 90000 01234', {
      replacer: (d, ph) => (d.kind === 'PHONE' ? '+9100000123456' : ph),
    });
    expect(r.text).toBe('[NAME_1] +9100000123456');
  });

  it('keeps RERA ids, pincodes, prices, areas, floors, dates and display codes', () => {
    const t =
      'RERA P51800012345, 400069, Rs 1.25 Cr, 4000 sqft, 12th floor, 31.12.2026, DEM-000127, da724e14fa03';
    expect(redact(t).text).toBe(t);
  });
});

describe('detect', () => {
  it('returns spans with offsets into the original text', () => {
    const t = 'संपर्क ९०००० ०१२३४';
    const [d] = detect(t);
    expect(d?.kind).toBe('PHONE');
    expect(t.slice(d?.start, d?.end)).toBe('९०००० ०१२३४');
  });
});

describe('hasResidualRisk (intake post-check)', () => {
  it('flags 7+ digit runs and @', () => {
    expect(hasResidualRisk('P51800012345')).toBe(true);
    expect(hasResidualRisk('mail me @ home')).toBe(true);
    expect(hasResidualRisk('९०००००१२३४')).toBe(true);
    expect(hasResidualRisk('2BHK 1.25 Cr [PHONE_1]')).toBe(false);
  });
});

describe('containsContact (web audit scrub)', () => {
  it('finds phones and e-mails only', () => {
    expect(containsContact('upload 42 rows')).toBe(false);
    expect(containsContact('x 90000 01234')).toBe(true);
    expect(containsContact('a.b@example.com')).toBe(true);
    expect(containsContact('Contact Sanjay')).toBe(false);
  });
});
