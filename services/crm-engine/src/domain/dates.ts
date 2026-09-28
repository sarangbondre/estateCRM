// Calendar-date helpers on 'YYYY-MM-DD' strings (pure; no time zones except the IST business day).
import type { IsoDate } from './types.js';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
const YEAR = /^(\d{4})$/;
const IST_OFFSET_MS = 330 * 60_000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function toUtcMs(d: IsoDate): number {
  const m = DATE.exec(d);
  if (!m) throw new RangeError(`not a date: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isIsoDate(v: unknown): v is IsoDate {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  return fromUtcMs(toUtcMs(v)) === v;
}

/** The IST calendar day of an instant (business dates are Mumbai dates). */
export function istDate(at: Date): IsoDate {
  return fromUtcMs(at.getTime() + IST_OFFSET_MS);
}

export function addDays(d: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(d) + days * 86_400_000);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / 86_400_000);
}

export const minDate = (a: IsoDate, b: IsoDate): IsoDate => (a <= b ? a : b);
export const maxDate = (a: IsoDate, b: IsoDate): IsoDate => (a >= b ? a : b);

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Availability period of an offer (LLD §3.2): 'YYYY-MM-DD' → that day; 'YYYY-MM' → first..last day of the month;
 * 'YYYY' → Jan 1..Dec 31. Ready or no date → null (available now). Month precision never excludes wrongly because
 * filter 9 compares the period start.
 */
export function availabilityPeriod(
  possessionDateRaw: string | null | undefined,
  possessionStatus?: string | null,
): { from: IsoDate; to: IsoDate } | null {
  if (possessionStatus === 'Ready') return null;
  const raw = possessionDateRaw?.trim();
  if (!raw) return null;
  let m = DATE.exec(raw);
  if (m && isIsoDate(raw)) return { from: raw, to: raw };
  m = MONTH.exec(raw);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return { from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(lastDayOfMonth(y, mo))}` };
  }
  m = YEAR.exec(raw);
  if (m) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
  return null;
}
