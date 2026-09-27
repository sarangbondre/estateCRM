// web's notifications (FR-NTF-1, R-6, web LLD §4.7): upload, export and user notifications. Titles carry codes and
// counts only (no PII); free-text failure reasons are replaced by fixed messages. Pure.
import type { RoleCode } from './roles';

const n = (v: number) => v.toLocaleString('en-IN');

/** Known failure reason codes → fixed messages. Anything else becomes a generic message (reasons may be free text). */
const UPLOAD_REASONS: Record<string, string> = {
  'file-unreadable': 'the file could not be read',
  'unsupported-format': 'the file format is not supported',
  'header-mismatch': 'the columns do not match the template',
  'too-many-rows': 'the file has too many rows',
  'too-many-errors': 'too many rows had errors',
  cancelled: 'it was cancelled',
  timeout: 'processing took too long',
  'storage-error': 'the file could not be stored',
  internal: 'of an internal error',
};
const EXPORT_REASONS: Record<string, string> = {
  'too-many-rows': 'too many rows',
  'query-failed': 'the query failed',
  timeout: 'it took too long',
  'storage-error': 'storage error',
  cancelled: 'cancelled',
  internal: 'internal error',
};

export function uploadCompletedTitle(code: string, c: { accepted: number; rejected: number; needsReview: number }): string {
  return `${code} processed: ${n(c.accepted)} accepted, ${n(c.rejected)} rejected, ${n(c.needsReview)} to review`;
}

export function uploadFailedTitle(code: string, reason: string): string {
  return `${code} failed: ${UPLOAD_REASONS[reason] ? `because ${UPLOAD_REASONS[reason]}` : 'processing did not complete'}`;
}

export function exportReadyTitle(code: string, rowCount: number): string {
  return `${code} is ready (${n(rowCount)} rows). Link valid 24 h`;
}

export function exportFailedTitle(code: string, reason: string): string {
  return `${code} failed (${EXPORT_REASONS[reason] ?? 'export did not complete'})`;
}

export const roleChangedTitle = (role: RoleCode) => `Your role is now ${role}`;
export const REACTIVATED_TITLE = 'Your account was reactivated';

export const uploadLink = (code: string) => `/uploads/${encodeURIComponent(code)}`;
export const exportLink = (code: string) => `/exports/${encodeURIComponent(code)}`;
export const PROFILE_LINK = '/settings/profile';

export const NOTIFICATION_RETENTION_DAYS = 90;
export const UNREAD_CAP = 99;
