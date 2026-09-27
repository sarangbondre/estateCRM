// Export policy (LLD §4.9, US-32, R-16, R-21, C2): row caps, who may export contact columns, file naming and expiry.
// Pure.

/** Contact columns: Admin, Manager, Demand agent, Supply agent — not Data operators (C2 / A-I3: "No"). */
export const CONTACT_EXPORT_ROLES: readonly string[] = ['Admin', 'Manager', 'Demand agent', 'Supply agent'];
export const EXPORTS_PER_HOUR = 10;
export const EXPORT_PAGE_ROWS = 5_000;
export const CONTACT_BATCH = 1_000;
export const LINK_HOURS = 24;
export const SIGNED_URL_SECONDS = 600;
export const MAX_ATTEMPTS = 3;

export function mayExportContacts(role: string): boolean {
  return CONTACT_EXPORT_ROLES.includes(role);
}

/** Pilot 20,000 rows, production 100,000 (R-16; config EXPORT_MAX_ROWS). */
export function overCap(estimatedRows: number, maxRows: number): boolean {
  return estimatedRows > maxRows;
}

export function fileNameOf(requested: string | undefined, planId: string, code: string): string {
  const base = (requested?.trim() || `${planId.replace(/_/g, '-')}-${code}`).replace(/\.xlsx$/i, '');
  return `${base}.xlsx`;
}

/** Private bucket path: insight-exports/<tenant>/<code>.xlsx (the bucket name is the adapter's). */
export function filePathOf(tenantId: string, code: string): string {
  return `${tenantId}/${code}.xlsx`;
}

export function expiresAt(completedAt: Date): Date {
  return new Date(completedAt.getTime() + LINK_HOURS * 3_600_000);
}

export const CONTACT_COLUMNS = [
  { key: '_contact_names', label: 'Contact name', type: 'string' },
  { key: '_contact_phones', label: 'Phones', type: 'string' },
  { key: '_contact_emails', label: 'E-mails', type: 'string' },
] as const;
