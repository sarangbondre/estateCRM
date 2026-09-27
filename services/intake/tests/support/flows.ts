// Upload flow helpers: create → PUT the file (in-memory Storage) → inspect → run the inspection worker.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { runInspection } from '../../src/application/inspection.js';
import { runSplit } from '../../src/application/split.js';
import type { Harness } from './harness.js';
import { XLSX_MIME } from './files.js';

export async function seedVocabulary(h: Harness, tenant: string, version = 'v0.6'): Promise<void> {
  await h.app.uow.repos.vocabulary.save(
    tenant,
    { version, checksum: `sha256-${version}`, content: { version } },
    [],
    true,
    randomUUID(),
  );
}

export interface Uploaded {
  id: string;
  code: string;
  headers: Record<string, string>;
}

/** Creates an upload and stores its bytes where the signed URL would have put them. */
export async function uploadFile(
  h: Harness,
  tenant: string,
  bytes: Uint8Array,
  options: {
    fileName?: string;
    contentType?: string;
    sourceType?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Uploaded> {
  const headers = options.headers ?? (await h.staff(tenant));
  const r = await h.call('POST', '/v1/uploads', headers, {
    fileName: options.fileName ?? 'master.xlsx',
    contentType: options.contentType ?? XLSX_MIME,
    sizeBytes: bytes.byteLength,
    sourceType: options.sourceType ?? 'Channel',
  });
  expect(r.status).toBe(201);
  const upload = r.body['upload'] as { id: string; code: string };
  await h.files.put(`intake-uploads/${tenant}/${upload.id}/source`, bytes);
  return { id: upload.id, code: upload.code, headers };
}

/** Upload + inspect (+ mapping) + start + the split handler: the upload is `processing` with its chunk plan. */
export async function uploadAndSplit(
  h: Harness,
  tenant: string,
  bytes: Uint8Array,
  options: Parameters<typeof uploadFile>[3] & { mapping?: Record<string, unknown> } = {},
): Promise<Uploaded> {
  const u = await uploadFile(h, tenant, bytes, options);
  await inspect(h, tenant, u);
  if (options.mapping) {
    const m = await h.call('PUT', `/v1/uploads/${u.id}/mapping`, u.headers, options.mapping);
    expect(m.status).toBe(200);
  }
  if (!(await h.app.uow.repos.vocabulary.active(tenant))) await seedVocabulary(h, tenant);
  const s = await h.call('POST', `/v1/uploads/${u.id}/start`, u.headers, { allowDuplicate: true });
  expect(s.status).toBe(202);
  await runSplit(h.app, { tenantId: tenant, uploadId: u.id, correlationId: 'test' });
  return u;
}

/** POST /inspect then the q_intake_inspect handler (called directly: tests never depend on shared queue state). */
export async function inspect(h: Harness, tenant: string, u: Uploaded) {
  const r = await h.call('POST', `/v1/uploads/${u.id}/inspect`, u.headers);
  expect(r.status).toBe(202);
  await runInspection(h.app, h.app.sheets, { tenantId: tenant, uploadId: u.id, correlationId: 'test' });
  const g = await h.call('GET', `/v1/uploads/${u.id}`, u.headers);
  return g.body;
}
