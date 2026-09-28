// Display formatting (conventions §4: money is integer INR, areas are sq ft, dates ISO 8601). Pure.

/** ₹ in Indian units: 1.25 Cr, 8.5 L, ₹45,000. */
export function inr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const trim = (n: number) => String(Number(n.toFixed(2)));
  if (Math.abs(value) >= 1e7) return `₹${trim(value / 1e7)} Cr`;
  if (Math.abs(value) >= 1e5) return `₹${trim(value / 1e5)} L`;
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

export function sqft(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value).toLocaleString('en-IN')} sq ft`;
}

export function count(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-IN');
}

const DAY = 86_400_000;

/** "12 Oct 2026" (or "12 Oct, 14:30" with time). */
export function date(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
    : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleString('en-IN', { ...opts, timeZone: 'Asia/Kolkata' });
}

/** "3 min ago", "yesterday", "in 2 days". */
export function relative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = t - now;
  const abs = Math.abs(diff);
  const past = diff < 0;
  const fmt = (n: number, unit: string) =>
    past ? `${n} ${unit}${n === 1 ? '' : 's'} ago` : `in ${n} ${unit}${n === 1 ? '' : 's'}`;
  if (abs < 60_000) return past ? 'just now' : 'in a moment';
  if (abs < 3_600_000) return fmt(Math.round(abs / 60_000), 'min');
  if (abs < DAY) return fmt(Math.round(abs / 3_600_000), 'hour');
  const days = Math.round(abs / DAY);
  if (days === 1) return past ? 'yesterday' : 'tomorrow';
  return fmt(days, 'day');
}

/** Greeting by the hour in India (prototype homeView). */
export function greeting(now: Date = new Date()): string {
  const h = Number(now.toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?';
}
