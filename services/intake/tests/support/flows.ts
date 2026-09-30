// Upload flow helpers: create → PUT the file (in-memory Storage) → inspect → run the inspection worker.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { runInspection } from '../../src/application/inspection.js';
import { runSplit } from '../../src/application/split.js';
import { processChunk } from '../../src/application/chunk.js';
import { runFinalize } from '../../src/application/finalize.js';
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
  await h.app.files.put(`intake-uploads/${tenant}/${upload.id}/source`, bytes, 'application/octet-stream');
  return { id: upload.id, code: upload.code, headers };
}

/** Upload + inspect (+ mapping) + start + the split handler: the upload is `processing` with its chunk plan. */
export async function uploadAndSplit(
  h: Harness,
  tenant: string,
  bytes: Uint8Array,
  options: Parameters<typeof uploadFile>[3] & {
    mapping?: Record<string, unknown>;
    /**
     * Targets the domain accepts but the contract's Mapping.columnMap enum does not list yet (building_name, floor,
     * crm_notes; reported as a CR-012 contract gap): merged into the column map directly.
     */
    extraColumnMap?: Record<string, string>;
  } = {},
): Promise<Uploaded> {
  const u = await uploadFile(h, tenant, bytes, options);
  const inspected = await inspect(h, tenant, u);
  expect(inspected['status'], JSON.stringify([inspected['status'], inspected['failureReason']])).not.toBe(
    'failed',
  );
  if (options.mapping) {
    const m = await h.call('PUT', `/v1/uploads/${u.id}/mapping`, u.headers, options.mapping);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
  }
  if (options.extraColumnMap) {
    const current = await h.app.uow.repos.uploads.find(tenant, u.id);
    await h.app.uow.repos.uploads.update(tenant, u.id, {
      columnMap: { ...(current?.columnMap ?? {}), ...options.extraColumnMap },
    });
  }
  if (!(await h.app.uow.repos.vocabulary.active(tenant))) await seedVocabulary(h, tenant);
  const s = await h.call('POST', `/v1/uploads/${u.id}/start`, u.headers, { allowDuplicate: true });
  expect(s.status).toBe(202);
  await runSplit(h.app, { tenantId: tenant, uploadId: u.id, correlationId: 'test' });
  return u;
}

/** Runs the chunk handler for every chunk of the upload (in order, as one worker would). */
export async function processAll(h: Harness, tenant: string, uploadId: string): Promise<void> {
  const chunks = await h.db
    .selectFrom('upload_chunks')
    .select('chunk_no')
    .where('tenant_id', '=', tenant)
    .where('upload_id', '=', uploadId)
    .orderBy('chunk_no')
    .execute();
  for (const c of chunks) {
    await processChunk(h.app, { tenantId: tenant, uploadId, chunkNo: c.chunk_no, correlationId: 'test' });
  }
}

/** The whole pipeline: upload, inspect, (map), start, split, every chunk, finalize. */
export async function runUpload(
  h: Harness,
  tenant: string,
  bytes: Uint8Array,
  options: Parameters<typeof uploadAndSplit>[3] = {},
): Promise<Uploaded> {
  const u = await uploadAndSplit(h, tenant, bytes, options);
  await processAll(h, tenant, u.id);
  await runFinalize(h.app, { tenantId: tenant, uploadId: u.id, correlationId: 'test' });
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
