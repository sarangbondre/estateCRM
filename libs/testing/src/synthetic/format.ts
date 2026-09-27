/** Text formatting helpers for ad text (Indian number grouping, INR amounts, dates). */

/** Indian digit grouping: 12,34,567. */
export function groupIndian(value: number): string {
  const [whole = '0', fraction] = String(Math.round(value * 100) / 100).split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  let grouped = digits;
  if (digits.length > 3) {
    const head = digits.slice(0, -3);
    const tail = digits.slice(-3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  }
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

function trimNumber(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/\.?0+$/, '');
}

/** "3.25 Cr", "85 L", "45,000". */
export function inrShort(amount: number): string {
  if (amount >= 1e7) return `${trimNumber(amount / 1e7, 2)} Cr`;
  if (amount >= 1e5) return `${trimNumber(amount / 1e5, 2)} L`;
  return groupIndian(amount);
}

/** Rounds to amounts people write in ads. */
export function roundPrice(amount: number): number {
  const step = amount >= 1e7 ? 5e5 : amount >= 1e6 ? 1e5 : amount >= 1e5 ? 5e3 : 1e3;
  return Math.max(step, Math.round(amount / step) * step);
}

export function roundArea(area: number): number {
  const step = area >= 10000 ? 500 : area >= 2000 ? 50 : 10;
  return Math.max(step, Math.round(area / step) * step);
}

const DAY_MS = 86_400_000;

export function parseIsoDate(value: string): number {
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) throw new RangeError(`not an ISO date: ${value}`);
  return time;
}

export function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return isoDate(parseIsoDate(iso) + days * DAY_MS);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseIsoDate(toIso) - parseIsoDate(fromIso)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: string): number {
  return new Date(parseIsoDate(iso)).getUTCDay();
}
