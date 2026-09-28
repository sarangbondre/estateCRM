// Shared HTTP adapter helpers: application errors → RFC 7807, staff actor, opaque cursors, ETag.
import { HttpError } from '@11e/http';
import type { ServiceContext } from '@11e/http';
import { requireStaff } from '@11e/auth';
import type { StaffRole } from '@11e/auth';
import { AppError } from '../application/context.js';
import type { Actor } from '../application/publication.js';

/** Application errors → RFC 7807 (LLD §6). */
export async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError)
      throw new HttpError(err.status, err.code, {
        ...(err.detail ? { detail: err.detail } : {}),
        ...(err.errors ? { errors: err.errors } : {}),
      });
    throw err;
  }
}

export function staffActor(c: ServiceContext, roles?: readonly StaffRole[]): Actor {
  const p = requireStaff(c, roles);
  return { tenantId: p.tenantId, userId: p.userId, correlationId: c.get('correlationId') };
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const encode = (v: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
export function decode(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw invalidCursor();
}
export const invalidCursor = () =>
  new HttpError(400, 'invalid-cursor', { errors: [{ field: 'cursor', code: 'invalid-cursor' }] });

export function keysetCursor(cursor: string | undefined): { t: string; id: string } | undefined {
  const v = decode(cursor);
  if (!v) return undefined;
  if (typeof v['t'] !== 'string' || typeof v['id'] !== 'string' || Number.isNaN(Date.parse(v['t'])))
    throw invalidCursor();
  return { t: v['t'], id: v['id'] };
}

/**
 * The staff state endpoints take one idempotent write path (PUT) and return an ETag of the row version.
 */
export function withEtag(c: ServiceContext, version: number) {
  c.header('etag', `"${version}"`);
}

// ---- routes --------------------------------------------------------------------------------------------------------

export const ALL_STAFF: readonly StaffRole[] = [
  'Admin',
  'Manager',
  'Demand agent',
  'Supply agent',
  'Data operator',
];
