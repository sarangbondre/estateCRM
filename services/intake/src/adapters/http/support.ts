// HTTP support: IntakeError → RFC 7807 (intake LLD §6), actor extraction and cursor helpers.
import { requireStaff, tenantOf } from '@11e/auth';
import type { StaffRole } from '@11e/auth';
import { HttpError, decodeCursor } from '@11e/http';
import type { ServiceContext } from '@11e/http';
import { IntakeError } from '../../domain/errors.js';
import type { IntakeErrorCode } from '../../domain/errors.js';
import type { StaffActor, SystemActor } from '../../application/context.js';

const STATUS: Record<IntakeErrorCode, number> = {
  'not-found': 404,
  forbidden: 403,
  'validation-failed': 400,
  'version-mismatch': 412,
  'rate-limited': 429,
  'payload-too-large': 413,
  'unsupported-media-type': 415,
  'anonymise-required': 409,
  'upload-not-editable': 409,
  'file-missing': 409,
  'file-size-mismatch': 409,
  'mapping-not-allowed': 409,
  'mapping-invalid': 400,
  'sheet-not-found': 400,
  'upload-not-ready': 409,
  'duplicate-upload': 409,
  'upload-not-cancellable': 409,
  'rejected-file-not-ready': 409,
  // The contract declares 409 (not 503) for startUpload (see intake.yaml startUpload description).
  'vocabulary-unavailable': 409,
  'template-name-taken': 409,
  'review-item-closed': 409,
  'classification-invalid': 400,
  'batch-not-found': 404,
};

export function toHttpError(err: IntakeError): HttpError {
  return new HttpError(STATUS[err.code], err.code, {
    detail: err.message,
    ...(err.errors ? { errors: err.errors } : {}),
    ...(err.retryAfterSec ? { headers: { 'retry-after': String(err.retryAfterSec) } } : {}),
  });
}

/** Runs a handler body, translating domain errors. */
export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IntakeError) throw toHttpError(err);
    throw err;
  }
}

export function staffActor(c: ServiceContext, roles?: readonly StaffRole[]): StaffActor {
  const p = requireStaff(c, roles);
  return {
    kind: 'staff',
    tenantId: p.tenantId,
    userId: p.userId,
    role: p.role,
    correlationId: c.get('correlationId'),
  };
}

export function serviceActor(c: ServiceContext): SystemActor {
  return { kind: 'system', tenantId: tenantOf(c), correlationId: c.get('correlationId') };
}

/** Decodes a cursor and checks its fields' types (a tampered cursor is a 400). */
export function cursorOf<T extends Record<string, 'string' | 'number'>>(
  raw: string | undefined,
  shape: T,
): { [K in keyof T]: T[K] extends 'number' ? number : string } | undefined {
  const c = decodeCursor<Record<string, unknown>>(raw);
  if (!c) return undefined;
  for (const [k, t] of Object.entries(shape)) {
    if (typeof c[k] !== t)
      throw new HttpError(400, 'validation-failed', {
        errors: [{ field: 'cursor', code: 'invalid-cursor' }],
      });
  }
  return c as { [K in keyof T]: T[K] extends 'number' ? number : string };
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
