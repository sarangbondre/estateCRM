// Watchlist follow-up tasks (D-14, US-36 AC2; LLD §4.9).
import { addDays, daysBetween } from './dates.js';
import type { IsoDate } from './dates.js';

/** deadline − 7 days when the deadline is ≥ 7 days away, else today + 2 (JA-6). */
export function watchlistDueDate(deadline: IsoDate | null, today: IsoDate): IsoDate {
  if (deadline && daysBetween(today, deadline) >= 7) return addDays(deadline, -7);
  return addDays(today, 2);
}
