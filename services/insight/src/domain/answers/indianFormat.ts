// Indian number formatting (LLD §4.4): 1,12,000 grouping, ₹ with lakh / crore for large amounts. Pure.

/** 1234567 → "12,34,567". */
export function groupIndian(n: number): string {
  const neg = n < 0;
  const [int = '0', frac] = Math.abs(n).toFixed(Number.isInteger(n) ? 0 : 2).split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}${grouped}${frac && Number(frac) ? `.${frac}` : ''}`;
}

const trim = (n: number) => String(Math.round(n * 100) / 100);

/** ₹ amount: ≥ 1 crore → "₹3.5 Cr"; otherwise full Indian grouping "₹1,12,000". */
export function formatInr(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹${trim(n / 1e7)} Cr`;
  return `₹${groupIndian(Math.round(n))}`;
}

export function formatCount(n: number, capped = false): string {
  return capped ? `${groupIndian(n)}+` : groupIndian(n);
}

export function formatSqft(n: number): string {
  return `${groupIndian(n)} sq ft`;
}
