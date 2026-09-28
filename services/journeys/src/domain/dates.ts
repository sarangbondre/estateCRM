// Business dates are IST calendar dates (LLD §3: `date` columns are Asia/Kolkata). Pure arithmetic on YYYY-MM-DD.
export type IsoDate = string;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const toUtcMs = (d: IsoDate): number => {
  const m = DATE.exec(d);
  if (!m) throw new RangeError(`not a date: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const fromUtcMs = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

/** The IST calendar date of an instant. */
export function istDate(at: Date): IsoDate {
  return fromUtcMs(at.getTime() + IST_OFFSET_MS);
}

/** The instant at which an IST calendar day starts. */
export function istStartOfDay(d: IsoDate): Date {
  return new Date(toUtcMs(d) - IST_OFFSET_MS);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromUtcMs(toUtcMs(d) + n * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** Adds calendar months; the day is clamped to the target month's length (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const m = DATE.exec(d);
  if (!m) throw new RangeError(`not a date: ${d}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1 + n;
  const ty = y + Math.floor(mo / 12);
  const tm = ((mo % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromUtcMs(Date.UTC(ty, tm, Math.min(Number(m[3]), last)));
}

export function maxDate(a: IsoDate, b: IsoDate | null | undefined): IsoDate {
  return b && b > a ? b : a;
}

export function minDate(a: IsoDate | null, b: IsoDate | null): IsoDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * possessionDate may carry year or month precision ('YYYY', 'YYYY-MM', 'YYYY-MM-DD'); the normalised date is the
 * first day of the stated period, so the life curve starts earlier, never later (JA-8).
 */
export function normalisePeriodStart(raw: string | null | undefined): IsoDate | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}
