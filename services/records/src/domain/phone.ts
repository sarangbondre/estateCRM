// Phone numbers: E.164 normalisation (India default) and the masked display form (records LLD §4.14).

/**
 * Normalises to E.164. Accepts `+<cc><number>`, `00<cc>…`, 10-digit Indian mobiles (first digit 6–9),
 * `0` + 10 digits and `91` + 10 digits. Returns null when the input is not a phone number.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[^\d\s+().-]/.test(trimmed)) return null;
  const plus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!plus && digits.startsWith('00')) return e164(digits.slice(2));
  if (plus) return e164(digits);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return `+${digits}`;
  return null;
}

function e164(digits: string): string | null {
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** `+919812345421` → `+91 98•••••421` (country code, first two and last three digits). */
export function maskPhone(e164Phone: string): string {
  const digits = e164Phone.replace(/\D/g, '');
  const cc = digits.startsWith('91') && digits.length === 12 ? '91' : digits.slice(0, Math.max(1, digits.length - 10));
  const national = digits.slice(cc.length);
  if (national.length <= 5) return `+${cc} ${'•'.repeat(national.length)}`;
  return `+${cc} ${national.slice(0, 2)}${'•'.repeat(national.length - 5)}${national.slice(-3)}`;
}

/** Lower-cased, trimmed e-mail used for hashing. Null when it does not look like an address. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
