// Cell parsers for the upload schema (LLD §4.4): booleans, integers, numbers, dates, possession dates, phones (E.164,
// +91 default), e-mails, and the blank / placeholder rule. Pure functions; expected bad input never throws.

export type Parsed<T> = { ok: true; value: T | null } | { ok: false };

const ok = <T>(value: T | null): Parsed<T> => ({ ok: true, value });
const bad: { ok: false } = { ok: false };

/** Blank cell (null, empty or whitespace). */
export const isEmpty = (raw: string | null | undefined): raw is null | undefined | '' =>
  raw === null || raw === undefined || raw.trim() === '';

const PLACEHOLDERS = new Set(['unknown', 'na', 'n/a', '-', '--', 'nil', 'null', 'none']);

/** Placeholder text in a non-controlled field ("Unknown", "NA", "-") means blank (BRD: blank = unknown). */
export function isPlaceholder(raw: string): boolean {
  return PLACEHOLDERS.has(raw.trim().toLowerCase());
}

export function text(raw: string | null | undefined): string | null {
  if (isEmpty(raw)) return null;
  const t = raw.trim();
  return isPlaceholder(t) ? null : t;
}

export function bool(raw: string | null | undefined, lenient = false): Parsed<boolean> {
  if (isEmpty(raw)) return ok(null);
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return ok(true);
  if (v === 'false' || v === '0') return ok(false);
  if (lenient && ['yes', 'y'].includes(v)) return ok(true);
  if (lenient && ['no', 'n'].includes(v)) return ok(false);
  return bad;
}

const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i;

export function num(raw: string | null | undefined): Parsed<number> {
  if (isEmpty(raw)) return ok(null);
  const v = raw.trim().replace(/,/g, '');
  if (!NUMERIC.test(v)) return bad;
  const n = Number(v);
  return Number.isFinite(n) ? ok(n) : bad;
}

export function int(raw: string | null | undefined): Parsed<number> {
  const n = num(raw);
  if (!n.ok || n.value === null) return n;
  return Number.isInteger(n.value) ? n : bad;
}

const isValidDate = (y: number, m: number, d: number) => {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Excel serial (1900 system) → ISO date. */
function fromSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 120_000) return null;
  const ms = Math.round((serial - 25_569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * ISO `YYYY-MM-DD` (optionally followed by a time, as Excel exports "2026-07-06 00:00:00"), or an Excel serial.
 * `lenient` (mapping mode) also accepts `DD/MM/YYYY` and `DD-MM-YYYY` (Indian order).
 */
export function date(raw: string | null | undefined, lenient = false): Parsed<string> {
  if (isEmpty(raw)) return ok(null);
  const v = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isValidDate(y, mo, d) ? ok(iso(y, mo, d)) : bad;
  }
  if (/^\d+(\.\d+)?$/.test(v)) {
    const s = fromSerial(Number(v));
    return s ? ok(s) : bad;
  }
  if (lenient) {
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
    if (m) {
      const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return isValidDate(y, mo, d) ? ok(iso(y, mo, d)) : bad;
    }
  }
  return bad;
}

/** Date-time (mapping target enquiry_received_at): ISO date-time, or a date at 00:00 UTC. */
export function dateTime(raw: string | null | undefined, lenient = true): Parsed<string> {
  if (isEmpty(raw)) return ok(null);
  const v = raw.trim();
  const t = Date.parse(v.includes('T') || v.includes(' ') ? v.replace(' ', 'T') : '');
  if (Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}/.test(v)) return ok(new Date(t).toISOString());
  const d = date(v, lenient);
  return d.ok && d.value ? ok(`${d.value}T00:00:00.000Z`) : d.ok ? ok(null) : bad;
}

/** `possession_date`: YYYY, YYYY-MM or YYYY-MM-DD (Appendix C). */
export function possessionDate(raw: string | null | undefined): Parsed<string> {
  if (isEmpty(raw)) return ok(null);
  const v = raw.trim().replace(/ 00:00:00$/, '');
  if (/^\d{4}$/.test(v)) return ok(v);
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? ok(v) : bad;
  return date(v);
}

/**
 * One phone number → E.164 with +91 as the default country (LLD §4.4). Accepts spaces, dashes, dots and brackets;
 * `0`/`91`/`0091` prefixes; Indian mobiles (10 digits, 6–9 first) and landlines with a leading 0; other countries
 * when written with `+` (8–15 digits). intake's own anonymised form `+9100000nnnnnn` passes through.
 */
export function phone(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/[a-z@]/i.test(v)) return null;
  const plus = v.startsWith('+');
  let d = v.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(d)) return null;
  if (plus) return d.length >= 8 && d.length <= 15 && !d.startsWith('0') ? `+${d}` : null;
  if (d.startsWith('00')) {
    d = d.slice(2);
    return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  }
  if (d.length === 10 && /^[6-9]/.test(d)) return `+91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `+91${d.slice(1)}`;
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return `+${d}`;
  return null;
}

/** Pipe / comma / slash separated phones: valid ones as E.164, invalid ones returned as written. */
export function phoneList(raw: string | null | undefined): { phones: string[]; invalid: string[] } {
  const phones: string[] = [];
  const invalid: string[] = [];
  if (isEmpty(raw)) return { phones, invalid };
  for (const part of raw.split(/[|,;/]/)) {
    const t = part.trim();
    if (!t || isPlaceholder(t)) continue;
    const p = phone(t);
    if (p) {
      if (!phones.includes(p)) phones.push(p);
    } else invalid.push(t);
  }
  return { phones, invalid };
}

const EMAIL = /^[^\s@|,;]+@[^\s@|,;]+\.[^\s@|,;]+$/;

export function emailList(raw: string | null | undefined): string[] {
  if (isEmpty(raw)) return [];
  const out: string[] = [];
  for (const part of raw.split(/[|,;\s]+/)) {
    const e = part.trim().toLowerCase();
    if (EMAIL.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

export function urlList(raw: string | null | undefined): string[] {
  if (isEmpty(raw)) return [];
  return raw
    .split(/[|,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/\S+$/i.test(s));
}
