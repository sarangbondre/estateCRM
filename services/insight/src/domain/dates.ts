// IST business dates and periods (LLD §4.3 rule 7: period presets are resolved in IST). Pure functions.

const IST_OFFSET_MS = 330 * 60_000;
const DAY = 86_400_000;

/** 'YYYY-MM-DD' of the IST day that contains `at`. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant 00:00 IST of an IST day. */
export function istMidnight(day: string): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
}

export function addDays(day: string, n: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * DAY).toISOString().slice(0, 10);
}

export type PeriodPreset =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'this_quarter'
  | 'last_month'
  | 'last_30_days'
  | 'next_60_days'
  | 'custom';

/** Inclusive IST day range. */
export interface DayRange {
  from: string;
  to: string;
}

/**
 * Resolves a preset in IST. Weeks start on Monday. `next_60_days` is today … today + 60.
 * `custom` needs `from` (and optionally `to`, default today).
 */
export function resolvePeriod(
  preset: PeriodPreset,
  now: Date,
  custom: { from?: string | undefined; to?: string | undefined } = {},
): DayRange | null {
  const today = istDay(now);
  const [y, m] = today.split('-').map(Number) as [number, number];
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'this_week': {
      const dow = (new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7; // Monday = 0
      return { from: addDays(today, -dow), to: today };
    }
    case 'this_month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'this_quarter': {
      const qm = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: `${y}-${String(qm).padStart(2, '0')}-01`, to: today };
    }
    case 'last_month': {
      const first = new Date(Date.UTC(y, m - 2, 1));
      const last = new Date(Date.UTC(y, m - 1, 0));
      return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
    }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'next_60_days':
      return { from: today, to: addDays(today, 60) };
    case 'custom':
      if (!custom.from) return null;
      return { from: custom.from, to: custom.to ?? today };
  }
}

/**
 * First day of a stated possession/availability period: 'YYYY' → Jan 1, 'YYYY-MM' → the 1st, 'YYYY-MM-DD' as is.
 * Anything else (free text) → null.
 */
export function periodStart(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = /^(\d{4})$/.exec(s);
  if (m) return `${m[1]}-01-01`;
  return null;
}

export function daysBetween(fromIso: string, to: Date): number {
  return Math.floor((to.getTime() - new Date(fromIso).getTime()) / DAY);
}
